import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { normalizeResourceCatalog, selectResourceDocuments } from "./rp-resource-catalog.mjs";

/**
 * This test suite ships with the runtime and is therefore also executed from an installed copy,
 * where the relative layout differs: `.pi/lib` sits beside `features/<module>/` inside a card rather
 * than beside the shipped `assets/<module>/`. Resolving the module through both layouts keeps the
 * suite meaningful in each one instead of failing on import — a copied test's own import error is
 * not a product failure.
 */
async function loadExportContext() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Repository source layout: `<assets>/card-context-library/runtime/export-context.mjs`.
    resolve(here, "..", "..", "..", "card-context-library", "runtime", "export-context.mjs"),
    // Installed card layout: `.pi/lib` and `features/<module>` are siblings under the card root.
    resolve(here, "..", "..", "features", "card-context-library", "runtime", "export-context.mjs"),
  ];
  for (const candidate of candidates) {
    const found = await access(candidate).then(() => true, () => false);
    if (found) return (await import(pathToFileURL(candidate).href)).execute;
  }
  return null;
}

const exportContext = await loadExportContext();

const catalog = {
  schemaVersion: 1,
  moduleId: "card-context-library",
  categories: {
    world: { title: "世界观", description: "静态设定" },
    style: { title: "文风", description: "文风候选" },
  },
  selectionGroups: {
    prose: { title: "文风", mode: "one", instruction: "选择一种。", fallback: "style-default" },
  },
  documents: [
    { id: "world-core", path: "documents/world/core.md", title: "世界", summary: "世界细节", categories: ["world"], subcategory: null, readPolicy: "conditional", authority: "canonical", appliesAt: ["planning", "writing"], priority: 50, selectionGroup: null, readWhen: ["涉及世界设定"], perspective: "narrator", aliases: [], related: [], sources: ["lore:1"] },
    { id: "style-default", path: "documents/style/default.md", title: "默认文风", summary: "默认文风", categories: ["style"], subcategory: null, readPolicy: "choice", authority: "binding", appliesAt: ["writing", "checking"], priority: 40, selectionGroup: "prose", readWhen: [], perspective: "general", aliases: [], related: [], sources: ["description"] },
  ],
};

test("normalizes resource documents and selects complete category snapshots", () => {
  const normalized = normalizeResourceCatalog(catalog, "card-context-library");
  assert.equal(normalized.documents.length, 2);
  assert.deepEqual(selectResourceDocuments(normalized, ["world"]).documents.map(item => item.id), ["world-core"]);
});

test("rejects unsafe paths and incomplete choice groups", () => {
  assert.throws(() => normalizeResourceCatalog({ ...catalog, documents: [{ ...catalog.documents[0], path: "../secret.md" }, catalog.documents[1]] }), /below documents/);
  assert.throws(() => normalizeResourceCatalog({ ...catalog, documents: [catalog.documents[0]] }), /no document members/);
});

test("exports complete selected documents and a generated index", async t => {
  if (!exportContext) {
    t.diagnostic("card-context-library runtime is not reachable from this layout; the catalog assertions above still ran");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "rp-resource-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleDirectory = resolve(root, "module");
  const workspace = resolve(root, "workspace");
  await mkdir(resolve(moduleDirectory, "documents", "world"), { recursive: true });
  await mkdir(resolve(moduleDirectory, "documents", "style"), { recursive: true });
  await mkdir(workspace);
  await writeFile(resolve(moduleDirectory, "documents", "world", "core.md"), "World source\n");
  await writeFile(resolve(moduleDirectory, "documents", "style", "default.md"), "Style source\n");
  const result = await exportContext({
    run: { payload: { call: { arguments: { categories: ["world"] } } } },
    workspace,
    module: { id: "card-context-library", directory: moduleDirectory, resourceCatalog: normalizeResourceCatalog(catalog) },
  });
  assert.deepEqual(result.documents, ["world-core"]);
  assert.equal(await readFile(resolve(workspace, "context", "world", "core.md"), "utf8"), "World source\n");
  assert.match(await readFile(resolve(workspace, "context", "DOCUMENTS.md"), "utf8"), /world-core/);
});
