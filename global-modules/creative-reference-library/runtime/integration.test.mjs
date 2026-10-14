import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { LibraryClient } from "../../../packages/creative-reference-library/client.mjs";
import {
  createReferenceService,
  privateLibraryToolAllowed,
  referenceBindingPath,
  referenceSemanticManager,
  referenceSemanticManagement,
  saveReferenceBinding,
} from "../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-reference-library.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { createApplication } from "../../../packages/rp-web-server/index.mjs";
import { createRpNodeExecutor } from "../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-node-executor.ts";
import { normalizeWorkflowDefinition, normalizeWorkflowCallRequest, workflowCallAuthorization } from "../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs";
import { RpWorkflowEngine } from "../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflow-engine.mjs";
import { createControlNodeExecutor } from "../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-node-control-executor.ts";
import { workflowNodeWorkspace } from "../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-artifacts.mjs";

const MODULE_ID = "creative-reference-library";

test("shipped creative callers fix b to text screening and share one real workflow-call allowance", async () => {
  const target = normalizeWorkflowDefinition(JSON.parse(await readFile(new URL("../workflows/search-units/workflow.json", import.meta.url), "utf8")));
  for (const [moduleId, workflowId, nodeId] of [["narrative-controls", "standard-rp", "write-narrative"], ["narrative-controls", "advanced-memory-rp", "write-narrative"], ["world-narrative-coordinator", "deep-director-planning", "plan"], ["world-narrative-coordinator", "deep-director-team-planning", "meeting"]]) {
    const source = normalizeWorkflowDefinition(JSON.parse(await readFile(resolve("global-modules", moduleId, "workflows", workflowId, "workflow.json"), "utf8")));
    const node = source.nodes.find(n => n.id === nodeId), authorization = workflowCallAuthorization(node, "creative-reference-library/search-units") ?? node.workflowCalls.find(c => c.target === "creative-reference-library/search-units");
    assert.equal(normalizeWorkflowCallRequest(target, { text: "synthetic creative query", arguments: { context: "brief context" }, outputPaths: { references: "creative-references" } }, authorization).arguments.includeSemanticCandidates, false);
    assert.throws(() => normalizeWorkflowCallRequest(target, { text: "query", arguments: { includeSemanticCandidates: true }, outputPaths: { references: "creative-references" } }, authorization));
    const child = { ...target, defaults: {}, nodes: [{ id: "work", type: "code", outputs: { references: { path: "creative-references", format: "document-set" } } }, { id: "return", type: "workflow-return", dependsOn: ["work"], exports: { references: { fromNode: "work", output: "references" } } }] };
    let dispatched = 0;
    const engine = new RpWorkflowEngine({ resolveWorkflow: async () => child, executor: async task => {
      if (task.workflow.ownerModuleId === MODULE_ID) { if (task.node.id === "work") { dispatched++; assert.equal(task.run.arguments.includeSemanticCandidates, false); } return { output: task.node.id === "return" ? { outputs: { references: "creative-references" } } : null }; }
      const request = { workflow: "creative-reference-library/search-units", text: "synthetic creative query", outputPaths: { references: "creative-references" } };
      const attempts = await Promise.allSettled([Promise.resolve().then(() => task.invokeWorkflow(request)), Promise.resolve().then(() => task.invokeWorkflow(request))]);
      assert.equal(attempts.filter(a => a.status === "fulfilled").length, 1, JSON.stringify(attempts.map(a => ({ status: a.status, error: a.reason?.message })))); assert.equal(attempts.find(a => a.status === "rejected").reason.code, "workflow_call_limit_exceeded");
      return { output: null };
    } });
    const parent = { schemaVersion: 4, id: "test/reference-default", ownerModuleId: "test", kind: "global-background", nodes: [{ id: "use", type: "code", workflowCalls: node.workflowCalls.filter(c => c.target.startsWith("creative-reference-library/")) }] };
    const run = await engine.start(parent), completed = await engine.wait(run.id); assert.equal(completed.status, "completed", JSON.stringify(completed)); assert.equal(dispatched, 1, workflowId);
  }
});

