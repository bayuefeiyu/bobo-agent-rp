import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { materializeAuthorSkill } from "./rp-card-text-files.mjs";

test("module skill and relative references are materialized per session", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-card-skill-"));
  t.after(async () => {
    const verified = await realpath(root);
    if (!verified.startsWith(`${resolve(tmpdir())}\\rp-card-skill-`)) throw new Error(`Unexpected test directory: ${verified}`);
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, "source");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "# {{user}}\nRead references/detail.md", "utf8");
  await writeFile(join(source, "references/detail.md"), "{{user}} and Seraphina", "utf8");
  for (const name of ["林舟", "阿岚"]) {
    const target = join(root, name);
    assert.equal(await materializeAuthorSkill(join(source, "SKILL.md"), target, name), resolve(target, "SKILL.md"));
    assert.equal(await readFile(join(target, "references/detail.md"), "utf8"), `${name} and Seraphina`);
  }
  await materializeAuthorSkill(join(source, "SKILL.md"), join(root, "林舟"), "改名后");
  assert.match(await readFile(join(root, "林舟", "SKILL.md"), "utf8"), /林舟/);
  assert.match(await readFile(join(source, "SKILL.md"), "utf8"), /{{user}}/);
});
