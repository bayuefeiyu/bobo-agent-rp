import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildRuntimePackageFixture } from "./verification-integration.mjs";
import { installPlayFrontend, recoverFrontendInstall } from "./install-play-frontend.mjs";
import { validateRuntimePackage } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/validate-runtime-package.mjs";

test("gameplay installation keeps platform bytes, refuses bad inventories and restores a compatible frontend", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "rp-frontend-install-")); t.after(() => rm(root, { recursive: true, force: true }));
  const card = resolve(root, "card"), pack = resolve(root, "pack");
  buildRuntimePackageFixture(card, { engineName: "@earendil-works/pi-coding-agent", engineVersion: "0.86.0" });
  const original = await readFile(resolve(card, "web/frontend.json"), "utf8"), platform = await readFile(resolve(card, "web/public/index.html"));
  await cp(resolve("examples/minimal-rp-frontend"), pack, { recursive: true });
  const installed = await installPlayFrontend({ cardDirectory: card, packageDirectory: pack });
  assert.equal(installed.frontendId, "story-stage"); assert.equal(installed.restartRequired, true);
  assert.deepEqual(await readFile(resolve(card, "web/public/index.html")), platform);
  assert.equal((await validateRuntimePackage(card)).ok, true);
  await assert.rejects(installPlayFrontend({ cardDirectory: card, packageDirectory: pack }), /--replace/);
  const descriptor = JSON.parse(await readFile(resolve(pack, "frontend.json"), "utf8")); descriptor.assets.push("missing.png");
  await writeFile(resolve(pack, "frontend.json"), JSON.stringify(descriptor));
  await assert.rejects(installPlayFrontend({ cardDirectory: card, packageDirectory: pack, replace: true }), /inventory/);
  assert.equal((await validateRuntimePackage(card)).ok, true);
  const unavailable = { ...descriptor, assets: descriptor.assets.filter(asset => asset !== "missing.png"), requiredCapabilities: ["unknown-capability"] };
  await writeFile(resolve(pack, "frontend.json"), JSON.stringify(unavailable));
  await assert.rejects(installPlayFrontend({ cardDirectory: card, packageDirectory: pack, replace: true }), /Unknown required/);
  await installPlayFrontend({ cardDirectory: card, restore: installed.backupId, replace: true });
  assert.deepEqual(JSON.parse(await readFile(resolve(card, "web/frontend.json"), "utf8")), JSON.parse(original));
  assert.equal((await validateRuntimePackage(card)).ok, true);
  const backup = installed.backupId;
  await writeFile(resolve(card, ".frontend-backups/pending.json"), JSON.stringify({ backupId: backup, newRoot: null }));
  assert.equal((await validateRuntimePackage(card)).ok, false);
  // The saved complete baseline does not reference the staged/installed pack; simulate a crash
  // with a journal that records the installed directory so recovery removes only that directory.
  const lock = JSON.parse(await readFile(resolve(card, "runtime-lock.json"), "utf8"));
  const installedFile = Object.keys(lock.files).find(path => path.startsWith("web/frontends/"));
  const installedRoot = installedFile.slice("web/".length, installedFile.lastIndexOf("/"));
  await writeFile(resolve(card, ".frontend-backups/pending.json"), JSON.stringify({ backupId: backup, newRoot: installedRoot }));
  assert.equal((await recoverFrontendInstall(card)).ok, true);
  await writeFile(resolve(card, "runtime-lock.json"), JSON.stringify({ ...lock, schemaVersion: 1, packageFormat: 2 }));
  assert.equal((await validateRuntimePackage(card)).ok, false);
});