for (const ready of [false, true]) test(`meeting host exposes the shared reference assistant only when ready=${ready}`, async t => {
  const f = await fixture(t); if (!ready) await saveReferenceBinding({ root: "" });
  const moduleDirectory = resolve("global-modules/world-narrative-coordinator"), workflow = normalizeWorkflowDefinition(JSON.parse(await readFile(join(moduleDirectory, "workflows/deep-director-team-planning/workflow.json"), "utf8")));
  const node = workflow.nodes.find(n => n.id === "meeting"), run = { id: `meeting-${ready}`, turn: 1, nodes: {} };
  const meetingWorkspace = workflowNodeWorkspace(f.root, workflow.id, run.id, node.id);
  await mkdir(join(meetingWorkspace, "team"), { recursive: true }); await writeFile(join(meetingWorkspace, "team/config.json"), JSON.stringify(node.team));
  const target = { context: { cwd: resolve(".") }, cardDirectory: f.root, playerName: "Synthetic", cardName: "Synthetic", cardId: "synthetic", messages: [], featureModules: [{ id: "world-narrative-coordinator", moduleDirectory }, { id: MODULE_ID, externalResource: "creative-reference-library/v1" }] };
  const scope = { requireCurrent: () => target, requireChat: () => ({ sessionDirectory: f.root }) };
  const execute = createControlNodeExecutor({ scope, turn: { current: null } }); let references = 0;
  const result = await execute({ workflow, run, node, invokeWorkflow: async request => { if (request.workflow === "creative-reference-library/search-units") { references++; assert.equal(request.arguments.includeSemanticCandidates, false); } return { outputs: request.outputPaths }; }, invokeAgent: async request => {
    if (request.executionId === "initial-leader") assert.equal(request.prompt.includes("创作参考资料检索"), ready);
    if (request.executionId.startsWith("coordination-")) return { content: JSON.stringify({ requests: ready ? [{ requestId: "reference-once", abilityId: "creative-reference", text: "synthetic broad query", disposition: "dispatch", reason: "synthetic shared request" }] : [] }) };
    if (["secretary-draft", "secretary-revision"].includes(request.executionId)) return { content: JSON.stringify({ report: { summary: "synthetic plan", content: "synthetic branches" }, referenceUpdates: [] }) };
    if (request.executionId.startsWith("discussion-") && request.executionId.endsWith("-leader")) return { content: "synthetic discussion", control: { action: "close" } };
    return { content: "synthetic analysis" };
  } }, { callInputs: [], upstreamHandoffs: [], dataReadBatchIds: [] });
  assert.equal(result.output.deliverables.report, "deliverables/report.json"); assert.equal(references, ready ? 1 : 0);
  const saved = JSON.parse(await readFile(join(meetingWorkspace, "team/state.json"), "utf8"));
  assert.equal(Object.values(saved.tasks || {}).filter(task => task.abilityId === "creative-reference").length, ready ? 1 : 0);
});

