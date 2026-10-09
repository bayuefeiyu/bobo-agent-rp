import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../../../..");
const script = resolve(import.meta.dirname, "sync_template_assets.mjs");

test("template verification detects edited generated copies and duplicate Agent owners", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "rp-template-sources-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const directory of ["global-modules", ".agents/skills/create-pi-rp-feature-module/assets"]) {
    await cp(resolve(root, directory), resolve(fixture, directory), { recursive: true });
  }
  await execute(process.execPath, [script, "--root", fixture, "--check"]);
  const source = resolve(fixture, ".agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime/data.mjs");
  const generated = resolve(fixture, "global-modules/local-scene-narrative/runtime/lib/data.mjs");
  const original = await readFile(source, "utf8");
  await writeFile(generated, "export const accidentalEdit = true;\n");
  await assert.rejects(execute(process.execPath, [script, "--root", fixture, "--check"]), /stale/);
  await execute(process.execPath, [script, "--root", fixture]);
  assert.equal(await readFile(generated, "utf8"), original);
  assert.equal(await readFile(source, "utf8"), original);
  const agent = resolve(fixture, "global-modules/comfy-image-generation/agents/image-prompt-writer");
  const duplicate = resolve(fixture, "global-modules/comfy-image-generation/agents/image-prompt-writer-duplicate");
  await cp(agent, duplicate, { recursive: true });
  const duplicateDefinition = JSON.parse(await readFile(resolve(duplicate, "agent.json"), "utf8"));
  duplicateDefinition.promptFile = "prompts/agents/image-prompt-writer.md";
  await writeFile(resolve(duplicate, "agent.json"), `${JSON.stringify(duplicateDefinition, null, 2)}\n`);
  const manifestPath = resolve(fixture, "global-modules/comfy-image-generation/module.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.agentFiles.push("agents/image-prompt-writer-duplicate/agent.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(execute(process.execPath, [script, "--root", fixture, "--check"]), /multiple template owners/);
});
