import assert from "node:assert/strict";
import test from "node:test";

import { buildImageOperation, ensurePreparedImageRequest, executeImageOperation, prepareImageOperation } from "../image-execution.mjs";

const profile = { id: "profile-a", revision: "1", digest: "profile-digest", guideId: "guide-a", connectionId: "local", connectionBaseUrl: "http://127.0.0.1:8188", workflowDigest: "workflow-digest", output: { nodeIds: ["output"] } };
const services = { comfy: { assemblePrompt: (_profile, content) => ({ positive: `positive:${content}`, negative: "negative" }) } };

test("operation identity, rather than prompt content, determines request identity", () => {
  const input = { ordinal: 1, source: { sourceKind: "custom-brief", triggerKind: "manual", referenceContext: "", imageTarget: "same scene", userDirection: "" }, profiles: [profile], contentPrompts: [{ guideId: "guide-a", content: "scene" }], chatFolder: "chat", services };
  const first = buildImageOperation({ ...input, operationId: "operation-a" });
  const replay = buildImageOperation({ ...input, operationId: "operation-a" });
  const regeneratedPrompt = buildImageOperation({ ...input, operationId: "operation-a", contentPrompts: [{ guideId: "guide-a", content: "different agent output" }] });
  const editedPrompt = buildImageOperation({ ...input, operationId: "operation-a", intent: { operationId: "operation-a", profileIds: ["profile-a"], inputPolicy: { kind: "custom-brief" }, customBrief: "same scene", editedContentPrompts: [{ guideId: "guide-a", content: "user-edited output" }] } });
  const deliberateRepeat = buildImageOperation({ ...input, operationId: "operation-b" });
  assert.equal(first.requestId, replay.requestId);
  assert.deepEqual(first.renders.map(item => item.id), replay.renders.map(item => item.id));
  assert.equal(first.requestData.invocationFingerprint, regeneratedPrompt.requestData.invocationFingerprint);
  assert.notEqual(first.requestData.invocationFingerprint, editedPrompt.requestData.invocationFingerprint);
  assert.notEqual(first.requestId, deliberateRepeat.requestId);
});

test("the operation is persisted before prompting and a ready replay skips prompting", async () => {
  let record = null;
  const data = {
    async get() { return record ? structuredClone(record) : null; },
    async submit(draft) {
      const item = draft.operations[0];
      record = { id: item.targetId, revision: 1, value: { "请求": structuredClone(item.data) } };
      return { status: "committed" };
    },
  };
  const input = { operationId: "operation-prepare", ordinal: 4, source: { sourceKind: "custom-brief", triggerKind: "manual", referenceContext: "", imageTarget: "tower", userDirection: "" }, profiles: [profile], chatFolder: "chat" };
  const definition = prepareImageOperation(input);
  const first = await ensurePreparedImageRequest({ data, definition });
  assert.equal(first.created, true);
  assert.equal(first.route, "prompt");
  assert.equal(record.value["请求"].promptState, "preparing");
  record.value["请求"] = { ...record.value["请求"], promptState: "ready", contentPrompts: [{ guideId: "guide-a", content: "tower" }] };
  const replay = await ensurePreparedImageRequest({ data, definition });
  assert.equal(replay.route, "reuse");
  const changed = prepareImageOperation({ ...input, source: { ...input.source, imageTarget: "different" } });
  await assert.rejects(ensurePreparedImageRequest({ data, definition: changed }), error => error.code === "image_operation_conflict");
});

