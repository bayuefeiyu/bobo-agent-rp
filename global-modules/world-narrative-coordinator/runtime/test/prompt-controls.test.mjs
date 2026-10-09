import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importRuntimeTestModule } from "./runtime-test-runtime.mjs";

const { agentPromptRequirements, filterDirectorPrompt, frontendPromptControls, loadPromptControls, snapshotAgentPromptControls, validatePromptSelections } = await importRuntimeTestModule("rp-prompt-controls.mjs");
const { normalizeDataContract } = await importRuntimeTestModule("rp-data-contracts.mjs");
const { RpDataStore } = await importRuntimeTestModule("rp-data-store.mjs");
const { getDataRecord } = await importRuntimeTestModule("rp-data-query.mjs");
const { executeDataBatch } = await importRuntimeTestModule("rp-data-changes.mjs");
const { createDataReadView, readDataReadViewCollection } = await importRuntimeTestModule("rp-data-read-view.mjs");
const { RpWorkflowEngine } = await importRuntimeTestModule("rp-workflow-engine.mjs");
const { playPromptSources } = await importRuntimeTestModule("rp-author-prompts.mjs");

const directory = fileURLToPath(new URL("../../", import.meta.url));
const json = path => readFile(resolve(directory, path), "utf8").then(JSON.parse);
const controls = await loadPromptControls(directory, await json("catalog.json"));
const contract = normalizeDataContract(await json("data-contract.json"));
const region = (await json("frontend-view.json")).regions[0];
const module = { id: contract.moduleId, moduleDirectory: directory, resourceCatalog: await json("catalog.json"), view: { regions: [region] } };
const daily = "world-narrative-coordinator/world-narrative-daily-director";
const deep = "world-narrative-coordinator/world-narrative-deep-director";
const leader = "world-narrative-coordinator/world-narrative-team-leader";
const secretary = "world-narrative-coordinator/world-narrative-team-secretary";

async function fixture(t) {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "director-prompt-controls-"));
  t.after(() => rm(sessionDirectory, { recursive: true, force: true }));
  const store = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory: directory }] });
  await store.initialize();
  return { store, sessionDirectory };
}

const interleaved = `COMMON-ONE\n<!-- director-only: ${daily} -->\nDAILY-ONLY\n<!-- /director-only -->\nCOMMON-TWO\n<!-- director-only: ${deep}, ${leader} -->\nDEEP-ONLY\n<!-- /director-only -->\nCOMMON-THREE\n`;

test("director audience filtering preserves interleaved order and rejects malformed or unknown annotations", () => {
  assert.equal(filterDirectorPrompt(interleaved, daily, controls.delivery.agents), "COMMON-ONE\nDAILY-ONLY\nCOMMON-TWO\nCOMMON-THREE\n");
  assert.equal(filterDirectorPrompt(interleaved, deep, controls.delivery.agents), "COMMON-ONE\nCOMMON-TWO\nDEEP-ONLY\nCOMMON-THREE\n");
  assert.equal(filterDirectorPrompt(interleaved, secretary, controls.delivery.agents), "COMMON-ONE\nCOMMON-TWO\nCOMMON-THREE\n");
  for (const text of ["<!-- director-only: unknown -->\nx\n<!-- /director-only -->", `<!-- director-only: ${daily} -->\nx`, "<!-- /director-only -->", `prefix <!-- director-only: ${daily} -->`, `<!-- director-only: ${daily} -->\n<!-- director-only: ${deep} -->`]) assert.throws(() => filterDirectorPrompt(text, daily, controls.delivery.agents, "option.md"), /option.md:\d+:/);
  const sample = `\`\`\`markdown\n<!-- director-only: unknown -->\n\`\`\`\n`;
  assert.throws(() => filterDirectorPrompt(sample, daily, controls.delivery.agents), /unknown/);
});

test("other requirements have exactly default/custom and stay last independent of authored array position", async t => {
  assert.deepEqual(controls.groups.at(-1).options.map(option => option.id), ["default", "custom"]);
  const { sessionDirectory } = await fixture(t);
  const configuration = await json("controls.json");
  configuration.groups.reverse();
  await writeFile(resolve(sessionDirectory, "controls.json"), JSON.stringify(configuration));
  const reordered = await loadPromptControls(directory, module.resourceCatalog, "controls.json");
  // The module itself keeps authored order; its marked last item is independent of array position.
  const sourceOnly = { ...configuration, delivery: null };
  await writeFile(resolve(sessionDirectory, "controls.json"), JSON.stringify(sourceOnly));
  const reorderedDraft = await loadPromptControls(sessionDirectory, module.resourceCatalog);
  assert.equal(reorderedDraft.groups.at(-1).id, "other-requirements");
  assert.equal(reordered.groups.at(-1).id, "other-requirements");
  const frontend = await frontendPromptControls(directory, controls);
  assert.equal(frontend.title, "导演要求");
  assert.equal(frontend.groups.at(-1).options[0].content, "");
});

