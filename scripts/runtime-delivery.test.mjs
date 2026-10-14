import { createRpClient } from "../packages/rp-web-client/index.mjs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { packageCardRuntime } from "../.agents/skills/st-card-to-pi-rp/scripts/package_card_runtime.mjs";
import { validateRuntimePackage } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/validate-runtime-package.mjs";

// Runs copied production host, Web, registry, workflow executor and persistence. The Pi boundary is
// a deterministic idle context; code workflows avoid models, credentials and external services.
test("a newly packaged card opens, runs a real module call, finalizes, persists and resumes", { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-delivery-"));
  const source = join(root, "draft"), target = join(root, "cards", "fixture");
  const env = { BOBO_RP_CARD_ID: "fixture", BOBO_RP_READY_FILE: join(root, "ready.json"), BOBO_AGENT_RP_CACHE_DIR: join(root, "cache") };
  const savedEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let host;
  t.after(async () => {
    if (host) await host.stopBridge();
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  });
  async function json(path, value) { await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
  const moduleDirectory = join(source, "features", "card-context-library");
  await cp(resolve(".agents/skills/st-card-to-pi-rp/assets/card-context-library"), moduleDirectory, { recursive: true });
  const module = JSON.parse(await readFile(join(moduleDirectory, "module.json"), "utf8"));
  module.workflowFiles.push("workflows/offline-turn/workflow.json");
  await json(join(moduleDirectory, "module.json"), module);
  await json(join(moduleDirectory, "workflows", "offline-turn", "workflow.json"), {
    schemaVersion: 4, id: "offline-turn", ownerModuleId: module.id, title: "Offline acceptance turn", kind: "foreground", trigger: { type: "manual" },
    nodes: [
      { id: "compose", type: "code", metadata: { entryFile: "runtime/offline-turn.mjs" }, workflowCalls: ["card-context-library/export-context"], outputs: { narrative: { path: "narrative.md", format: "narrative", scope: "workflow", retain: "run" } }, narrativeSource: { layer: "story" } },
      { id: "commit", type: "turn-finalize", dependsOn: ["compose"], narrative: { fromNode: "compose", output: "narrative" } },
    ],
  });
  await writeFile(join(moduleDirectory, "runtime", "offline-turn.mjs"), `import { readFile, writeFile } from "node:fs/promises"; import { join } from "node:path";
export async function execute({ run, workspace, calls }) {
  const result = await calls.invoke({ workflow:"card-context-library/export-context", arguments:{categories:["world"]}, outputPaths:{context:"context"} });
  const index = await readFile(join(workspace,result.outputs.context,"DOCUMENTS.md"),"utf8");
  if(!index.trim()) throw new Error("No real resource export was delivered");
  await writeFile(join(workspace,"narrative.md"),"已处理："+run.payload.currentInput+"；资源已交付。");
  return { delivered:true };
}`);
  const transcriptModuleDirectory = join(source, "features", "fixture-transcript");
  await mkdir(join(transcriptModuleDirectory, "collections", "conversation", "initial"), { recursive: true });
  await mkdir(join(transcriptModuleDirectory, "schemas"), { recursive: true });
  await mkdir(join(transcriptModuleDirectory, "skill"), { recursive: true });
  await mkdir(join(transcriptModuleDirectory, "runtime"), { recursive: true });
  await mkdir(join(transcriptModuleDirectory, "workflows", "noop"), { recursive: true });
  await json(join(transcriptModuleDirectory, "module.json"), {
    schemaVersion: 7,
    id: "fixture-transcript",
    moduleKind: "data",
    basedOn: null,
    title: "Fixture transcript",
    description: "Minimal data-owned transcript authority for offline runtime coverage.",
    surface: "background",
    contextOrder: 101,
    displayOrder: 101,
    dataContractFile: "data-contract.json",
    resourceCatalogFile: null,
    frontendViewFile: null,
    skillFile: "skill/SKILL.md",
    agentFiles: [],
    workflowFiles: ["workflows/noop/workflow.json"],
  });
  await json(join(transcriptModuleDirectory, "data-contract.json"), {
    schemaVersion: 1,
    moduleId: "fixture-transcript",
    collections: {
      conversation: {
        storage: { kind: "record-log", partition: { mode: "single" }, initialRecordsFile: "collections/conversation/initial/records.json" },
        recordTypes: {
          "narrative.message": {
            dataSchemaVersion: 1,
            schemaFile: "schemas/message.schema.json",
            indexes: {},
            searchableFields: ["/data/content"],
            views: {
              rp: {
                format: "object",
                fields: [
                  { path: "/data/role", label: "role" },
                  { path: "/data/kind", label: "kind" },
                  { path: "/data/content", label: "content" },
                  { path: "/data/narrativeSource", label: "narrativeSource" },
                ],
              },
            },
            actions: ["create", "update", "delete"],
          },
        },
      },
    },
    capabilities: {
      "fixture.transcript.read": { collections: ["conversation"], actions: ["query"], views: ["rp"] },
      "fixture.transcript.runtime": { collections: ["conversation"], actions: ["query", "create", "update", "delete"], views: ["rp"] },
    },
  });
  await json(join(transcriptModuleDirectory, "collections", "conversation", "initial", "records.json"), []);
  await json(join(transcriptModuleDirectory, "schemas", "message.schema.json"), {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["role", "kind", "content", "narrativeSource"],
    properties: {
      role: { type: "string", enum: ["user", "assistant"] },
      kind: { type: "string", enum: ["opening", "message"] },
      content: { type: "string", minLength: 1 },
      narrativeSource: {
        type: "object",
        additionalProperties: false,
        required: ["producerKind", "producerId", "layer", "characterId"],
        properties: {
          producerKind: { type: "string", enum: ["unknown", "user", "card", "agent", "code", "runtime"] },
          producerId: { type: ["string", "null"] },
          layer: { type: "string", enum: ["unspecified", "in-world", "story", "authorial"] },
          characterId: { type: ["string", "null"] },
        },
      },
    },
  });
  await writeFile(join(transcriptModuleDirectory, "skill", "SKILL.md"), "---\nname: fixture-transcript\ndescription: Provide the fixture transcript data authority.\n---\n\nThis module owns only the fixture conversation record log.\n", "utf8");
  await json(join(transcriptModuleDirectory, "workflows", "noop", "workflow.json"), {
    schemaVersion: 4,
    id: "noop",
    ownerModuleId: "fixture-transcript",
    title: "Fixture transcript support",
    kind: "global-background",
    trigger: { type: "manual" },
    nodes: [{ id: "noop", type: "code", metadata: { entryFile: "runtime/noop.mjs" } }],
  });
  await writeFile(join(transcriptModuleDirectory, "runtime", "noop.mjs"), "export async function execute() { return { ok: true }; }\n", "utf8");
  await json(join(source, "manifest.json"), {
    schema_version: 2,
    id: "fixture",
    name: "Offline fixture",
    fixed_context: "core/foundation.md",
    context_policy: "context/retrieval-policy.json",
    context_processors: [],
    feature_modules: ["features/card-context-library/module.json", "features/fixture-transcript/module.json"],
    openings: [{ id: "opening-00", title: "Opening", file: "openings/00.md", source: "first_mes" }],
    default_opening: "opening-00",
  });
  await json(join(source, "settings.json"), { schemaVersion: 1, cardId: "fixture", settings: { activeWorkflowId: "card-context-library/offline-turn" } });
  await json(join(source, "context", "retrieval-policy.json"), { schemaVersion: 2, source: "messages", code: { profile: "default" }, agent: { mode: "disabled", fallback: "code", onNotTriggered: "code", maxRecords: 100 } });
  await mkdir(join(source, "core")); await writeFile(join(source, "core", "foundation.md"), "Offline fixture foundation.");
  await mkdir(join(source, "openings")); await writeFile(join(source, "openings", "00.md"), "---\nid: opening-00\ntitle: Opening\n---\n\n开场正文。");
  await packageCardRuntime({ sourceCard: source, targetCard: target });
  const packagedManifest = JSON.parse(await readFile(join(target, "manifest.json"), "utf8"));
  assert.deepEqual(packagedManifest.transcript_provider, { schemaVersion: 1, moduleId: "fixture-transcript", collectionId: "conversation", recordType: "narrative.message", view: "rp" });
  const validation = await validateRuntimePackage(target);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  const lock = JSON.parse(await readFile(join(target, "runtime-lock.json"), "utf8"));
  assert.ok(!Object.keys(lock.files).some(path => path.startsWith("web/test/") || path.endsWith(".test.mjs")), "Production host and Web must not contain test fixtures");
  const baseline = JSON.parse(await readFile(resolve("scripts/development-runtime.json"), "utf8"));
  assert.deepEqual(lock.externalDependencies, [{ name: baseline.engine.name, testedVersion: baseline.engine.testedVersion }]);
  // typebox is supplied by the Pi host in production; use its identical pinned development build
  // in this isolated Node harness. No repository runtime import or root node_modules is packaged.
  await cp(resolve("node_modules/typebox"), join(root, "node_modules", "typebox"), { recursive: true });
  const { createRpHostSession } = await import(pathToFileURL(join(target, "runtime", "engine", "lib", "rp-host-session.ts")).href);
  const registered = { tools: [], commands: [], events: [] };
  const pi = { registerTool: tool => registered.tools.push(tool), registerCommand: name => registered.commands.push(name), on: name => registered.events.push(name), registerProvider: () => assert.fail("Offline fixture must not register models"), sendUserMessage: () => assert.fail("Offline fixture must not dispatch Pi prompts") };
  host = createRpHostSession(pi); host.register(pi);
  assert.ok(registered.tools.some(tool => tool.name === "rp_data_query"));
  const context = { cwd: root, isIdle: () => true, model: null, modelRegistry: { find: () => null }, sessionManager: { getSessionId: () => "first-chat", getSessionFile: () => null }, ui: { notify: () => {} } };
  let url = await host.startBridge("fixture", context);
  let client = createRpClient({ baseUrl: url });
  await client.connect();
  t.after(() => client.dispose());
  const request = async (path, method = "GET", body) => {
    if (path.endsWith("/input") && body && !body.operationId) body = { ...body, operationId: randomUUID() };
    return client.request(path, { method, body });
  };

  const transcriptRecordsPath = join(root, "sessions", "fixture", "first-chat", "modules", "fixture-transcript", "collections", "conversation", "records", "all.jsonl");
  const readTranscriptRecords = async () => {
    const contents = await readFile(transcriptRecordsPath, "utf8");
    return contents.trim() ? contents.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
  };
  const latestTranscriptRecords = records => {
    const latest = new Map();
    for (const record of records) {
      const previous = latest.get(record.id);
      if (!previous || record.revision > previous.revision) latest.set(record.id, record);
    }
    return [...latest.values()].sort((left, right) => left.sequence - right.sequence);
  };
  assert.equal((await request("/api/v1/state")).sessionId, null);
  assert.equal((await request("/api/v1/image-generation")).available, false, "A card without the image module must not advertise image availability");
  const page = await fetch(new URL("/", url)).then(response => response.text());
  assert.match(page, /src="\/app\.js\?v=/);
  await request("/api/v1/opening", "POST", { openingId: "opening-00" });
  await request("/api/v1/input", "POST", { content: "确定性回合" });
  const engine = host.scope.requireCurrent().workflowEngine;
  const run = engine.snapshot().find(item => item.workflowId === "card-context-library/offline-turn");
  assert.ok(run, "The real foreground workflow must start");
  const completed = await engine.wait(run.id);
  assert.equal(completed.status, "completed", completed.error);
  const state = await request("/api/v1/state");
  assert.equal(state.busy, false);
  assert.equal(state.lastTurnFailure, null);
  const originalNarrative = state.messages.at(-1).content;
  assert.equal(typeof originalNarrative, "string");
  assert.equal(state.messages.at(-1).content, "已处理：确定性回合；资源已交付。");
  assert.ok(engine.snapshot().some(item => item.workflowId === "card-context-library/export-context" && item.status === "completed"));
  let transcriptRecords = await readTranscriptRecords();
  assert.equal(transcriptRecords.length, 3);
  assert.ok(transcriptRecords.every(record => record.recordType === "narrative.message"));
  assert.deepEqual(latestTranscriptRecords(transcriptRecords).map(record => record.data.content), state.messages.map(message => message.content));
  assert.ok(latestTranscriptRecords(transcriptRecords).every(record => record.data.narrativeSource));
  const assistantRecord = latestTranscriptRecords(transcriptRecords).find(record => record.data.role === "assistant" && record.data.kind === "message");
  assert.equal(assistantRecord.revision, 1);
  assert.equal(assistantRecord.data.content, originalNarrative);
  const originalAttemptId = run.id;
  const candidateId = "workflow-offline-candidate";
  await request("/api/v1/narrative-attempts/regenerate", "POST", { executionId: candidateId });
  assert.equal((await engine.wait(candidateId)).status, "completed");
  await request("/api/v1/narrative-attempts/regenerate", "POST", { executionId: candidateId });
  const candidates = await request("/api/v1/narrative-attempts");
  assert.equal(candidates.attempts.length, 2);
  assert.equal(candidates.attempts.find(item => item.id === originalAttemptId).selected, true);
  client.preview(candidateId);
  const preview = await request("/api/v1/state");
  assert.equal(preview.displayExecutionId, candidateId);
  assert.equal(preview.messages.at(-1).attemptId, candidateId);
  assert.equal(preview.messages.filter(item => item.role === "user").length, 1);
  await request(`/api/v1/narrative-attempts/${candidateId}`, "PUT", { content: "候选正文的手工修订", expectedRevision: 1, operationId: "candidate-edit" });
  assert.deepEqual((await request(`/api/v1/narrative-attempts/${candidateId}/history`)).items.map(item => item.revision), [2, 1]);
  const beforeAdopt = await request("/api/v1/narrative-attempts");
  const adopted = await request(`/api/v1/narrative-attempts/${candidateId}/adopt`, "POST", { expectedRevision: beforeAdopt.revision });
  assert.equal(adopted.messages.at(-1).content, "候选正文的手工修订");
  assert.equal(adopted.messages.length, 3);
  const afterAdopt = await request("/api/v1/narrative-attempts");
  await request(`/api/v1/narrative-attempts/${originalAttemptId}/adopt`, "POST", { expectedRevision: afterAdopt.revision });
  assert.equal((await request("/api/v1/state")).messages.at(-1).content, originalNarrative);
  const editedState = await request("/api/v1/messages/2", "PUT", { content: "编辑后的正文", expectedRevision: 1, operationId: "edit-assistant-1" });
  assert.equal(editedState.messages.at(-1).content, "编辑后的正文");
  const staleResponse = await fetch(client.resourceUrl("/api/v1/messages/2"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "过期修改", expectedRevision: 1, operationId: "edit-assistant-stale" }),
  });
  const staleValue = await staleResponse.json();
  assert.equal(staleResponse.status, 409, JSON.stringify(staleValue));
  const history = await request("/api/v1/messages/2/history");
  assert.equal(history.items.length, 2);
  assert.equal(history.items[1].revision, 1);
  assert.equal(history.items[1].data.content, originalNarrative);
  transcriptRecords = await readTranscriptRecords();
  const latestAfterEdit = latestTranscriptRecords(transcriptRecords);
  const editedRecord = latestAfterEdit.find(record => record.data.role === "assistant" && record.data.kind === "message");
  assert.equal(editedRecord.revision, 2);
  assert.equal(editedRecord.data.content, "编辑后的正文");
  assert.ok(transcriptRecords.some(record => record.id === editedRecord.id && record.revision === 1 && record.data.content === originalNarrative));
  await request("/api/v1/input", "POST", { content: "下一轮确定性输入" });
  const next = engine.snapshot().find(item => item.workflowId === run.workflowId && item.turn === 2);
  assert.equal((await engine.wait(next.id)).status, "completed");
  const locked = await request("/api/v1/narrative-attempts");
  assert.equal(locked.attempts.find(item => item.id === candidateId).canAdopt, false);
  const oldAdoption = await fetch(client.resourceUrl(`/api/v1/narrative-attempts/${candidateId}/adopt`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: locked.revision }) });
  assert.equal(oldAdoption.status, 409);
  const reopened = await request("/api/v1/messages/3", "DELETE");
  assert.deepEqual(reopened.messages, editedState.messages);
  const remaining = await request("/api/v1/narrative-attempts");
  assert.equal(remaining.attempts.length, 2);
  assert.equal(remaining.attempts.find(item => item.id === candidateId).canAdopt, true);
  await request(`/api/v1/narrative-attempts/${candidateId}/adopt`, "POST", { expectedRevision: remaining.revision });
  assert.equal((await request("/api/v1/state")).messages.at(-1).content, "候选正文的手工修订");
  await request(`/api/v1/narrative-attempts/${originalAttemptId}/adopt`, "POST", { expectedRevision: (await request("/api/v1/narrative-attempts")).revision });
  assert.equal((await request("/api/v1/state")).messages.at(-1).content, "编辑后的正文");
  const persisted = await readFile(join(root, "sessions", "fixture", "first-chat", "messages.jsonl"), "utf8");
  assert.equal(persisted.trim().split("\n").length, 3);
  const firstUrl = url;
  await host.stopBridge();
  await rm(join(root, "sessions", "fixture", "first-chat", "messages.jsonl"), { force: true });
  url = await host.startBridge("fixture", { ...context, sessionManager: { ...context.sessionManager, getSessionId: () => "second-chat" } });
  client.dispose(); client = createRpClient({ baseUrl: url }); await client.connect();
  await request("/api/v1/resume", "POST", { sessionId: "first-chat" });
  const resumedState = await request("/api/v1/state");
  assert.deepEqual(resumedState.messages, editedState.messages);
  assert.equal(resumedState.messages.at(-1).content, editedState.messages.at(-1).content);
  const restoredEngine = host.scope.requireCurrent().workflowEngine;
  assert.ok(restoredEngine.snapshot().some(item => item.id === originalAttemptId), "Latest completed attempts must remain re-executable after restart");
  await request("/api/v1/narrative-attempts/regenerate", "POST", { executionId: "workflow-after-resume" });
  assert.equal((await restoredEngine.wait("workflow-after-resume")).status, "completed");
  assert.equal((await request("/api/v1/state")).messages.at(-1).content, "编辑后的正文", "Restart regeneration stays a private candidate");
  const reconstructed = await readFile(join(root, "sessions", "fixture", "first-chat", "messages.jsonl"), "utf8");
  assert.equal(reconstructed.trim().split("\n").length, 3);
  const deletedState = await request("/api/v1/messages/2", "DELETE");
  assert.ok(deletedState.messages.some(message => message.role === "user"));
  assert.ok(!deletedState.messages.some(message => message.sequence === 2));
  transcriptRecords = await readTranscriptRecords();
  assert.ok(latestTranscriptRecords(transcriptRecords).some(record => record.data.role === "user"));
  assert.ok(!transcriptRecords.some(record => record.data.role === "assistant" && record.data.kind === "message"));
  await assert.rejects(fetch(new URL("/api/v1/state", firstUrl)), /fetch failed/);
});
