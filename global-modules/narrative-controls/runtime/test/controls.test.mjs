import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { composePromptRequirements, frontendPromptControls, loadPromptControls, promptSettingsFields, readControlFile, selectedPromptTexts, validatePromptSelections } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-prompt-controls.mjs";
import * as promptControls from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-prompt-controls.mjs";
import { execute } from "../compose-context.mjs";
import { normalizeDataContract } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { getDataRecord } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs";
import { executeDataBatch } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs";
import { createDataReadView, readDataReadViewCollection } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-read-view.mjs";
import { normalizeModuleFrontendView, applyFrontendSettingsValues } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-module-frontend.mjs";
import { createAgentDelivery } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-agent-delivery.mjs";
import { renderCardText } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-card-text.mjs";

const directory = fileURLToPath(new URL("../../", import.meta.url));
const json = path => readFile(join(directory, path), "utf8").then(JSON.parse);
const catalog = await json("catalog.json");
const controls = await loadPromptControls(directory, catalog);
const seed = (await json("collections/settings/initial/snapshot.json"))[0].data;
const contract = normalizeDataContract(await json("data-contract.json"));
const module = { id: "narrative-controls", directory, resourceCatalog: catalog };
const readAccess = { capabilities: ["narrative.preferences.read"], views: ["processor"] };

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "rp-narrative-controls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("only the selected preset or custom text is composed; all source options remain available to the frontend", async () => {
  const settings = structuredClone(seed);
  settings.selections.pacing = { optionId: "conservative", customText: "UNSELECTED CUSTOM DRAFT" };
  settings.selections["player-speech"].optionId = "general";
  const texts = await selectedPromptTexts(directory, controls, settings);
  assert.deepEqual([...texts.keys()], ["pacing-conservative", "speech-general", "word-count-800-1500", "output-language-chinese", "input-mode-partial-expansion", "other-requirements-default"]);
  const content = composePromptRequirements(controls, settings, texts);
  assert.match(content, /循序渐进/);
  assert.match(content, /重要决定/);
  assert.doesNotMatch(content, /UNSELECTED CUSTOM DRAFT|极度大胆|第一优先/);
  settings.selections.pacing = { optionId: "custom", customText: "CUSTOM CHOSEN" };
  assert.match(composePromptRequirements(controls, settings, await selectedPromptTexts(directory, controls, settings)), /CUSTOM CHOSEN/);
  assert.match(composePromptRequirements(controls, seed, await selectedPromptTexts(directory, controls, seed)), /正文剧情内容800-1500字。[\s\S]*使用简体中文叙事[\s\S]*部分扩写任务/);
  const frontend = await frontendPromptControls(directory, controls);
  assert.equal(frontend.groups[0].options.at(-1).id, "custom");
  assert.match(frontend.groups[0].options.find(option => option.id === "highly-adventurous").content, /极度大胆/);
  assert.throws(() => validatePromptSelections(controls, { selections: { ...seed.selections, unknown: {} } }), /undeclared/);
  assert.throws(() => validatePromptSelections(controls, { selections: { ...seed.selections, pacing: { optionId: "bad", customText: "" } } }), /Invalid selection/);
  await assert.rejects(readControlFile(directory, "../other.md"), /inside/);
});