test("authored other requirements are selected independently from the retained player custom draft", async t => {
  const { sessionDirectory } = await fixture(t);
  const copy = resolve(sessionDirectory, "source-copy");
  await cp(directory, copy, { recursive: true });
  await writeFile(resolve(copy, "documents/options/other-requirements/default.md"), `CREATOR-DEFAULT\n<!-- director-only: ${daily} -->\nCREATOR-DAILY\n<!-- /director-only -->\n`);
  const data = (await json("collections/prompt-preferences/initial/snapshot.json"))[0].data;
  data.selections["other-requirements"].customText = "PLAYER-CUSTOM";
  const copiedModule = { ...module, moduleDirectory: copy };
  const record = () => ({ revision: 1, value: { settings: data } });
  const defaults = await snapshotAgentPromptControls([copiedModule], record);
  assert.match(agentPromptRequirements(defaults, daily), /CREATOR-DEFAULT[\s\S]*CREATOR-DAILY/);
  assert.doesNotMatch(agentPromptRequirements(defaults, secretary), /CREATOR-DAILY|PLAYER-CUSTOM/);
  data.selections["other-requirements"].optionId = "custom";
  const custom = await snapshotAgentPromptControls([copiedModule], record);
  assert.match(agentPromptRequirements(custom, daily), /PLAYER-CUSTOM/);
  assert.doesNotMatch(agentPromptRequirements(custom, daily), /CREATOR-DEFAULT|CREATOR-DAILY/);
  assert.match(await readFile(resolve(copy, "documents/options/other-requirements/default.md"), "utf8"), /CREATOR-DEFAULT/);
});

