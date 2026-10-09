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
const modulesRoot = resolve(root, "global-modules");

async function verifyPromptReference(owner, value, expectedPrefix, sourceRoot) {
  if (typeof value.promptFile !== "string" || !value.promptFile.startsWith(expectedPrefix)) throw new Error(`Missing or invalid promptFile: ${owner}`);
  if (Object.hasOwn(value, "prompt")) throw new Error(`promptFile definitions must not duplicate inline prompt text: ${owner}`);
  const suffix = value.promptFile.slice(expectedPrefix.length);
  const prompt = await readFile(resolve(sourceRoot, suffix), "utf8");
  if (!prompt.trim()) throw new Error(`Prompt file is empty: ${value.promptFile}`);
}

let promptReferenceCount = 0;
const owners = new Map();
for (const moduleEntry of await readdir(modulesRoot, { withFileTypes: true })) {
  if (!moduleEntry.isDirectory()) continue;
  const moduleRoot = resolve(modulesRoot, moduleEntry.name);
  const manifest = await readFile(resolve(moduleRoot, "module.json"), "utf8")
    .then(JSON.parse)
    .catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!manifest) continue;
  const moduleId = manifest.id;
  if (typeof moduleId !== "string" || !moduleId) throw new Error(`Missing module id: ${moduleRoot}`);
  for (const relativePath of manifest.agentFiles || []) {
    const path = resolve(moduleRoot, relativePath);
    const agent = JSON.parse(await readFile(path, "utf8"));
    await verifyPromptReference(path, agent, "prompts/", resolve(moduleRoot, "prompts"));
    const ownerKey = `${moduleId}/${agent.id}`;
    if (owners.has(ownerKey)) throw new Error(`Agent ${ownerKey} has multiple template owners: ${owners.get(ownerKey)} and ${path}`);
    owners.set(ownerKey, path);
    promptReferenceCount += 1;
  }
  for (const relativePath of manifest.workflowFiles || []) {
    const path = resolve(moduleRoot, relativePath);
    const workflow = JSON.parse(await readFile(path, "utf8"));
    for (const node of workflow.nodes.filter(node => ["agent", "team"].includes(node.type))) {
      await verifyPromptReference(`${path}#${node.id}`, node, "prompts/", resolve(moduleRoot, "prompts"));
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
console.log(`Template sources ${process.argv.includes("--check") ? "verified" : "synchronized"}: ${copies.length} file groups, ${schemaTargets.length} schemas, ${promptReferenceCount} prompt files, ${owners.size} unique module Agents.`);
