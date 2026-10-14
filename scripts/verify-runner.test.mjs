import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await cp(join(sourceRoot, ".agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/packages/rp-web-contract"), join(root, ".agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/packages/rp-web-contract"), { recursive: true });
  const failingFile = ".agents/skills/adapt-comfyui-workflow/scripts/workflow-tools.test.mjs";
  await mkdir(dirname(join(root, failingFile)), { recursive: true });
  await writeFile(join(root, failingFile), 'import test from "node:test"; import assert from "node:assert/strict"; test("real assertion failure", () => assert.equal(1, 2));');
  await assert.rejects(execute(process.execPath, [join(root, "scripts/verify.mjs"), "--suite=tools", "--sandbox-skips"], { cwd: root }), error => error.code === 1);
  const result = JSON.parse(await readFile(join(root, ".verify/results.json"), "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.summary.failedTestFiles, 1);
  assert.equal(result.summary.executedFiles, 1);
  assert.equal(result.summary.unexecutedFiles, 0);
  assert.equal(result.summary.fail, 1, JSON.stringify(result.results));
  const failure = result.results.find(item => item.label === failingFile);
  assert.equal(failure.failed, true);
  assert.equal(failure.sandboxDiagnostic, true);
});

test("Pi version differences warn without hiding failed checks or a missing host", async t => {
  const root = await mkdtemp(join(tmpdir(), "rp-verify-pi-warning-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["scripts/verify.mjs", "scripts/verification-suites.mjs", "scripts/python-environments.mjs", "scripts/development-runtime.json"]) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceRoot, path), target);
  }
  // Isolate the runner's verdict policy from the real esbuild installation and card contents.
  await writeFile(join(root, "scripts/verification-integration.mjs"), `
    export function checkPiExtensionTranspile() { const ok = process.env.RP_VERIFY_TEST_FAIL !== "1"; return { id: "integration:pi-extension-transpile", kind: "check", ok, failed: !ok, durationMs: 0, detail: "isolated integration fixture" }; }
    export async function checkRuntimePackageFixture() { return { id: "integration:runtime-package-fixture", kind: "check", ok: true, durationMs: 0 }; }
  `);
  const piHome = join(root, "pi-host"), packagePath = join(piHome, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  await mkdir(dirname(packagePath), { recursive: true });
  await writeFile(packagePath, JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "99.0.0" }));
  const args = [join(root, "scripts/verify.mjs"), "--mode=integration"];
  const env = { ...process.env, VERIFY_PI_HOME: piHome };
  const readResult = async () => JSON.parse(await readFile(join(root, ".verify/results.json"), "utf8"));
  const { stdout } = await execute(process.execPath, args, { cwd: root, env });
  assert.match(stdout, /环境提示（不拦截）/);
  assert.match(stdout, /99\.0\.0/);
  let result = await readResult();
  assert.equal(result.ok, true);
  assert.equal(result.summary.failedEnvironmentChecks, 0);
  assert.equal(result.summary.environmentWarnings, 1);
  assert.equal(result.results.find(item => item.id === "env:pi-version").warning, true);
  await assert.rejects(execute(process.execPath, args, { cwd: root, env: { ...env, RP_VERIFY_TEST_FAIL: "1" } }), error => error.code === 1);
  result = await readResult();
  assert.equal(result.ok, false);
  assert.equal(result.summary.failedChecks, 1);
  await rm(join(piHome, "node_modules"), { recursive: true, force: true });
  await assert.rejects(execute(process.execPath, args, { cwd: root, env }), error => error.code === 1);
  result = await readResult();
  assert.equal(result.ok, false);
  assert.equal(result.results.find(item => item.id === "env:pi-host").ok, false);
});
