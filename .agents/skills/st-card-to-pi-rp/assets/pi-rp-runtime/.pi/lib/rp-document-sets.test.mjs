import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { copyDocumentSet, copyWorkspaceEntry } from "./rp-document-sets.mjs";

test("copies explicitly selected workspace files and ordinary directories", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-workspace-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceFile = resolve(root, "plan.md");
  const sourceDirectory = resolve(root, "materials");
  await writeFile(sourceFile, "Plan\n");
  await mkdir(resolve(sourceDirectory, "nested"), { recursive: true });
  await writeFile(resolve(sourceDirectory, "nested", "note.txt"), "Note\n");
  assert.equal((await copyWorkspaceEntry(sourceFile, resolve(root, "received", "plan.md"))).kind, "file");
  assert.equal((await copyWorkspaceEntry(sourceDirectory, resolve(root, "received", "materials"))).kind, "directory");
  assert.equal(await readFile(resolve(root, "received", "plan.md"), "utf8"), "Plan\n");
  assert.equal(await readFile(resolve(root, "received", "materials", "nested", "note.txt"), "utf8"), "Note\n");
});

test("copies a document set recursively and accepts an identical retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-document-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  const destination = resolve(root, "destination");
  await mkdir(resolve(source, "world"), { recursive: true });
  await writeFile(resolve(source, "DOCUMENTS.md"), "# Index\n");
  await writeFile(resolve(source, "world", "core.md"), "World\n");
  await copyDocumentSet(source, destination);
  await copyDocumentSet(source, destination);
  assert.equal(await readFile(resolve(destination, "world", "core.md"), "utf8"), "World\n");
});

test("rejects collisions and symbolic links", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-document-set-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  const destination = resolve(root, "destination");
  await mkdir(source);
  await mkdir(destination);
  await writeFile(resolve(source, "DOCUMENTS.md"), "source\n");
  await writeFile(resolve(destination, "DOCUMENTS.md"), "other\n");
  await assert.rejects(() => copyDocumentSet(source, destination), /collision/);
  await rm(destination, { recursive: true, force: true });
  await writeFile(resolve(source, "target.md"), "target\n");
  await symlink(resolve(source, "target.md"), resolve(source, "link.md"));
  await assert.rejects(() => copyDocumentSet(source, destination), /symbolic links/);
});
