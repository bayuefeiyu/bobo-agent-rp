import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const safeId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
const componentRef = value => typeof value === "string" && value.split("/").length === 2 && value.split("/").every(safeId);
const object = value => value && typeof value === "object" && !Array.isArray(value);

export async function readControlFile(directory, path) {
  if (typeof path !== "string" || isAbsolute(path) || /^[a-z]:/i.test(path) || path.replaceAll("\\", "/").split("/").some(part => !part || part === "..")) throw new Error("Prompt resource path must stay inside its module.");
  const base = resolve(directory);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Prompt resource path escapes its module.");
  let cursor = base;
  for (const part of rel.split(sep)) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Prompt resources cannot contain symbolic links.");
  }
  if (!(await lstat(target)).isFile()) throw new Error("Prompt resource must be a regular file.");
  return readFile(target, "utf8");
}

export async function loadPromptControls(directory, catalog, controlsFile = "controls.json") {
  const input = JSON.parse(await readControlFile(directory, controlsFile));
  if (input.schemaVersion !== 1 || !Array.isArray(input.groups) || !input.groups.length || input.groups.length > 100) throw new Error("Prompt controls require schemaVersion 1 and 1–100 groups.");
  const delivery = input.delivery || null;
  if (delivery && (delivery.mode !== "agent-prompt" || !Array.isArray(delivery.agents) || !delivery.agents.length || delivery.agents.some(id => !componentRef(id)) || new Set(delivery.agents).size !== delivery.agents.length)) throw new Error("Agent prompt controls require unique recipient Agent IDs.");
  if (delivery?.instruction !== undefined && typeof delivery.instruction !== "string") throw new Error("Agent prompt instruction must be text.");
  const ids = new Set();
  const documents = new Map((catalog?.documents || []).map(item => [item.id, item]));
  const used = new Set();
  const groups = input.groups.map(group => {
    if (!safeId(group.id) || ids.has(group.id) || typeof group.title !== "string" || !group.title.trim() || !Array.isArray(group.options) || !group.options.length) throw new Error("Prompt group requires a unique safe ID, title and options.");
    ids.add(group.id);
    const optionIds = new Set();
    const options = group.options.map(option => {
      if (!safeId(option.id) || ["none", "custom"].includes(option.id) || optionIds.has(option.id) || typeof option.label !== "string" || !option.label.trim()) throw new Error("Prompt option requires a unique safe ID and label.");
      optionIds.add(option.id);
      const document = documents.get(option.documentId);
      if (!document || document.selectionGroup !== group.id || used.has(document.id)) throw new Error("Prompt option must reference one resource in its own selection group.");
      used.add(document.id);
      return { id: option.id, label: option.label, documentId: document.id, path: document.path };
    });
    if (group.allowNone !== undefined && typeof group.allowNone !== "boolean") throw new Error("allowNone must be boolean.");
    if (group.allowCustom !== undefined && typeof group.allowCustom !== "boolean") throw new Error("allowCustom must be boolean.");
    if (group.last !== undefined && typeof group.last !== "boolean") throw new Error("last must be boolean.");
    return { id: group.id, title: group.title, description: typeof group.description === "string" ? group.description : "", last: group.last === true, options: [...(group.allowNone === false ? [] : [{ id: "none", label: "不追加", documentId: null, path: null }]), ...options, ...(group.allowCustom === false ? [] : [{ id: "custom", label: "自定义", documentId: null, path: null }])] };
  });
  if (used.size !== documents.size) throw new Error("Every prompt resource must belong to exactly one declared option.");
  if (groups.filter(group => group.last).length > 1) throw new Error("Only one prompt group can be fixed last.");
  groups.sort((left, right) => Number(left.last) - Number(right.last));
  if (delivery) for (const document of documents.values()) filterDirectorPrompt(await readControlFile(directory, document.path), delivery.agents[0], delivery.agents, document.path);
  return { schemaVersion: 1, title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : "创作要求", delivery, groups };
}

export function promptSettingsFields(controls) {
  return controls.groups.flatMap(group => [
    { path: `/selections/${group.id}/optionId`, label: group.title, type: "select", required: true, options: group.options.map(option => option.id), minimum: null, maximum: null },
    { path: `/selections/${group.id}/customText`, label: `${group.title}自定义`, type: "textarea", required: false, options: [], minimum: null, maximum: null },
  ]);
}

export function validatePromptSelections(controls, data) {
  if (!object(data) || !object(data.selections)) throw new Error("Prompt settings require selections.");
  const groupIds = new Set(controls.groups.map(group => group.id));
  if (Object.keys(data).some(key => key !== "selections") || Object.keys(data.selections).some(key => !groupIds.has(key))) throw new Error("Prompt settings contain an undeclared group or field.");
  for (const group of controls.groups) {
    const selection = data.selections[group.id];
    if (!object(selection) || Object.keys(selection).some(key => !["optionId", "customText"].includes(key)) || !group.options.some(option => option.id === selection.optionId) || typeof selection.customText !== "string" || selection.customText.length > 50000) throw new Error(`Invalid selection for ${group.id}.`);
    if (controls.delivery && selection.optionId === "custom") filterDirectorPrompt(selection.customText, controls.delivery.agents[0], controls.delivery.agents, `${group.title}自定义`);
  }
  return data;
}

