import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { normalizeDataContract } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { executeDataBatchOrThrow } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs";
import { queryData, getDataRecord } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs";
import { createExecutionService, executionDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-executions.mjs";
import { ACCESS, MODULE_ID } from "../web-api.mjs";
import { buildImageOperation, ensureImageOperation, executeImageOperation } from "../image-execution.mjs";
import { execute } from "../workflow/render-operation.mjs";

test("managed image regeneration creates a fresh job, recovery keeps it, and inactive results stay private", async t => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-managed-image-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const moduleDirectory = fileURLToPath(new URL("../../", import.meta.url));
  const contract = normalizeDataContract(JSON.parse(await readFile(resolve(moduleDirectory, "data-contract.json"), "utf8")), MODULE_ID);
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  const manager = createExecutionService(store);
  await manager.beginTurn(1);
  const dataFor = scoped => ({
    query: request => queryData(scoped, request, { capabilities: ACCESS.requests.find(access => access.collectionId === request.collectionId).capabilities, views: ["maintenance"], runtimeLimit: 1000, runtimeCharacters: 1000000 }),
    get: request => getDataRecord(scoped, request, { capabilities: ACCESS.requests.find(access => access.collectionId === request.collectionId).capabilities, views: ["maintenance"] }),
    submit: draft => executeDataBatchOrThrow(scoped, draft, { access: ACCESS.requests, context: { binding: { turn: 1, messageId: null } } }),
  });
  const profile = { id: "test-profile", revision: "1", digest: "profile-digest", guideId: "test-guide", connectionId: "local", connectionBaseUrl: "http://127.0.0.1:8188", workflowDigest: "workflow-digest", output: { nodeIds: ["output"] } };
  let posts = 0, resumes = 0, uncertain = false;
  const promptIds = [];
  const comfy = {
    profiles: async () => [profile],
    assemblePrompt: (_profile, content) => ({ positive: content, negative: "" }),
    generate: async ({ promptId, onSubmitted }) => { posts++; promptIds.push(promptId); if (uncertain) throw new Error("queue response lost"); await onSubmitted({ promptId, submittedAt: new Date().toISOString() }); return { promptId, outputs: [{ filename: "synthetic.png", subfolder: "", type: "output" }], completedAt: new Date().toISOString() }; },
    resumeRender: async ({ promptId }) => { resumes++; assert.equal(promptId, promptIds.at(-1)); return { promptId, outputs: [{ filename: "recovered.png", subfolder: "", type: "output" }], completedAt: new Date().toISOString() }; },
  };
  await manager.start({ id: "story-a", workflowId: "story", turn: 1, attemptId: "story-a" });
  const definition = buildImageOperation({ operationId: "original-image", ordinal: 1, source: { sourceKind: "custom-brief", triggerKind: "manual", imageTarget: "scene", referenceContext: "", userDirection: "" }, profiles: [profile], contentPrompts: [{ guideId: "test-guide", content: "scene" }], chatFolder: "test", services: { comfy } });
  const originalData = dataFor(executionDataStore(store, "story-a"));
  await ensureImageOperation({ data: originalData, definition });
  assert.equal((await executeImageOperation({ data: originalData, services: { comfy }, requestId: definition.requestId, renders: definition.renders })).executionStatus, "completed");
  await manager.finish("story-a", "completed"); await manager.adopt("story-a");
  await manager.start({ id: "image-new", workflowId: "image-render-regeneration", turn: 1, parentId: "story-a" });
  const run = { id: "image-new", newExecutionRootId: "image-new", payload: { renderId: definition.renders[0].id, contentPrompt: "new scene", scope: "current", operationId: "original-image" } };
  const data = dataFor(executionDataStore(store, run.id));
  uncertain = true;
  assert.equal((await execute({ run, node: { metadata: { action: "regenerate" } }, data, services: { comfy } })).executionStatus, "recovery-required");
  assert.equal(posts, 2); assert.notEqual(promptIds[0], promptIds[1]);
  assert.equal((await store.readCollection(MODULE_ID, "requests")).records.length, 1);
  const { createImageWebBridge } = await import("../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-image-web-bridge.ts");
  const privateRequest = (await executionDataStore(store, run.id).readCollection(MODULE_ID, "requests")).records.find(record => record.id !== definition.requestId);
  let recoveredRun = null;
  const active = { sessionDirectory, featureModules: [{ id: MODULE_ID, moduleDirectory, contract }], turn: 1, recordId: "test", cardId: "test", pending: false, comfyUi: { ...comfy, listConnections: async () => [] }, workflowEngine: {
    snapshot: () => [{ id: "root-image", executionId: run.id, narrativeAttemptId: "story-a", status: "awaiting-recovery", payload: {} }, { id: "child-image", executionId: run.id, narrativeAttemptId: "story-a", status: "awaiting-recovery", payload: {}, callContext: { parentRunId: "root-image" }, nodes: { input: { output: { requestId: privateRequest.id } } } }],
    recover: async id => { recoveredRun = id; return { id }; },
  } };
  let executionId = null;
  const bridge = createImageWebBridge({ getSession: () => active, getExecutionId: () => executionId, ensureFeatureModuleRecords: async () => {}, configStore: {}, httpError: (status, message) => Object.assign(new Error(message), { status }), openLocalDocument: async () => {}, imageExecutionGuard: {} });
  assert.equal((await bridge.getImageGeneration()).renders.length, 2, "Pending results are diagnostics of the selected attempt");
  await bridge.recoverImageGeneration(privateRequest.id);
  assert.equal(recoveredRun, "root-image", "Recovery follows the original parent chain");
  uncertain = false;
  assert.equal((await execute({ run, node: { metadata: { action: "regenerate" } }, data, services: { comfy } })).executionStatus, "completed");
  assert.equal(posts, 2); assert.equal(resumes, 1);
  await manager.start({ id: "story-b", workflowId: "story", turn: 1, previousId: "story-a", attemptId: "story-b", invocation: { logicalCallId: "story-a" }, candidate: true });
  await manager.finish("story-b", "completed"); await manager.adopt("story-b");
  await manager.finish(run.id, "completed"); await manager.adopt(run.id);
  assert.equal((await store.readCollection(MODULE_ID, "renders")).records.length, 0, "Newly selected prose does not borrow the old attempt's images");
  assert.equal((await executionDataStore(store, "story-a").readCollection(MODULE_ID, "renders")).records.length, 2);
  assert.equal((await bridge.getImageGeneration()).renders.length, 0);
  executionId = "story-a";
  assert.equal((await bridge.getImageGeneration()).renders.length, 2, "Image display follows the previewed narrative attempt");
  await assert.rejects(bridge.startImageGeneration({}), { status: 409 });
});