test("word count, language and expansion controls deliver source prose exclusively and retain custom drafts", async () => {
  const frontend = await frontendPromptControls(directory, controls);
  const options = id => frontend.groups.find(group => group.id === id).options;
  assert.deepEqual(options("word-count").map(option => option.label), ["800以内", "800-1500", "1500以上", "自定义"]);
  assert.deepEqual(options("output-language").map(option => option.label), ["中文", "自定义"]);
  assert.deepEqual(options("input-mode").map(option => option.label), ["扩写", "部分扩写", "续写"]);
  assert.equal(frontend.groups.at(-1).id, "other-requirements");
  assert.equal(options("word-count")[0].content, "# 字数准则：\n- 正文剧情内容不得大于800字。\n");
  assert.equal(options("word-count")[2].content, "# 字数准则：\n- 正文剧情内容不少于1500字。\n");
  assert.equal(options("output-language")[0].content, "# 语言准则：\n- 使用简体中文叙事，非中文专有名词可保留。\n");
  const fields = promptSettingsFields(controls);
  let settings = applyFrontendSettingsValues({ fields }, seed, {
    "/selections/word-count/optionId": "up-to-800",
    "/selections/word-count/customText": "WORD DRAFT",
    "/selections/output-language/optionId": "custom",
    "/selections/output-language/customText": "LANGUAGE CHOSEN",
    "/selections/input-mode/optionId": "full-expansion",
    "/selections/input-mode/customText": "INACTIVE MODE DRAFT",
  });
  const compose = async () => composePromptRequirements(controls, settings, await selectedPromptTexts(directory, controls, settings));
  let content = await compose();
  assert.match(content, /不得大于800字。[\s\S]*LANGUAGE CHOSEN[\s\S]*完整扩写任务/);
  assert.match(content, /对大纲完整、充实地呈现/);
  assert.doesNotMatch(content, /800-1500|不少于1500|使用简体中文|部分扩写任务|无缝续写|WORD DRAFT|INACTIVE MODE DRAFT|wordsCloud|<最新互动>/);
  settings = applyFrontendSettingsValues({ fields }, settings, {
    "/selections/word-count/optionId": "custom",
    "/selections/output-language/optionId": "chinese",
    "/selections/input-mode/optionId": "continue",
  });
  content = await compose();
  assert.match(content, /WORD DRAFT[\s\S]*使用简体中文[\s\S]*无缝续写剧情/);
  assert.doesNotMatch(content, /LANGUAGE CHOSEN|不得大于800|扩写任务/);
  assert.equal(settings.selections["output-language"].customText, "LANGUAGE CHOSEN");
  settings = applyFrontendSettingsValues({ fields }, settings, { "/selections/word-count/optionId": "at-least-1500", "/selections/input-mode/optionId": "partial-expansion" });
  content = await compose();
  assert.match(content, /不少于1500字。[\s\S]*部分扩写任务/);
  assert.match(content, /随后自由拓展、补充剩余情节/);
  assert.doesNotMatch(content, /WORD DRAFT|完整扩写任务|无缝续写/);
  assert.throws(() => applyFrontendSettingsValues({ fields }, settings, { "/selections/input-mode/optionId": "custom" }), /option|value|allowed/i);
});