export async function selectedPromptTexts(directory, controls, data) {
  validatePromptSelections(controls, data);
  const texts = new Map();
  for (const group of controls.groups) {
    const option = group.options.find(item => item.id === data.selections[group.id].optionId);
    if (option.path) texts.set(option.documentId, await readControlFile(directory, option.path));
  }
  return texts;
}

export function composePromptRequirements(controls, data, texts) {
  validatePromptSelections(controls, data);
  const sections = controls.groups.flatMap(group => {
    const selection = data.selections[group.id];
    const option = group.options.find(item => item.id === selection.optionId);
    const content = option.id === "custom" ? selection.customText : option.path ? texts.get(option.documentId) : "";
    if (typeof content !== "string") throw new Error(`Missing selected prompt resource for ${group.id}.`);
    return content.trim() ? [`## ${group.title}\n\n${content.trim()}`] : [];
  });
  return sections.length ? `# 创作要求\n\n${sections.join("\n\n")}\n` : "";
}

export async function frontendPromptControls(directory, controls, render = text => text) {
  return { title: render(controls.title), groups: await Promise.all(controls.groups.map(async group => ({
    id: group.id, title: render(group.title), description: render(group.description),
    options: await Promise.all(group.options.map(async option => ({ id: option.id, label: render(option.label), content: option.path ? render(await readControlFile(directory, option.path)) : "" }))),
  }))) };
}

/** Only standalone, unnested director-only comments carry audience metadata. */
export function filterDirectorPrompt(text, agentId, agents, source = "director prompt") {
  const allowed = new Set(agents);
  if (!allowed.has(agentId)) throw new Error(`Unknown director Agent: ${agentId}.`);
  let audience = null;
  const output = [];
  const lines = text.split(/(?<=\n)/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const stripped = line.trim();
    const fail = message => { throw new Error(`${source}:${index + 1}: ${message}`); };
    {
      const opening = stripped.match(/^<!--\s*director-only:\s*(.*?)\s*-->$/);
      if (opening) {
        if (audience) fail("Director-only blocks cannot be nested.");
        const ids = opening[1].split(",").map(id => id.trim());
        if (ids.some(id => !allowed.has(id)) || new Set(ids).size !== ids.length) fail("Director-only block contains an unknown or duplicate Agent ID.");
        audience = new Set(ids);
        continue;
      }
      if (/^<!--\s*\/director-only\s*-->$/.test(stripped)) {
        if (!audience) fail("Director-only closing marker has no opening marker.");
        audience = null;
        continue;
      }
      if (/<!--\s*\/?director-only\b/.test(line)) fail("Director-only markers must be complete standalone comments.");
    }
    if (!audience || audience.has(agentId)) output.push(line);
  }
  if (audience) throw new Error(`${source}:${lines.length}: Director-only block is not closed.`);
  return output.join("");
}

/** Trusted host snapshot; neither source fragments nor settings are workspace exports. */
export async function snapshotAgentPromptControls(modules, getRecord) {
  const snapshots = [];
  for (const module of modules || []) {
    for (const region of module.view?.regions || []) {
      if (region.type !== "prompt-controls") continue;
      const controls = await loadPromptControls(module.moduleDirectory, module.resourceCatalog, region.controlsFile);
      if (!controls.delivery) continue;
      const record = await getRecord(module, region);
      if (!record) throw new Error(`Prompt preferences ${module.id}/${region.recordId} are unavailable.`);
      const settings = record.value.settings;
      const texts = await selectedPromptTexts(module.moduleDirectory, controls, settings);
      const sections = controls.groups.map(group => {
        const selection = settings.selections[group.id];
        const option = group.options.find(option => option.id === selection.optionId);
        const content = option.id === "custom" ? selection.customText : option.path ? texts.get(option.documentId) : "";
        return { title: group.title, content };
      });
      snapshots.push({ moduleId: module.id, title: controls.title, agents: controls.delivery.agents, instruction: controls.delivery.instruction || "", revision: record.revision, sections });
    }
  }
  return snapshots;
}

export function agentPromptRequirements(snapshots, agentId) {
  return (snapshots || []).flatMap(snapshot => {
    if (!snapshot.agents.includes(agentId)) return [];
    const sections = snapshot.sections.flatMap(section => {
      const content = filterDirectorPrompt(section.content, agentId, snapshot.agents, `${snapshot.moduleId}/${section.title}`).trim();
      return content ? [`## ${section.title}\n\n${content}`] : [];
    });
    return sections.length ? [`# ${snapshot.title}\n\n${[snapshot.instruction, ...sections].filter(Boolean).join("\n\n")}`] : [];
  }).join("\n\n");
}
