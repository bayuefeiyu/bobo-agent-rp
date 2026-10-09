import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAcyclic, importGraph } from "./verification-acceptance.mjs";

test("structure gate detects value cycles and ignores type-only imports", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-import-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.ts"), 'import type { B } from "./b.ts"; export const A = 1;');
  await writeFile(join(root, "b.ts"), 'import { A } from "./a.ts?v=4"; export type B = string;');
  assert.doesNotThrow(() => assertAcyclic(importGraph(root)));
  await writeFile(join(root, "a.ts"), 'import "./b.ts"; export const A = 1;');
  assert.throws(() => assertAcyclic(importGraph(root)), /dependency cycle/);
});

test("Python gate includes delayed imports and rejects unresolved local imports", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-validation-graph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "a.py"), 'def action():\n    from .b import value\n');
  await writeFile(join(root, "b.py"), 'from .a import action\n');
  assert.throws(() => assertAcyclic(importGraph(root, "python")), /dependency cycle/);
  await writeFile(join(root, "b.py"), 'from .missing import value\n');
  assert.throws(() => importGraph(root, "python"), /Unresolved validation import/);
});
