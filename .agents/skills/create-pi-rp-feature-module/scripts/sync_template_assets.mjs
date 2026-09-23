import { isDeepStrictEqual } from "node:util";
import { access, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const rootIndex = process.argv.indexOf("--root");
if (rootIndex >= 0 && !process.argv[rootIndex + 1]) throw new Error("--root requires a directory.");
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : process.cwd();
const assetRoot = resolve(root, ".agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime");
const copies = [
  {
    source: resolve(assetRoot, "data.mjs"),
    targets: [
      resolve(root, "global-modules/local-scene-narrative/runtime/lib/data.mjs"),
      resolve(root, "global-modules/world-scope-narrative/runtime/lib/data.mjs"),
    ],
  },
  {
    source: resolve(assetRoot, "story-mechanics.mjs"),
    targets: [
      resolve(root, "global-modules/local-scene-narrative/runtime/lib/story-mechanics.mjs"),
      resolve(root, "global-modules/world-scope-narrative/runtime/lib/story-mechanics.mjs"),
    ],
  },
  {
    source: resolve(assetRoot, "story-contract.mjs"),
    targets: [
      resolve(root, "global-modules/local-scene-narrative/runtime/lib/story-contract.mjs"),
      resolve(root, "global-modules/world-scope-narrative/runtime/lib/story-contract.mjs"),
      resolve(root, "global-modules/world-narrative-coordinator/runtime/lib/story-contract.mjs"),
    ],
  },
];
copies.push(
  {
    source: resolve(root, ".agents/skills/create-pi-rp-feature-module/assets/module-testing/runtime-test-runtime.mjs"),
    targets: [
      resolve(root, "global-modules/narrative-memory/runtime/test/runtime-test-runtime.mjs"),
      resolve(root, "global-modules/world-narrative-coordinator/runtime/test/runtime-test-runtime.mjs"),
    ],
  },
  {
    source: resolve(root, "global-modules/comfy-image-generation/profiles/anima/workflow.api.json"),
    targets: [resolve(root, "global-modules/comfy-image-generation/profiles/anima-simple/workflow.api.json")],
  },
);
const schemaTargets = [
  resolve(root, "global-modules/local-scene-narrative/schemas/story.schema.json"),
  resolve(root, "global-modules/world-scope-narrative/schemas/story.schema.json"),
];

for (const item of copies) await access(item.source);
const { STORY_RECORD_SCHEMA } = await import(`${pathToFileURL(resolve(assetRoot, "story-contract.mjs")).href}?sync=${Date.now()}`);
const runtimeRoot = resolve(root, ".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime");
const modulesRoot = resolve(root, "global-modules");

async function namedFiles(directory, name) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await namedFiles(path, name));
    else if (entry.name === name) result.push(path);
  }
  return result;
}

async function verifyPromptReference(owner, value, expectedPrefix, sourceRoot) {
  if (typeof value.promptFile !== "string" || !value.promptFile.startsWith(expectedPrefix)) throw new Error(`Missing or invalid promptFile: ${owner}`);
  if (Object.hasOwn(value, "prompt")) throw new Error(`promptFile definitions must not duplicate inline prompt text: ${owner}`);
  const suffix = value.promptFile.slice(expectedPrefix.length);
  const prompt = await readFile(resolve(sourceRoot, suffix), "utf8");
  if (!prompt.trim()) throw new Error(`Prompt file is empty: ${value.promptFile}`);
}

let promptReferenceCount = 0;
for (const path of await namedFiles(resolve(runtimeRoot, "agents"), "agent.json")) {
  const agent = JSON.parse(await readFile(path, "utf8"));
  await verifyPromptReference(path, agent, "prompts/", resolve(runtimeRoot, "prompts"));
  promptReferenceCount += 1;
}
for (const path of await namedFiles(resolve(runtimeRoot, "workflows"), "workflow.json")) {
  const workflow = JSON.parse(await readFile(path, "utf8"));
  for (const node of workflow.nodes.filter(node => ["agent", "team"].includes(node.type))) {
    await verifyPromptReference(`${path}#${node.id}`, node, "prompts/", resolve(runtimeRoot, "prompts"));
    promptReferenceCount += 1;
  }
}
for (const moduleEntry of await readdir(modulesRoot, { withFileTypes: true })) {
  if (!moduleEntry.isDirectory()) continue;
  const moduleRoot = resolve(modulesRoot, moduleEntry.name);
  const prefix = `prompts/modules/${moduleEntry.name}/`;
  for (const path of await namedFiles(resolve(moduleRoot, "agents"), "agent.json")) {
    const agent = JSON.parse(await readFile(path, "utf8"));
    await verifyPromptReference(path, agent, prefix, resolve(moduleRoot, "prompts"));
    promptReferenceCount += 1;
  }
  for (const path of await namedFiles(resolve(moduleRoot, "workflows"), "workflow.json")) {
    const workflow = JSON.parse(await readFile(path, "utf8"));
    for (const node of workflow.nodes.filter(node => ["agent", "team"].includes(node.type))) {
      await verifyPromptReference(`${path}#${node.id}`, node, prefix, resolve(moduleRoot, "prompts"));
      promptReferenceCount += 1;
    }
  }
}
if (process.argv.includes("--check")) {
  for (const item of copies) {
    const canonical = await readFile(item.source, "utf8");
    for (const target of item.targets) if (await readFile(target, "utf8") !== canonical) throw new Error(`Generated story runtime is stale: ${target}`);
  }
  for (const target of schemaTargets) {
    const schema = JSON.parse(await readFile(target, "utf8"));
    if (!isDeepStrictEqual(schema, STORY_RECORD_SCHEMA)) throw new Error(`Generated story schema is stale: ${target}`);
  }
} else {
  for (const item of copies) for (const target of item.targets) await copyFile(item.source, target);
  for (const target of schemaTargets) await writeFile(target, `${JSON.stringify(STORY_RECORD_SCHEMA, null, 2)}\n`, "utf8");
}
const owners = new Map();
const agentRoots = [resolve(runtimeRoot, "agents"), ...(await readdir(modulesRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => resolve(modulesRoot, entry.name, "agents"))];
for (const directory of agentRoots) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    const path = resolve(directory, entry.name, "agent.json");
    const agent = await readFile(path, "utf8").then(JSON.parse).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!agent) continue;
    if (owners.has(agent.id)) throw new Error(`Agent ${agent.id} has multiple template owners: ${owners.get(agent.id)} and ${path}`);
    owners.set(agent.id, path);
  }
}
console.log(`Template sources ${process.argv.includes("--check") ? "verified" : "synchronized"}: ${copies.length} file groups, ${schemaTargets.length} schemas, ${promptReferenceCount} prompt files, ${owners.size} unique Agents.`);