test("a completion-write failure resumes the submitted prompt without regenerating", async () => {
  const definition = buildImageOperation({ operationId: "operation-resume", ordinal: 2, source: { sourceKind: "custom-brief", triggerKind: "manual", referenceContext: "", imageTarget: "harbor", userDirection: "night" }, profiles: [profile], contentPrompts: [{ guideId: "guide-a", content: "night harbor" }], chatFolder: "chat", services });
  const original = definition.renders[0];
  const request = { id: definition.requestId, revision: 1, value: { "请求": structuredClone(definition.requestData) } };
  let record = { id: original.id, revision: 1, value: { "生成记录": structuredClone(original.data) } };
  let completionWrites = 0;
  const data = {
    async get(query) { return structuredClone(query.collectionId === "requests" ? request : record); },
    async submit(draft) {
      const item = draft.operations[0];
      assert.equal(item.expectedRevision, record.revision);
      if (item.params.state === "completed" && completionWrites++ === 0) throw new Error("local completion write interrupted");
      record = { ...record, revision: record.revision + 1, value: { "生成记录": { ...record.value["生成记录"], ...item.params.patch, state: item.params.state } } };
      return { status: "committed" };
    },
  };
  let generated = 0;
  let resumed = 0;
  const comfy = {
    async profiles() { return [profile]; },
    async generate({ onSubmitted, promptId }) {
      generated += 1;
      await onSubmitted({ promptId, submittedAt: "2026-09-13T00:00:00.000Z" });
      return { promptId, outputs: [{ filename: "one.png" }], completedAt: "2026-09-13T00:01:00.000Z" };
    },
    async resumeRender({ promptId, connectionId, connectionBaseUrl, outputNodeIds }) {
      resumed += 1;
      assert.equal(connectionId, "local");
      assert.equal(connectionBaseUrl, "http://127.0.0.1:8188");
      assert.deepEqual(outputNodeIds, ["output"]);
      return { promptId, outputs: [{ filename: "one.png" }], completedAt: "2026-09-13T00:01:00.000Z" };
    },
  };
  const first = await executeImageOperation({ data, services: { comfy }, requestId: definition.requestId, renders: [original] });
  assert.equal(first.outcomes[0].state, "submitted");
  assert.equal(first.executionStatus, "recovery-required");
  assert.equal(record.revision, 4);
  const second = await executeImageOperation({ data, services: { comfy }, requestId: definition.requestId, renders: [original] });
  assert.equal(second.outcomes[0].state, "completed");
  assert.equal(second.executionStatus, "completed");
  assert.equal(record.revision, 5);
  assert.equal(generated, 1);
  assert.equal(resumed, 1);
});

test("a lost queue response reuses the pre-persisted prompt ID without a second POST", async () => {
  const definition = buildImageOperation({ operationId: "operation-response-lost", ordinal: 3, source: { sourceKind: "custom-brief", triggerKind: "manual", referenceContext: "", imageTarget: "harbor", userDirection: "" }, profiles: [profile], contentPrompts: [{ guideId: "guide-a", content: "harbor" }], chatFolder: "chat", services });
  const original = definition.renders[0];
  const request = { id: definition.requestId, revision: 1, value: { "请求": structuredClone(definition.requestData) } };
  let record = { id: original.id, revision: 1, value: { "生成记录": structuredClone(original.data) } };
  const data = {
    async get(query) { return structuredClone(query.collectionId === "requests" ? request : record); },
    async submit(draft) {
      const item = draft.operations[0];
      assert.equal(item.expectedRevision, record.revision);
      record = { ...record, revision: record.revision + 1, value: { "生成记录": { ...record.value["生成记录"], ...item.params.patch, state: item.params.state } } };
      return { status: "committed" };
    },
  };
  let posts = 0;
  let recoveredPromptId = null;
  const comfy = {
    async profiles() { return [profile]; },
    async generate({ promptId }) {
      posts += 1;
      recoveredPromptId = promptId;
      throw new Error("connection closed after queue acceptance");
    },
    async resumeRender({ promptId }) {
      assert.equal(promptId, recoveredPromptId);
      return { promptId, outputs: [{ filename: "recovered.png" }], completedAt: "2026-09-13T00:02:00.000Z" };
    },
  };
  const first = await executeImageOperation({ data, services: { comfy }, requestId: definition.requestId, renders: [original] });
  assert.equal(first.outcomes[0].state, "submitting");
  assert.equal(first.executionStatus, "recovery-required");
  assert.equal(record.value["生成记录"].promptId, recoveredPromptId);
  const second = await executeImageOperation({ data, services: { comfy }, requestId: definition.requestId, renders: [original] });
  assert.equal(second.outcomes[0].state, "completed");
  assert.equal(posts, 1);
});
