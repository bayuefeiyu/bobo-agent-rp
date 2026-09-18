import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  await writeFile(resolve(profileDirectory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "text" }], negative: [], seed: [], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "quality", positiveSuffix: "style", negative: "bad" }, output: { nodeIds: ["2"] }, seedRange: { min: 0, max: 1125899906842624, source: "test" } }));
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
  await writeFile(resolve(profileDirectory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "text" }], negative: [], seed: [], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "quality", positiveSuffix: "", negative: "" }, output: { nodeIds: ["2"] }, seedRange: { min: 0, max: 1125899906842624, source: "test" } }));
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
  const resumed = await service.resumeRender({ connectionId: "local", connectionBaseUrl: originalBaseUrl, promptId: result.promptId, outputNodeIds: ["2"], workflow, timeoutMs: 5000 });
  assert.equal(resumed.outputs[0].filename, "result_00001_.png");
  server.close(); await once(server, "close");
});

/**
 * RC-07: ComfyUI accepts a queue entry whose seed exceeds the bound node's limit, skips the save
 * branch, and still reports `status_str: "success"` because an unrelated branch ran. The runtime has
 * to refuse the seed *before* anything is queued, and read the node errors in the history instead of
 * trusting `status_str`.
 */
test("a seed outside the frozen profile range is refused before anything is queued", async () => {
  let queueRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/prompt") { queueRequests += 1; response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(404); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const root = await mkdtemp(resolve(tmpdir(), "rp-comfy-range-"));
  const moduleDirectory = resolve(root, "card", "features", "comfy-image-generation");
  const profileDirectory = resolve(moduleDirectory, "profiles", "demo");
  await mkdir(profileDirectory, { recursive: true }); await mkdir(resolve(moduleDirectory, "skill", "guides", "demo"), { recursive: true });
  const workflow = { "1": { class_type: "CLIPTextEncode", inputs: { text: "" } }, "2": { class_type: "SaveImage", inputs: { filename_prefix: "" } }, "3": { class_type: "Seed (rgthree)", inputs: { seed: 0 } } };
  await writeFile(resolve(profileDirectory, "workflow.api.json"), JSON.stringify(workflow));
  await writeFile(resolve(profileDirectory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "text" }], negative: [], seed: [{ nodeId: "3", input: "seed" }], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "", positiveSuffix: "", negative: "" }, output: { nodeIds: ["2"] }, seedRange: { min: 0, max: 1125899906842624, source: "Seed (rgthree) ceiling" } }));
  await writeFile(resolve(moduleDirectory, "skill", "guides", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  const service = createComfyUiService({ rootDirectory: root, cardDirectory: resolve(root, "card"), featureModules: [{ id: "comfy-image-generation", moduleDirectory }], secretCacheDirectory: resolve(root, "secrets") });
  const address = server.address(); await service.saveConnection({ id: "local", title: "Test", baseUrl: `http://127.0.0.1:${address.port}` });
  const profile = (await service.profiles())[0];
  const snapshot = profile.executionSnapshot;
  assert.deepEqual(snapshot.seedRange, { min: 0, max: 1125899906842624, source: "Seed (rgthree) ceiling" }, "the range is part of the frozen snapshot");
  assert.equal(snapshot.seedRangeVerified, true);

  const payloadDigest = (seed) => createHash("sha256").update(JSON.stringify({ snapshotId: snapshot.snapshotId, effectiveDigest: snapshot.effectiveDigest, positivePrompt: "scene", negativePrompt: "", seed, filenamePrefix: "0001-r01-demo-final", promptId: "00000000-0000-4000-a000-000000000009" })).digest("hex");
  const captured = { snapshotId: snapshot.snapshotId, effectiveDigest: snapshot.effectiveDigest, positivePrompt: "scene", negativePrompt: "", seed: 1146077297967901, filenamePrefix: "0001-r01-demo-final", promptId: "00000000-0000-4000-a000-000000000009" };
  const digestOf = (value) => createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])))).digest("hex");
  await assert.rejects(
    () => service.generateFrozen({ snapshot, positivePrompt: "scene", negativePrompt: "", chatFolder: "chat", filenamePrefix: "0001-r01-demo-final", seed: 1146077297967901, payloadDigest: digestOf(captured), promptId: captured.promptId, timeoutMs: 3000 }),
    error => error.code === "comfy_pre_submit_failure" && /outside the frozen profile range/.test(error.message),
  );
  assert.equal(queueRequests, 0, "an illegal seed never reaches the queue");
  assert.equal(payloadDigest("unused").length, 64);
  server.close(); await once(server, "close");
});

