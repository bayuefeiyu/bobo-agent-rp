import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createComfyUiService } from "./rp-comfyui.mjs";
import { RpDataStore } from "./rp-data-store.mjs";
import { executeDataBatch } from "./rp-data-changes.mjs";

test("assembles fixed prompt around scene content and creates one flat chat folder", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rp-comfy-"));
  const moduleDirectory = resolve(root, "card", "features", "comfy-image-generation");
  const profileDirectory = resolve(moduleDirectory, "profiles", "demo");
  await mkdir(profileDirectory, { recursive: true });
  await mkdir(resolve(moduleDirectory, "skill", "guides", "demo"), { recursive: true });
  const workflow = { "1": { class_type: "CLIPTextEncode", inputs: { text: "" } }, "2": { class_type: "SaveImage", inputs: { filename_prefix: "" } } };
  await writeFile(resolve(profileDirectory, "workflow.api.json"), JSON.stringify(workflow));
  await writeFile(resolve(profileDirectory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "text" }], negative: [], seed: [], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "quality", positiveSuffix: "style", negative: "bad" }, output: { nodeIds: ["2"] } }));
  await writeFile(resolve(moduleDirectory, "skill", "guides", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  const service = createComfyUiService({ rootDirectory: root, cardDirectory: resolve(root, "card"), featureModules: [{ id: "comfy-image-generation", moduleDirectory }] });
  const profile = (await service.profiles())[0];
  assert.deepEqual(service.assemblePrompt(profile, "a person"), { positive: "quality, a person, style", negative: "bad" });
  const folder = service.chatFolder({ cardId: "card/name", chatId: "chat-1", now: new Date("2026-09-03T14:35:22Z") });
  assert.match(folder, /^20260903-143522_card-name_[a-f0-9]{6}$/);
  assert.equal(folder.includes("/"), false);
});

test("queues an adapted workflow and returns only ComfyUI history image references", async () => {
  let queued;
  const server = createServer(async (request, response) => {
    if (request.url === "/prompt") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      queued = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ prompt_id: queued.prompt_id })); return;
    }
    if (request.url.startsWith("/history/")) {
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ [queued.prompt_id]: { status: { status_str: "success" }, outputs: { "2": { images: [{ filename: "result_00001_.png", subfolder: "bobo-agent-rp/chat", type: "output" }] } } } })); return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const root = await mkdtemp(resolve(tmpdir(), "rp-comfy-http-"));
  const moduleDirectory = resolve(root, "card", "features", "comfy-image-generation");
  const profileDirectory = resolve(moduleDirectory, "profiles", "demo");
  await mkdir(profileDirectory, { recursive: true }); await mkdir(resolve(moduleDirectory, "skill", "guides", "demo"), { recursive: true });
  const workflow = { "1": { class_type: "CLIPTextEncode", inputs: { text: "" } }, "2": { class_type: "SaveImage", inputs: { filename_prefix: "" } } };
  await writeFile(resolve(profileDirectory, "workflow.api.json"), JSON.stringify(workflow));
  await writeFile(resolve(profileDirectory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "text" }], negative: [], seed: [], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "quality", positiveSuffix: "", negative: "" }, output: { nodeIds: ["2"] } }));
  await writeFile(resolve(moduleDirectory, "skill", "guides", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  const service = createComfyUiService({ rootDirectory: root, cardDirectory: resolve(root, "card"), featureModules: [{ id: "comfy-image-generation", moduleDirectory }], secretCacheDirectory: resolve(root, "secrets") });
  const address = server.address(); await service.saveConnection({ id: "local", title: "Test", baseUrl: `http://127.0.0.1:${address.port}` });
  const result = await service.generate({ profileId: "demo", contentPrompt: "a scene", chatFolder: "chat", filenamePrefix: "0001-r01-demo-final", promptId: "00000000-0000-4000-a000-000000000001", timeoutMs: 5000 });
  assert.equal(queued.prompt_id, "00000000-0000-4000-a000-000000000001");
  assert.equal(queued.prompt["1"].inputs.text, "quality, a scene");
  assert.equal(queued.prompt["2"].inputs.filename_prefix, "bobo-agent-rp/chat/0001-r01-demo-final");
  assert.equal(result.outputs[0].filename, "result_00001_.png");
  const originalBaseUrl = `http://127.0.0.1:${address.port}`;
  await service.saveConnection({ id: "local", title: "Moved", baseUrl: "http://127.0.0.1:9" });
  const resumed = await service.resumeRender({ connectionId: "local", connectionBaseUrl: originalBaseUrl, promptId: result.promptId, outputNodeIds: ["2"], timeoutMs: 5000 });
  assert.equal(resumed.outputs[0].filename, "result_00001_.png");
  server.close(); await once(server, "close");
});

test("image records survive message pruning and enforce guarded render transitions", async () => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-comfy-data-"));
  const moduleDirectory = resolve(process.cwd(), "global-modules", "comfy-image-generation");
  const contract = JSON.parse(await readFile(resolve(moduleDirectory, "data-contract.json"), "utf8"));
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory }] });
  await store.initialize();
  const render = { requestId: "image-request-test", ordinal: 1, renderOrdinal: 1, profileId: "demo", profileRevision: "1", profileDigest: "digest", profileEffectiveDigest: "effective", profileSnapshotId: "snapshot", guideId: "demo", connectionId: "local", connectionBaseUrl: "http://127.0.0.1:8188", contentPrompt: "scene", positivePrompt: "quality, scene", negativePrompt: "bad", workflowDigest: "workflow", outputNodeIds: ["2"], seed: null, filenamePrefix: null, payloadDigest: null, attemptNumber: 0, attemptId: null, promptId: null, state: "pending", chatFolder: "20260903-143522_card_abcdef", outputs: [], error: null, errorKind: null, lastCheckedAt: null, submittedAt: null, completedAt: null };
  const access = [{ moduleId: "comfy-image-generation", collectionId: "renders", capabilities: ["image.renders.execute"], views: ["maintenance"] }];
  await executeDataBatch(store, { protocolVersion: 1, batchId: "create-render-test", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "create-render", moduleId: "comfy-image-generation", collectionId: "renders", recordType: "image.render", action: "create", targetId: "image-render-test", data: render }] }, { access, context: { binding: { turn: 2, messageId: null } } });
  await store.pruneByMessageIds(["message-2"]);
  assert.equal((await store.readCollection("comfy-image-generation", "renders")).records.length, 1);
  await executeDataBatch(store, { protocolVersion: 1, batchId: "submitting-render-test", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "submitting-render", moduleId: "comfy-image-generation", collectionId: "renders", recordType: "image.render", action: "transition", targetId: "image-render-test", expectedRevision: 1, params: { state: "submitting", patch: { attemptNumber: 1, attemptId: "prompt-test", promptId: "prompt-test" } } }] }, { access, context: { binding: { turn: 2, messageId: null } } });
  await executeDataBatch(store, { protocolVersion: 1, batchId: "submit-render-test", status: "pending", commitPolicy: "atomic", operations: [{ operationId: "submit-render", moduleId: "comfy-image-generation", collectionId: "renders", recordType: "image.render", action: "transition", targetId: "image-render-test", expectedRevision: 2, params: { state: "submitted", patch: { submittedAt: "2026-09-13T00:00:00.000Z" } } }] }, { access, context: { binding: { turn: 2, messageId: null } } });
  const saved = (await store.readCollection("comfy-image-generation", "renders")).records[0];
  assert.equal(saved.data.state, "submitted");
  assert.equal(saved.revision, 3);
});