test("chat preferences persist with revision guards while frozen selected requirements reach only recipient Agents", async t => {
  const { store, sessionDirectory } = await fixture(t);
  const request = { moduleId: module.id, collectionId: region.collectionId, id: region.recordId, view: region.view };
  const access = { capabilities: [region.readCapability], views: [region.view] };
  const record = await getDataRecord(store, request, access);
  const settings = structuredClone(record.value.settings);
  settings.selections["protagonist-treatment"] = { optionId: "custom", customText: interleaved + "玩家{{user}}\n" };
  settings.selections["other-requirements"] = { optionId: "custom", customText: "OTHER-CHOSEN" };
  const save = (id, revision, data) => executeDataBatch(store, { protocolVersion: 1, batchId: id, status: "pending", commitPolicy: "atomic", operations: [{ operationId: "save", moduleId: module.id, collectionId: region.collectionId, recordType: region.recordType, targetId: region.recordId, action: "update", expectedRevision: revision, data }] }, { access: [{ moduleId: module.id, collectionId: region.collectionId, capabilities: [region.updateCapability], views: [region.view] }], context: { initiatorKind: "user", binding: { turn: 0, messageId: null } } });
  assert.equal((await save("save", 1, settings)).status, "committed");
  assert.equal((await save("stale", 1, settings)).status, "failed");
  const view = await createDataReadView({ sessionDirectory, store, sourceId: "director-run" });
  const getFrozen = () => getDataRecord(store, request, { ...access, readCollection: (moduleId, collectionId) => readDataReadViewCollection({ sessionDirectory, store, viewId: view.viewId, moduleId, collectionId }) });
  const snapshots = await snapshotAgentPromptControls([module], getFrozen);
  const text = agentPromptRequirements(JSON.parse(JSON.stringify(snapshots)), daily);
  assert.match(text, /COMMON-ONE[\s\S]*DAILY-ONLY[\s\S]*COMMON-TWO[\s\S]*COMMON-THREE[\s\S]*OTHER-CHOSEN/);
  assert.doesNotMatch(text, /DEEP-ONLY|director-only|默认/);
  assert.equal(agentPromptRequirements(snapshots, "narrative-writer"), "");
  assert.equal(agentPromptRequirements(snapshots, "narrative-memory-retriever"), "");
  const changed = structuredClone(settings);
  changed.selections["protagonist-treatment"].optionId = "ordinary";
  changed.selections["other-requirements"].optionId = "default";
  assert.equal((await save("switch", 2, changed)).status, "committed");
  assert.equal(agentPromptRequirements(await snapshotAgentPromptControls([module], getFrozen), daily), text);
  const latest = await snapshotAgentPromptControls([module], () => getDataRecord(store, request, access));
  assert.doesNotMatch(agentPromptRequirements(latest, daily), /DAILY-ONLY|OTHER-CHOSEN/);
  assert.match(agentPromptRequirements(latest, daily), /普通角色待遇/);
  await store.pruneByMessageIds(["removed-story"]);
  const resumed = new RpDataStore({ sessionDirectory, modules: [{ contract, moduleDirectory: directory }] });
  await resumed.initialize();
  assert.equal((await getDataRecord(resumed, request, access)).value.settings.selections["other-requirements"].customText, "OTHER-CHOSEN");
  await assert.rejects(getDataRecord(store, request, { capabilities: ["director.private.read"], views: ["director"] }), /view|capability|authorized/);
  const bad = structuredClone(settings); bad.selections["other-requirements"].optionId = "none";
  assert.throws(() => validatePromptSelections(controls, bad), /Invalid selection/);

  const card = resolve(sessionDirectory, "card");
  await mkdir(resolve(card, "prompts/system"), { recursive: true });
  await writeFile(resolve(card, "prompts/system/base.md"), "Base {{AVAILABLE_TOOLS}} {{WORKSPACE}}");
  await writeFile(resolve(card, "prompts/system/tools.json"), "{}");
  const prompt = await playPromptSources({ cardDirectory: card, context: { cwd: card }, playerName: "林舟", isolatedRuntime: true }, null, { id: daily, prompt: "BASE-AGENT" }, { id: "adjust", prompt: "NODE-TASK" }, resolve(sessionDirectory, "workspace"), [], text + "\n<!-- role: user -->\nLITERAL-MARKER");
  assert.equal(prompt.agent.length, 1);
  assert.equal(prompt.agent[0].role, "system");
  assert.match(prompt.agent[0].content, /BASE-AGENT[\s\S]*玩家林舟/);
  assert.match(prompt.agent[0].content, /<!-- role: user -->/);
  assert.equal(prompt.nodeText, "NODE-TASK");
  assert.equal(prompt.fullNodeText, "NODE-TASK");
  const userRole = await playPromptSources({ cardDirectory: card, context: { cwd: card }, playerName: "林舟", isolatedRuntime: true }, null, { id: daily, prompt: "<!-- role: user -->\nBASE-USER-ROLE" }, { id: "adjust", prompt: "NODE-TASK" }, resolve(sessionDirectory, "workspace"), [], text);
  assert.equal(userRole.agent.length, 1);
  assert.equal(userRole.agent[0].role, "user");
  assert.match(userRole.agent[0].content, /BASE-USER-ROLE[\s\S]*玩家林舟/);
});

test("team members share the frozen run but receive their own filtered Agent sections", async () => {
  const snapshot = [{ moduleId: module.id, title: "导演要求", agents: controls.delivery.agents, instruction: "", revision: 2, sections: [{ title: "主角待遇", content: interleaved }] }];
  const received = [];
  const engine = new RpWorkflowEngine({
    resolveAgent: async id => ({ id, tools: [] }),
    onRunStart: async () => ({ agentPromptControls: snapshot }),
    executor: async task => {
      if (task.node.type === "team") {
        for (const [id, agentId, role] of [["leader", leader, "leader"], ["secretary", secretary, "secretary"]]) await task.invokeAgent({ executionId: id, memberId: id, freezeKey: `member:${id}`, agentId, role, prompt: "phase" });
      } else received.push([task.agent.id, agentPromptRequirements(task.run.agentPromptControls, task.agent.id)]);
      return { output: {} };
    },
  });
  const started = await engine.start({ schemaVersion: 4, ownerModuleId: "test", id: "director-controls-team", kind: "global-background", nodes: [{ id: "meeting", type: "team", team: { schemaVersion: 1, leader: { id: "leader", agentId: leader }, secretary: { id: "secretary", agentId: secretary }, experts: [], assistants: [] } }] }, { id: "director-controls-team-run" });
  assert.equal((await engine.wait(started.id)).status, "completed");
  assert.match(received[0][1], /COMMON-ONE[\s\S]*COMMON-TWO[\s\S]*DEEP-ONLY[\s\S]*COMMON-THREE/);
  assert.doesNotMatch(received[1][1], /DAILY-ONLY|DEEP-ONLY/);
  assert.match(received[1][1], /COMMON-ONE[\s\S]*COMMON-TWO[\s\S]*COMMON-THREE/);
});