const BUDGET = {
  queries: 4,
  candidates: 4,
  scored: 2,
  reads: 5,
  readCharacters: 5000,
  scoreCharacters: 5000,
  modelCalls: 4,
  results: 2,
  outputCharacters: 5000,
};

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function writeOriginalPackage(root, revision, suffix = "") {
  const packageDirectory = join(root, `source-${revision}`);
  const reviewPath = join(root, `review-${revision}.json`);
  const units = [
    {
      id: "star-market",
      title: "星河集市",
      summary: "一处记录交换规矩与夜间线索的原创资料。",
      keywords: ["星河", "集市", "交换"],
      content: `星河集市在暮色后开放，摊主先登记物品，再按顺序交换线索。${suffix}`,
    },
    {
      id: "star-garden",
      title: "星河花园",
      summary: "一处记录园圃气味与观察线索的原创资料。",
      keywords: ["星河", "花园", "观察"],
      content: `星河花园的石径留有清晨露水，观察者应先记录气味，再判断来客。${suffix}`,
    },
  ];
  await mkdir(packageDirectory, { recursive: true });
  await writeJson(join(packageDirectory, "package.json"), {
    format: "creative-reference-library/v1",
    id: "private-original-material",
    units: units.map(unit => `${unit.id}.json`),
  });
  for (const unit of units) {
    await writeJson(join(packageDirectory, `${unit.id}.json`), {
      id: unit.id,
      revision,
      title: unit.title,
      summary: unit.summary,
      keywords: unit.keywords,
      aliases: [],
      contentFile: `${unit.id}.md`,
    });
    await writeFile(join(packageDirectory, `${unit.id}.md`), unit.content + "\n", "utf8");
  }
  await writeJson(reviewPath, {
    format: "creative-reference-library/v1",
    packageId: "private-original-material",
    approved: true,
    selectedIds: units.map(unit => unit.id),
  });
  return { packageDirectory, reviewPath, units };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reference-library-integration-"));
  const library = join(root, "library");
  const configDirectory = join(root, "user-config");
  const workspace = join(root, "workspace");
  const previousConfigDirectory = process.env.BOBO_AGENT_RP_USER_CONFIG_DIR;
  process.env.BOBO_AGENT_RP_USER_CONFIG_DIR = configDirectory;
  t.after(async () => {
    await (await referenceSemanticManager()).close();
    await client.close();
    if (previousConfigDirectory === undefined) delete process.env.BOBO_AGENT_RP_USER_CONFIG_DIR;
    else process.env.BOBO_AGENT_RP_USER_CONFIG_DIR = previousConfigDirectory;
    await rm(root, { recursive: true, force: true });
  });

  const original = await writeOriginalPackage(root, 1);
  const client = new LibraryClient();
  const published = await client.publish(library, original.packageDirectory, original.reviewPath);
  const binding = await saveReferenceBinding({ root: library });
  await mkdir(workspace, { recursive: true });
  return { root, library, configDirectory, workspace, original, published, client, binding };
}

function hostAndRuns() {
  const workflow = { ownerModuleId: MODULE_ID };
  const parentRun = { id: "request-a", arguments: { budget: BUDGET } };
  const childRun = {
    id: "request-b",
    arguments: { budget: BUDGET },
    callContext: { parentRunId: parentRun.id },
  };
  const target = {
    featureModules: [{ id: MODULE_ID, externalResource: "creative-reference-library/v1" }],
    workflowEngine: {
      runs: new Map([[parentRun.id, { workflow, run: parentRun }]]),
    },
  };
  const node = { id: "retrieve", type: "code", runtimeServices: ["referenceLibrary"] };
  return { workflow, parentRun, childRun, target, node };
}

test("parent and child reference services keep one pinned generation and ledger", async t => {
  const f = await fixture(t);
  const { workflow, parentRun, childRun, target, node } = hostAndRuns();
  const serviceB = createReferenceService(target, workflow, childRun, node, f.root);
  const serviceA = createReferenceService(target, workflow, parentRun, node, f.root);
  const request = {
    text: "星河",
    context: "寻找原创资料中的交换与观察线索",
    budget: BUDGET,
  };

  const prepared = await serviceB.prepare(request);
  assert.deepEqual(new Set(prepared.candidates.map(candidate => candidate.id)), new Set(["star-market", "star-garden"]));
  await serviceB.chargeModel({ candidates: prepared.candidates }, true);
  const scores = prepared.candidates.map((candidate, index) => ({ id: candidate.id, score: 100 - index }));
  const ordered = await serviceB.orderScores({ scores }, prepared.candidates);
  const composedB = await serviceB.compose(ordered);
  assert.equal(composedB.status, "success");
  assert.deepEqual(composedB.documents.map(document => document.title).sort(), ["星河花园", "星河集市"]);
  assert.deepEqual(await serviceA.selected(), composedB.selectedIds);

  const initialized = await serviceA.initialize(request);
  for (const [key, limit] of Object.entries(BUDGET)) assert.equal(initialized.budget[key], limit);
  const candidatesA = await serviceA.search(request);
  assert.equal(candidatesA.length, 2);
  const firstId = candidatesA[0].id;
  const secondId = candidatesA.find(candidate => candidate.id !== firstId).id;
  const readA = await serviceA.read(firstId);
  assert.match(readA.content, /星河/);
  const composedA = await serviceA.compose([firstId]);
  assert.equal(composedA.documents.length, 1);
  assert.equal(composedA.documents[0].content, readA.content);

  const updated = await writeOriginalPackage(f.root, 2, "这是同一资料的新修订。\n");
  const nextGeneration = await f.client.publish(f.library, updated.packageDirectory, updated.reviewPath);
  assert.notEqual(nextGeneration.generation, f.published.generation);
  const pinnedRead = await serviceA.read(secondId);
  assert.doesNotMatch(pinnedRead.content, /新修订/);
  await assert.rejects(() => serviceA.read(firstId), { code: "budget_exhausted" });
});

