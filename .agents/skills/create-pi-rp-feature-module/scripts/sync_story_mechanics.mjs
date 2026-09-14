import { isDeepStrictEqual } from "node:util";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const rootIndex = process.argv.indexOf("--root");
if (rootIndex >= 0 && !process.argv[rootIndex + 1]) throw new Error("--root requires a directory.");
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : process.cwd();
const assetRoot = resolve(root, ".agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime");
const copies = [
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
const schemaTargets = [
  resolve(root, "global-modules/local-scene-narrative/schemas/story.schema.json"),
  resolve(root, "global-modules/world-scope-narrative/schemas/story.schema.json"),
];

for (const item of copies) await access(item.source);
const { STORY_RECORD_SCHEMA } = await import(`${pathToFileURL(resolve(assetRoot, "story-contract.mjs")).href}?sync=${Date.now()}`);
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