test("other requirements stay last with exactly default/custom; switching preserves both and delivers only the selected text", async t => {
  const root = await temporary(t);
  await cp(join(directory, "documents"), join(root, "documents"), { recursive: true });
  const defaultPath = join(root, "documents/options/other-requirements/default.md");
  await writeFile(defaultPath, "AUTHOR DEFAULT");
  const frontend = await frontendPromptControls(root, controls);
  const group = frontend.groups.at(-1);
  assert.equal(group.id, "other-requirements");
  assert.deepEqual(group.options.map(option => option.id), ["default", "custom"]);
  assert.equal(seed.selections[group.id].optionId, "default");
  const fields = promptSettingsFields(controls);
  let settings = applyFrontendSettingsValues({ fields }, seed, {
    "/selections/pacing/optionId": "conservative",
    "/selections/other-requirements/customText": "PLAYER EXTRA",
  });
  const compose = async () => composePromptRequirements(controls, settings, await selectedPromptTexts(root, controls, settings));
  let content = await compose();
  assert.match(content, /循序渐进[\s\S]*## 其他要求\n\nAUTHOR DEFAULT/);
  assert.doesNotMatch(content, /PLAYER EXTRA/);
  settings = applyFrontendSettingsValues({ fields }, settings, { "/selections/other-requirements/optionId": "custom" });
  content = await compose();
  assert.match(content, /循序渐进[\s\S]*## 其他要求\n\nPLAYER EXTRA/);
  assert.doesNotMatch(content, /AUTHOR DEFAULT/);
  settings = applyFrontendSettingsValues({ fields }, settings, { "/selections/other-requirements/optionId": "default" });
  assert.equal(settings.selections[group.id].customText, "PLAYER EXTRA");
  assert.equal(await readFile(defaultPath, "utf8"), "AUTHOR DEFAULT");
  assert.match(await compose(), /AUTHOR DEFAULT/);
  settings = applyFrontendSettingsValues({ fields }, settings, {
    "/selections/other-requirements/optionId": "custom",
    "/selections/other-requirements/customText": "",
  });
  assert.doesNotMatch(await compose(), /其他要求|AUTHOR DEFAULT|PLAYER EXTRA/);
  settings.selections[group.id].optionId = "none";
  assert.throws(() => validatePromptSelections(controls, settings), /Invalid selection/);
});

test("selected requirements join the ordinary static document set without leaking option sources or private drafts", async t => {
  const root = await temporary(t);
  const input = join(root, "inputs", "static-context");
  await mkdir(join(input, "rules"), { recursive: true });
  await writeFile(join(input, "rules", "regular.md"), "ordinary rule");
  await writeFile(join(input, "DOCUMENTS.md"), "# Static documents\n- path: `rules/regular.md`\n- priority: 0\n");
  const settings = structuredClone(seed);
  settings.selections["player-speech"] = { optionId: "general", customText: "UNSELECTED DRAFT" };
  settings.selections["other-requirements"] = { optionId: "custom", customText: "额外关注{{user}}的兴趣。" };
  const data = { get: async () => ({ value: { settings } }) };
  await execute({ workspace: root, run: { documents: { "static-context": "caller/path" } }, module, data, services: { promptControls, cardText: { render: text => renderCardText(text, "林舟", "test") } } });
  const output = join(root, "context");
  const index = await readFile(join(output, "DOCUMENTS.md"), "utf8");
  assert.match(index, /rules\/regular.md/);
  assert.match(index, /creative-requirements.md/);
  assert.match(index, /categories: `narrative-guidance`/);
  assert.match(index, /priority: 0/);
  assert.doesNotMatch(index, /防抢话|自由抢话|高优先|options|档位/);
  const content = await readFile(join(output, "creative-requirements.md"), "utf8");
  assert.match(content, /林舟/);
  assert.match(content, /## 其他要求\n\n额外关注林舟的兴趣。/);
  assert.doesNotMatch(content, /{{user}}|UNSELECTED DRAFT|第一优先/);
  assert.equal(await readFile(join(output, "rules", "regular.md"), "utf8"), "ordinary rule");
  assert.deepEqual((await readdir(output)).sort(), ["DOCUMENTS.md", "creative-requirements.md", "rules"]);
  const delivery = await createAgentDelivery({ workspace: output, node: { id: "writer", outputs: { narrative: { path: "narrative.md", format: "narrative" } } } });
  await assert.rejects(delivery.access(join(directory, "documents/options/pacing/adventurous.md")), /relative/);
  await assert.rejects(delivery.access("../inputs/static-context/DOCUMENTS.md"), /traversal/);
});

test("settings are guarded, chat-local, persistent, and frozen for an in-progress generation", async t => {
  const root = await temporary(t);
  const bindings = [{ contract, moduleDirectory: directory }];
  const store = new RpDataStore({ sessionDirectory: join(root, "chat-a"), modules: bindings });
  await store.initialize();
  const region = normalizeModuleFrontendView(await json("frontend-view.json"), contract).regions[0];
  assert.equal(region.type, "prompt-controls");
  const fields = promptSettingsFields(controls);
  assert.throws(() => applyFrontendSettingsValues({ fields }, seed, { "/sourcePath": "secret" }), /undeclared/);
  const next = applyFrontendSettingsValues({ fields }, seed, {
    "/selections/pacing/optionId": "adventurous", "/selections/pacing/customText": "saved draft",
    "/selections/word-count/optionId": "at-least-1500", "/selections/word-count/customText": "saved word draft",
    "/selections/output-language/optionId": "custom", "/selections/output-language/customText": "saved language choice",
    "/selections/input-mode/optionId": "continue",
  });
  const frozen = await createDataReadView({ sessionDirectory: store.sessionDirectory, store, sourceId: "generation" });
  const submit = (batchId, expectedRevision, data = next) => executeDataBatch(store, { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations: [{ operationId: "save", moduleId: module.id, collectionId: "settings", recordType: "narrative.preferences", targetId: "narrative-preferences", action: "update", expectedRevision, data }] }, { access: [{ moduleId: module.id, collectionId: "settings", capabilities: ["narrative.preferences.frontend"], views: ["frontend"] }], context: { initiatorKind: "user", binding: { turn: 0, messageId: null } } });
  assert.equal((await submit("save-one", 1)).status, "committed");
  assert.equal((await submit("stale", 1)).status, "failed");
  const invalid = structuredClone(next); invalid.selections.pacing.optionId = "illegal";
  assert.equal((await submit("invalid", 2, invalid)).status, "failed");
  const frozenGet = request => getDataRecord(store, request, { ...readAccess, readCollection: (moduleId, collectionId) => readDataReadViewCollection({ sessionDirectory: store.sessionDirectory, store, viewId: frozen.viewId, moduleId, collectionId }) });
  const request = { moduleId: module.id, collectionId: "settings", id: "narrative-preferences", view: "processor" };
  assert.equal((await frozenGet(request)).value.settings.selections.pacing.optionId, "none");
  assert.equal((await frozenGet(request)).value.settings.selections["word-count"].optionId, "800-1500");
  assert.equal((await frozenGet(request)).value.settings.selections["output-language"].optionId, "chinese");
  assert.equal((await frozenGet(request)).value.settings.selections["input-mode"].optionId, "partial-expansion");
  await assert.rejects(getDataRecord(store, { ...request, view: "frontend" }, readAccess), /view|capability|authorized/);
  await store.pruneByMessageIds(["message-removed"]);
  const resumed = new RpDataStore({ sessionDirectory: store.sessionDirectory, modules: bindings });
  await resumed.initialize();
  assert.equal((await getDataRecord(resumed, request, readAccess)).value.settings.selections.pacing.optionId, "adventurous");
  assert.deepEqual((await getDataRecord(resumed, request, readAccess)).value.settings.selections, next.selections);
  const other = new RpDataStore({ sessionDirectory: join(root, "chat-b"), modules: bindings });
  await other.initialize();
  assert.equal((await getDataRecord(other, request, readAccess)).value.settings.selections.pacing.optionId, "none");
});

test("foreground templates hand narration only the composed static directory", async () => {
  for (const name of ["standard-rp", "advanced-memory-rp"]) {
    const workflow = JSON.parse(await readFile(new URL(`../../workflows/${name}/workflow.json`, import.meta.url), "utf8"));
    const writer = workflow.nodes.find(node => node.id === "write-narrative");
    assert.ok(writer.context.fromNodes.includes("prepare-creative-context"));
    assert.ok(!writer.context.fromNodes.includes("prepare-card-context"));
    assert.ok(!writer.moduleAccess.some(access => access.moduleId === module.id));
    const call = workflow.nodes.find(node => node.id === "prepare-creative-context");
    assert.equal(call.target, "narrative-controls/compose-context");
    assert.deepEqual(call.metadata.documentIndex, workflow.nodes.find(node => node.id === "prepare-card-context").metadata.documentIndex);
    const task = await readFile(new URL(`../../prompts/workflows/${name}/write-narrative.md`, import.meta.url), "utf8");
    assert.doesNotMatch(task, /字数准则|语言准则|800-1500|使用简体中文|扩写任务/);
  }
});