test("semantic host workflow exports reference passages, shares the parent ledger and respects capability switches", async t => {
  const f = await fixture(t), manager = await referenceSemanticManager();
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk; const value = JSON.parse(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/embed" ? { data: value.input.map((_text, index) => ({ index, embedding: [1, .1, .1] })) } : { results: value.documents.map((_text, index) => ({ index, relevance_score: .9 - index * .1 })) }));
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { normalizeSemanticConfig } = await import("../../../packages/creative-reference-library/semantic-contract.mjs");
  const config = normalizeSemanticConfig({ enabled: true, embedding: { url: `${base}/embed`, model: "synthetic", dimensions: 3 }, rerank: { url: `${base}/rerank`, model: "synthetic" } });
  await manager.save({ config }); await manager.test(); assert.equal((await manager.status()).ready, false);
  const job = await manager.start(); assert.equal((await manager.wait(job.jobId)).status, "completed");
  const { workflow, parentRun, childRun, target, node } = hostAndRuns();
  parentRun.arguments.budget = { ...BUDGET, reads: 8 };
  const parent = createReferenceService(target, workflow, parentRun, node, f.root), child = createReferenceService(target, workflow, childRun, node, f.root);
  await parent.initialize({ text: "星河" });
  const output = await child.searchPassages({ text: "星河" }); assert.equal(output.documents.length, 2); assert.ok(output.selectedRefs.every(ref => ref.kind === "passage"));
  assert.deepEqual(await parent.selectedReferences(), output.selectedRefs);
  await parent.validateReferences(output.selectedRefs); const reused = await parent.composeReferences(output.selectedRefs); assert.equal(reused.documents.length, 2);
  const ledgerPath = join(f.root, "reference-library-requests", `${parentRun.id}.json`), ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.used.embeddingCalls, 1); assert.equal(ledger.used.rerankCalls, 1); assert.equal(ledger.used.modelCalls, 0); assert.equal(ledger.used.results, 2);
  const semanticWorkflow = normalizeWorkflowDefinition(JSON.parse(await readFile("global-modules/creative-reference-library/workflows/search-passages/workflow.json", "utf8")), "creative-reference-library");
  assert.equal(semanticWorkflow.nodes.filter(n => n.type === "agent").length, 0);
  const { execute } = await import("./search-passages.mjs");
  const exportWorkspace = join(f.root, "semantic-output"); await mkdir(exportWorkspace);
  const exported = await execute({ run: { textInput: "星河", arguments: {} }, workspace: exportWorkspace, services: { referenceLibrary: { searchPassages: async () => output } } });
  assert.equal(exported.count, 2); assert.match(await readFile(join(exportWorkspace, "references", "DOCUMENTS.md"), "utf8"), /仅供参考/);
  await mkdir(join(f.root, "another-library")); await saveReferenceBinding({ root: join(f.root, "another-library") });
  assert.equal((await parent.composeReferences(output.selectedRefs)).documents.length, 2);
  await saveReferenceBinding({ root: f.library });
  await manager.save({ config: { ...config, enabled: false } }); await assert.rejects(() => child.searchPassages({ text: "星河" }), { code: "capability_unavailable" });
  assert.equal((await parent.selectedReferences()).length, 2);
  const fresh = createReferenceService(target, workflow, { id: "b-without-semantic", arguments: {} }, node, f.root);
  assert.ok((await fresh.prepare({ text: "星河", includeSemanticCandidates: false })).candidates.length);
  await assert.rejects(() => fresh.prepare({ text: "星河", includeSemanticCandidates: true }), { code: "capability_unavailable" });
});

