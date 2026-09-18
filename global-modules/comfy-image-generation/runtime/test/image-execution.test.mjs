import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { buildImageOperation, ensurePreparedImageRequest, executeImageOperation, prepareImageOperation } from "../image-execution.mjs";
import { transitionRender } from "../render-state.mjs";

const profile = { id: "profile-a", revision: "1", digest: "profile-digest", guideId: "guide-a", connectionId: "local", connectionBaseUrl: "http://127.0.0.1:8188", workflowDigest: "workflow-digest", output: { nodeIds: ["output"] } };
const services = { comfy: { assemblePrompt: (_profile, content) => ({ positive: `positive:${content}`, negative: "negative" }) } };

test("the seed contract is reachable from an installed card as well as from the source tree", async t => {
  // The module copy inside a card lives at `<play>/cards/<card>/features/<module>/runtime/`, with the
  // runtime library at `<play>/.pi/lib`. A hardcoded relative depth missed exactly that layout, so
  // every in-card generation failed with a 500 ("The ComfyUI seed contract ... is not reachable")
  // before it reached ComfyUI. This builds the installed layout and imports the module copy from it.
  const root = await mkdtemp(resolve(tmpdir(), "rp-image-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = resolve(root, "cards", "card", "features", "comfy-image-generation");
  await mkdir(resolve(moduleDirectory, "runtime"), { recursive: true });
  for (const [from, to] of [
    [new URL("../image-execution.mjs", import.meta.url), resolve(moduleDirectory, "runtime", "image-execution.mjs")],
    [new URL("../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui-seed.mjs", import.meta.url), resolve(root, ".pi", "lib", "rp-comfyui-seed.mjs")],
  ]) {
    await mkdir(resolve(to, ".."), { recursive: true });
    await writeFile(to, await readFile(from, "utf8"), "utf8");
  }
  const installed = await import(pathToFileURL(resolve(moduleDirectory, "runtime", "image-execution.mjs")).href);
  assert.equal(typeof installed.prepareImageOperation, "function");
  // Importing the installed copy already proves the resolution: the seed contract is loaded at module
  // scope and a missed layout throws before any export exists. Deriving a seed twice through the same
  // installed copy shows the resolved contract is the one the determinism guarantee runs on.
  const input = { ordinal: 1, source: { sourceKind: "custom-brief", triggerKind: "manual", referenceContext: "", imageTarget: "scene", userDirection: "" }, profiles: [{ ...profile, seedRange: { min: 0, max: 1125899906842624 } }], contentPrompts: [{ guideId: "guide-a", content: "scene" }], chatFolder: "chat", services };
  const first = installed.buildImageOperation({ ...input, operationId: "installed-layout" });
  const replay = installed.buildImageOperation({ ...input, operationId: "installed-layout" });
  assert.equal(first.renders.length, 1);
  // The regression is the import itself: the contract is loaded at module scope, so the old hardcoded
  // depth threw for this layout before any export existed. Building an operation through the installed
  // copy then shows the resolved contract is the one the module actually runs on.
  assert.equal(first.renders[0].id, replay.renders[0].id);
  assert.equal(first.renders[0].data.profileEffectiveDigest, replay.renders[0].data.profileEffectiveDigest);
});
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

test("the completion write the execution path builds is a legal render transition", async () => {
  // RC-16: the completion patch carried `warnings`, the transition allow-list did not, so the batch
  // was rejected ("Render transition patch contains an unsupported field") and every *successful*
  // render stayed `submitted` with no outputs — the image ComfyUI had produced was never attached.
  // The transition is exercised here through the module's own processor and the module's own schema,
  // so an allow-list or schema that drifts from the execution path fails this test.
  const schema = JSON.parse(await readFile(new URL("../../schemas/image-render.schema.json", import.meta.url), "utf8"));
  const current = { id: "image-render-a-1", revision: 3, data: { state: "submitted", outputs: [], promptId: "prompt-a" } };
  const completionPatch = { outputs: [{ filename: "one.png", subfolder: "", type: "output" }], completedAt: "2026-09-13T00:01:00.000Z", error: null, errorKind: null, lastCheckedAt: "2026-09-13T00:01:00.000Z", warnings: [{ nodeId: "702", message: "unrelated node error" }] };
  const transitioned = transitionRender({ current, operation: { params: { state: "completed", patch: completionPatch } } });
  assert.equal(transitioned.record.data.state, "completed");
  assert.deepEqual(transitioned.record.data.outputs, completionPatch.outputs);
  assert.deepEqual(transitioned.record.data.warnings, completionPatch.warnings);
  const unknown = Object.keys(completionPatch).filter(key => !(key in schema.properties));
  assert.deepEqual(unknown, [], "every field the completion path writes must be declared by the render schema");
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
