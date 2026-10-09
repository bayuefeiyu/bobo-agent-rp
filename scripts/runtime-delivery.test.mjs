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
  await json(join(source, "manifest.json"), { schema_version: 2, id: "fixture", name: "Offline fixture", fixed_context: "core/foundation.md", context_policy: "context/retrieval-policy.json", context_processors: [], feature_modules: ["features/card-context-library/module.json"], openings: [{ id: "opening-00", title: "Opening", file: "openings/00.md", source: "first_mes" }], default_opening: "opening-00" });
  await json(join(source, "settings.json"), { schemaVersion: 1, cardId: "fixture", settings: { activeWorkflowId: "card-context-library/offline-turn" } });
  await json(join(source, "context", "retrieval-policy.json"), { schemaVersion: 2, source: "messages", code: { profile: "default" }, agent: { mode: "disabled", fallback: "code", onNotTriggered: "code", maxRecords: 100 } });
  await mkdir(join(source, "core")); await writeFile(join(source, "core", "foundation.md"), "Offline fixture foundation.");
  await mkdir(join(source, "openings")); await writeFile(join(source, "openings", "00.md"), "---\nid: opening-00\ntitle: Opening\n---\n\n开场正文。");
  await packageCardRuntime({ sourceCard: source, targetCard: target });
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
  const request = async (path, method = "GET", body) => {
    const response = await fetch(new URL(path, url), { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`); return value;
  };
  assert.equal((await request("/api/state")).sessionId, null);
  assert.equal((await request("/api/image-generation")).available, false, "A card without the image module must not advertise image availability");
  const page = await fetch(new URL("/", url)).then(response => response.text());
  assert.match(page, /src="\/app\.js\?v=/);
  await request("/api/opening", "POST", { openingId: "opening-00" });
  await request("/api/input", "POST", { content: "确定性回合" });
  const engine = host.scope.requireCurrent().workflowEngine;
  const run = engine.snapshot().find(item => item.workflowId === "card-context-library/offline-turn");
  assert.ok(run, "The real foreground workflow must start");
  const completed = await engine.wait(run.id);
  assert.equal(completed.status, "completed", completed.error);
  const state = await request("/api/state");
  assert.equal(state.busy, false);
  assert.equal(state.lastTurnFailure, null);
  assert.equal(state.messages.at(-1).content, "已处理：确定性回合；资源已交付。");
  assert.ok(engine.snapshot().some(item => item.workflowId === "card-context-library/export-context" && item.status === "completed"));
  const persisted = await readFile(join(root, "sessions", "fixture", "first-chat", "messages.jsonl"), "utf8");
  assert.equal(persisted.trim().split("\n").length, 3);
  await host.stopBridge();
  const firstUrl = url;
  url = await host.startBridge("fixture", { ...context, sessionManager: { ...context.sessionManager, getSessionId: () => "second-chat" } });
  await request("/api/resume", "POST", { sessionId: "first-chat" });
  assert.deepEqual((await request("/api/state")).messages, state.messages);
  await assert.rejects(fetch(new URL("/api/state", firstUrl)), /fetch failed/);
});
