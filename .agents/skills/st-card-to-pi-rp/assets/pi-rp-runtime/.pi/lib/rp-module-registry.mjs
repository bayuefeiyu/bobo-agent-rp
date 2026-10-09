import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { normalizeFeatureModuleManifest } from "./rp-feature-modules.mjs";
import { normalizeAgentProfile } from "./rp-model-config.mjs";
import { normalizeWorkflowDefinition } from "./rp-workflows.mjs";

export function componentReference(owner, id) {
  const parts = typeof id === "string" ? id.split("/") : [];
  if (parts.length === 1) parts.unshift(owner);
  if (parts.length !== 2 || parts.some(part => typeof part !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) || ["constructor", "prototype", "__proto__"].includes(part))) throw new Error("Component reference must use module-id/component-id.");
  if (owner != null && parts[0] !== owner) throw new Error("Component reference does not match its owner module.");
  return parts.join("/");
}

export async function moduleFile(directory, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || /^[a-z]:/i.test(path) || path.replaceAll("\\", "/").split("/").some(part => !part || part === "..")) throw new Error("Module file must remain inside its module.");
  const base = resolve(directory), target = resolve(base, path), rel = relative(base, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Module file escapes its owner directory.");
  let cursor = base;
  for (const part of rel.split(sep)) { cursor = resolve(cursor, part); if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Module files cannot contain symbolic links."); }
  if (!(await lstat(target)).isFile()) throw new Error("Module component must be a regular file.");
  return target;
}

async function namedFiles(directory, name) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (entry.isSymbolicLink()) throw new Error("Module component directories cannot contain symbolic links.");
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...await namedFiles(path, name));
    else if (entry.name === name) found.push(path);
  }
  return found;
}

export async function loadModuleComponents(moduleDirectory) {
  const directory = resolve(moduleDirectory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Module directory cannot be a symbolic link.");
  const record = normalizeFeatureModuleManifest(JSON.parse(await readFile(await moduleFile(directory, "module.json"), "utf8")));
  const load = async (paths, normalize, field) => {
    const result = [];
    for (const path of paths) {
      const file = await moduleFile(directory, path);
      const value = normalize(JSON.parse(await readFile(file, "utf8")));
      if (value.ownerModuleId !== record.id) throw new Error(`${field} component does not belong to ${record.id}.`);
      if (value.promptFile) await moduleFile(directory, value.promptFile);
      if (field === "workflow") for (const node of value.nodes) {
        if (node.promptFile) await moduleFile(directory, node.promptFile);
        if (node.metadata?.entryFile) await moduleFile(directory, node.metadata.entryFile);
      }
      result.push({ ...value, componentFile: file });
    }
    if (new Set(result.map(item => item.id)).size !== result.length) throw new Error(`Duplicate ${field} component in ${record.id}.`);
    const declared = new Set(result.map(item => item.componentFile));
    for (const file of await namedFiles(resolve(directory, field === "agent" ? "agents" : "workflows"), `${field}.json`)) if (!declared.has(file)) throw new Error(`Unregistered ${field} component: ${file}.`);
    return result;
  };
  const [agents, workflows] = await Promise.all([load(record.agentFiles, normalizeAgentProfile, "agent"), load(record.workflowFiles, normalizeWorkflowDefinition, "workflow")]);
  if (record.frontendViewFile) {
    const view = JSON.parse(await readFile(await moduleFile(directory, record.frontendViewFile), "utf8"));
    for (const region of view.regions || []) if (region.type === "workflow-controls") for (const item of region.workflows || []) {
      const ref = componentReference(record.id, item.id);
      const target = workflows.find(workflow => workflow.id === ref);
      if (!target || !["turn-background", "global-background"].includes(target.kind)) throw new Error(`Frontend control ${ref} must reference an owned background entry workflow.`);
    }
  }
  return { ...record, moduleDirectory: directory, agents, workflows };
}

export function validateModuleRegistry(modules) {
  const agents = new Map(modules.flatMap(module => module.agents.map(agent => [agent.id, agent])));
  const workflows = new Map(modules.flatMap(module => module.workflows.map(workflow => [workflow.id, workflow])));
  for (const module of modules) for (const workflow of module.workflows) {
    const requireAgent = ref => { if (ref && !agents.has(ref)) throw new Error(`Workflow ${workflow.id} references unregistered Agent ${ref}.`); };
    requireAgent(workflow.defaults.agentId);
    for (const node of workflow.nodes) {
      requireAgent(node.agentId);
      for (const member of node.team?.members || []) requireAgent(member.agentId);
      for (const ability of [...(node.team?.assistants || []), node.team?.baseRetrieval].filter(Boolean)) if (ability.kind === "agent") requireAgent(ability.agentId);
      for (const ref of [node.target, ...node.workflowCalls.map(binding => binding.target)].filter(Boolean)) {
        const target = workflows.get(ref);
        if (!target || !["module-external", "module-internal"].includes(target.kind)) throw new Error(`Workflow ${workflow.id} calls unregistered or non-callable workflow ${ref}.`);
      }
    }
    if (workflow.terminalFinalizer) {
      const target = workflows.get(workflow.terminalFinalizer.target);
      if (!target || target.ownerModuleId !== workflow.ownerModuleId || target.kind !== "module-internal") throw new Error(`Workflow ${workflow.id} terminal finalizer must be an owned internal workflow.`);
    }
    if (workflow.trigger?.workflowId) {
      const source = workflows.get(workflow.trigger.workflowId);
      if (!source || ["module-external", "module-internal"].includes(source.kind)) throw new Error(`Workflow ${workflow.id} trigger references an unavailable entry workflow.`);
      if (workflow.trigger.nodeId && !source.nodes.some(node => node.id === workflow.trigger.nodeId)) throw new Error(`Workflow ${workflow.id} trigger references an unavailable node.`);
      for (const mapping of Object.values(workflow.trigger.documents || {})) {
        if (!source.nodes.find(node => node.id === mapping.fromNode)?.outputs[mapping.output]) throw new Error(`Workflow ${workflow.id} trigger references an unavailable output.`);
      }
    }
  }
  return modules;
}

export async function loadCardComponents(cardDirectory) {
  const directory = resolve(cardDirectory);
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest.feature_modules)) throw new Error("Card must declare feature_modules.");
  for (const name of ["agents", "workflows", "prompts/agents", "prompts/workflows", "prompts/modules"]) {
    const entries = await readdir(resolve(directory, name)).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    if (entries.length) throw new Error(`Unowned components are forbidden in card/${name}; place them inside a feature module.`);
  }
  const result = [];
  for (const path of manifest.feature_modules) {
    const file = await moduleFile(directory, path);
    result.push(await loadModuleComponents(resolve(file, "..")));
  }
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error("Card contains duplicate module IDs.");
  return validateModuleRegistry(result);
}
