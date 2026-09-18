import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertLoadableSkill, parseSkillFrontmatterDescription } from "./rp-skill-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// `.pi/lib` sits at the repository root in the source tree, but the same file is read from
// `play/.pi/lib` after installation. Probe upward for the project-global module tree so this
// portability assertion runs in the source layout and skips (rather than fails) elsewhere.
async function findRepositoryRoot() {
  let candidate = here;
  for (let depth = 0; depth < 8; depth += 1) {
    const modules = await readdir(resolve(candidate, "global-modules"), { withFileTypes: true }).catch(() => []);
    if (modules.some(entry => entry.isDirectory())) return candidate;
    candidate = resolve(candidate, "..");
  }
  return null;
}

test("accepts a published Skill header and returns its single-line description", () => {
  const text = ["---", "name: local-scene-narrative", "description: Create one candidate story.", "---", "", "# Title", ""].join("\n");
  assert.equal(parseSkillFrontmatterDescription(text, "local-scene-narrative.skillFile"), "Create one candidate story.");
  assert.deepEqual(assertLoadableSkill(text, "local-scene-narrative.skillFile"), { name: "local-scene-narrative", description: "Create one candidate story." });
});

test("accepts quoted values and unknown optional fields", () => {
  const text = ["---", "name: memory", 'description: "Quoted description"', "license: MIT", "---", "body", ""].join("\n");
  assert.equal(parseSkillFrontmatterDescription(text, "memory.skillFile"), "Quoted description");
});

test("rejects a Skill without frontmatter, naming the file label", () => {
  // RC-01: the published local-scene-narrative Skill shipped a bare Markdown heading.
  assert.throws(
    () => parseSkillFrontmatterDescription("# 近场叙事模块\n\n本模块拥有主线当前地点及周边故事。\n", "local-scene-narrative.skillFile"),
    error => error instanceof Error && error.message === "local-scene-narrative.skillFile must start with YAML frontmatter.",
  );
});

test("rejects missing, empty, multi-line, and over-long descriptions", () => {
  assert.throws(() => parseSkillFrontmatterDescription("---\nname: memory\n---\nbody\n", "memory.skillFile"), /one-line description/);
  assert.throws(() => parseSkillFrontmatterDescription("---\nname: memory\ndescription:\n---\nbody\n", "memory.skillFile"), /one-line description/);
  assert.throws(() => parseSkillFrontmatterDescription("---\nname: memory\ndescription: |\n---\nbody\n", "memory.skillFile"), /one-line description/);
  assert.throws(
    () => parseSkillFrontmatterDescription(`---\nname: memory\ndescription: ${"x".repeat(1025)}\n---\nbody\n`, "memory.skillFile"),
    /at most 1024 characters/,
  );
});

test("rejects a missing name and an unclosed header", () => {
  assert.throws(() => parseSkillFrontmatterDescription("---\ndescription: A description.\n---\nbody\n", "memory.skillFile"), /one-line name/);
  assert.throws(() => parseSkillFrontmatterDescription("---\nname: memory\ndescription: A description.\nbody\n", "memory.skillFile"), /not closed/);
});

test("every published module Skill is loadable", async t => {
  const repositoryRoot = await findRepositoryRoot();
  if (!repositoryRoot) {
    t.diagnostic("project-global module tree is not present next to this runtime copy; skipped");
    return;
  }
  const shipped = [
    "global-modules/comfy-image-generation/skill/SKILL.md",
    "global-modules/local-scene-narrative/skill/SKILL.md",
    "global-modules/narrative-memory/skill/SKILL.md",
    "global-modules/world-narrative-coordinator/skill/SKILL.md",
    "global-modules/world-scope-narrative/skill/SKILL.md",
    ".agents/skills/st-card-to-pi-rp/assets/card-context-library/skill/SKILL.md",
  ];
  for (const relativePath of shipped) {
    const text = await readFile(resolve(repositoryRoot, relativePath), "utf8");
    const parsed = assertLoadableSkill(text, `${relativePath}.skillFile`);
    assert.ok(parsed.name.trim(), `${relativePath} declares a name`);
    assert.ok(parsed.description.trim(), `${relativePath} declares a description`);
  }
});
