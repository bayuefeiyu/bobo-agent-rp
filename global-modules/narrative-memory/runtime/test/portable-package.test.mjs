import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runtimeTestLibrary } from "./runtime-test-runtime.mjs";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("a copied card module runs its package test against play/.pi/lib", async t => {
  const fixture = await mkdtemp(join(tmpdir(), "narrative-memory-card-layout-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  const copiedModule = resolve(fixture, "play", "cards", "fixture", "features", "narrative-memory");
  const copiedRuntime = resolve(fixture, "play", ".pi", "lib");
  await mkdir(dirname(copiedModule), { recursive: true });
  await mkdir(dirname(copiedRuntime), { recursive: true });
  await cp(moduleRoot, copiedModule, { recursive: true });
  await cp(runtimeTestLibrary, copiedRuntime, { recursive: true });

  const environment = { ...process.env };
  delete environment.PI_RP_RUNTIME_LIB;
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", resolve(copiedModule, "runtime", "test", "package.test.mjs")], {
    cwd: fixture,
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 7/);
  assert.match(result.stdout, /fail 0/);
});