test("a node error on the output branch is a failure, an unrelated one is only a warning", async () => {
  const responses = [];
  const server = createServer(async (request, response) => {
    if (request.url === "/prompt") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const queued = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ prompt_id: queued.prompt_id })); return;
    }
    if (request.url.startsWith("/history/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ [responses.at(-1).promptId]: responses.at(-1).history }));
      return;
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const root = await mkdtemp(resolve(tmpdir(), "rp-comfy-nodes-"));
  const moduleDirectory = resolve(root, "card", "features", "comfy-image-generation");
  const profileDirectory = resolve(moduleDirectory, "profiles", "demo");
  await mkdir(profileDirectory, { recursive: true }); await mkdir(resolve(moduleDirectory, "skill", "guides", "demo"), { recursive: true });
  // 3 -> 2 -> 1 is the output lineage; 9 is an unrelated branch.
  const workflow = {
    "1": { class_type: "SaveImage", inputs: { images: ["2", 0], filename_prefix: "" } },
    "2": { class_type: "VAEDecode", inputs: { samples: ["3", 0] } },
    "3": { class_type: "Seed (rgthree)", inputs: { seed: 0 } },
    "9": { class_type: "Note", inputs: {} },
  };
  await writeFile(resolve(profileDirectory, "workflow.api.json"), JSON.stringify(workflow));
  await writeFile(resolve(profileDirectory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "3", input: "seed" }], negative: [], seed: [{ nodeId: "3", input: "seed" }], filenamePrefix: [{ nodeId: "1", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "", positiveSuffix: "", negative: "" }, output: { nodeIds: ["1"] }, seedRange: { min: 0, max: 1125899906842624, source: "test" } }));
  await writeFile(resolve(moduleDirectory, "skill", "guides", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
  const service = createComfyUiService({ rootDirectory: root, cardDirectory: resolve(root, "card"), featureModules: [{ id: "comfy-image-generation", moduleDirectory }], secretCacheDirectory: resolve(root, "secrets") });
  const address = server.address(); await service.saveConnection({ id: "local", title: "Test", baseUrl: `http://127.0.0.1:${address.port}` });
  const promptId = "00000000-0000-4000-a000-000000000011";
  responses.push({ promptId, history: { status: { status_str: "success", completed: true, messages: [["execution_error", { node_id: "3", node_type: "Seed (rgthree)", exception_type: "ValueError", exception_message: "seed exceeds maximum" }], ["execution_success", {}]] }, outputs: {} } });
  await assert.rejects(
    () => service.resume({ profileId: "demo", promptId, timeoutMs: 3000 }),
    error => error.code === "comfy_output_branch_failed" && error.nodeErrors[0].nodeId === "3" && /node 3 \(Seed \(rgthree\)\)/.test(error.message),
  );

  const promptId2 = "00000000-0000-4000-a000-000000000012";
  responses.push({ promptId: promptId2, history: { status: { status_str: "success", completed: true, messages: [["execution_error", { node_id: "9", node_type: "Note", exception_message: "note failed" }], ["execution_success", {}]] }, outputs: { "1": { images: [{ filename: "ok.png", subfolder: "", type: "output" }] } } } });
  const resumed = await service.resume({ profileId: "demo", promptId: promptId2, timeoutMs: 3000 });
  assert.equal(resumed.outputs[0].filename, "ok.png", "an unrelated branch warning does not hide a real image");
  assert.equal(resumed.warnings.length, 1);
  assert.match(resumed.warnings[0], /node 9 \(Note\)/);
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