test("private library paths and shell access are blocked while workspace files remain available", async t => {
  const f = await fixture(t);
  const workspaceFile = join(f.workspace, "draft.md");
  await writeFile(workspaceFile, "工作区草稿\n", "utf8");

  assert.equal(await privateLibraryToolAllowed(f.workspace, "read", { path: join(f.library, "library.json") }), false);
  assert.equal(await privateLibraryToolAllowed(f.workspace, "read", { path: referenceBindingPath() }), false);
  assert.equal(await privateLibraryToolAllowed(f.workspace, "bash", { path: "draft.md" }), false);
  assert.equal(await privateLibraryToolAllowed(f.workspace, "read", { path: "draft.md" }), true);

  const linkPath = join(f.workspace, "library-link");
  await symlink(f.library, linkPath, process.platform === "win32" ? "junction" : "dir");
  assert.equal(
    await privateLibraryToolAllowed(f.workspace, "read", { path: join("library-link", "library.json") }),
    false,
  );
});

test("library binding settings require the existing configuration token", async t => {
  const fetch = async (path, options) => {
    const url = new URL(path);
    const connection = (await globalThis.fetch(new URL("/api/v1/connection", url)).then(response => response.json())).data;
    url.searchParams.set("readContext", JSON.stringify(connection.readContext));
    return globalThis.fetch(url, options);
  };
  let saved = null; const operations = [];
  const bridge = { referenceSemanticManagement: async (operation, value) => { operations.push({ operation, value }); return { ok: true }; }, getReferenceLibrary: async () => ({ bound: false, root: "" }), authorizeConfigMutation: async token => { if (token !== "test-token") throw Object.assign(new Error("Invalid configuration token"), { status: 403 }); }, saveReferenceLibrary: async value => { saved = value; return { bound: true, ready: false }; } };
  const server = createServer(createApplication({ cardStore: {}, bridge }));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/config/reference-library`;
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: "private" }) })).status, 403); assert.equal(saved, null);
  assert.equal((await fetch(url, { method: "PUT", headers: { "content-type": "application/json", "x-rp-config-token": "test-token" }, body: JSON.stringify({ root: "private" }) })).status, 200); assert.equal(saved.root, "private");
  for (const [route, method] of [["config", "PUT"], ["test", "POST"], ["query", "POST"], ["jobs", "POST"], ["jobs/synthetic/cancel", "POST"], ["jobs/synthetic/resume", "POST"]]) {
    assert.equal((await fetch(`${url}/semantic/${route}`, { method, headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
    assert.equal(operations.length, 0);
  }
  assert.equal((await fetch(`${url}/semantic/jobs/synthetic/resume`, { method: "POST", headers: { "content-type": "application/json", "x-rp-config-token": "test-token" }, body: "{}" })).status, 200);
  assert.deepEqual(operations, [{ operation: "resume", value: { jobId: "synthetic" } }]);
});

test("empty scoring candidates produce the declared JSON artifact without resolving or calling a model", async t => {
  const f = await fixture(t), { target } = hostAndRuns(); target.recordId = "synthetic";
  const workflow = normalizeWorkflowDefinition(JSON.parse(await readFile(new URL("../workflows/search-units/workflow.json", import.meta.url), "utf8")));
  const node = workflow.nodes.find(n => n.id === "select"), run = { id: "empty-request", nodes: { prepare: { output: { candidates: [] } } } };
  const scope = { requireCurrent: () => target, requireChat: () => ({ sessionDirectory: f.root }) };
  const execute = createRpNodeExecutor({ scope, turn: { current: null }, resolveConfiguredModel: () => { throw new Error("No model should be resolved"); } });
  const result = await execute({ workflow, node, run, agent: {}, binding: {} });
  assert.deepEqual(result.output, { scores: [] }); assert.equal(result.usage.totalTokens, 0);
  const path = join(workflowNodeWorkspace(f.root, workflow.id, run.id, node.id), "scores.json"); assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { scores: [] });
});
