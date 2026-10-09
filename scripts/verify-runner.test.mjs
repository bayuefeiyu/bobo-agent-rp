import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

test("--sandbox-skips cannot turn a registered file's assertion failure into success", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-verify-negative-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["scripts/verify.mjs", "scripts/verification-suites.mjs", "scripts/verification-integration.mjs",
    "scripts/python-environments.mjs", "scripts/development-runtime.json",
    ".agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/validate-runtime-package.mjs"]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceRoot, path), target);
  }
  const failingFile = ".agents/skills/adapt-comfyui-workflow/scripts/workflow-tools.test.mjs";
  await mkdir(dirname(join(root, failingFile)), { recursive: true });
  await writeFile(join(root, failingFile), 'import test from "node:test"; import assert from "node:assert/strict"; test("real assertion failure", () => assert.equal(1, 2));');
  await assert.rejects(execute(process.execPath, [join(root, "scripts/verify.mjs"), "--suite=tools", "--sandbox-skips"], { cwd: root }), error => error.code === 1);
  const result = JSON.parse(await readFile(join(root, ".verify/results.json"), "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.summary.failedTestFiles, 1);
  assert.equal(result.summary.executedFiles, 1);
  assert.equal(result.summary.unexecutedFiles, 0);
  assert.equal(result.summary.fail, 1);
  const failure = result.results.find(item => item.label === failingFile);
  assert.equal(failure.failed, true);
  assert.equal(failure.sandboxDiagnostic, true);
});
