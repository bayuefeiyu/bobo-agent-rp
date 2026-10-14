import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { scanCards, startLauncher } from "./server.mjs";

test("browses cards without Pi and keeps recent history separate from chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-launcher-test-"));
  let launcher;
  try {
    const card = join(root, "cards", "demo");
    await mkdir(join(card, "runtime"), { recursive: true });
    await writeFile(join(card, "manifest.json"), JSON.stringify({ schema_version: 2, id: "demo", name: "Demo", description: "A test card" }));
    await writeFile(join(card, "runtime-lock.json"), JSON.stringify({ schemaVersion: 2, cardId: "demo", packageFormat: 3 }));
    await writeFile(join(card, "runtime", "launch.json"), JSON.stringify({ schemaVersion: 2, webApiVersion: 1, cardId: "demo", entry: "runtime/entry.ts", skills: [] }));
    assert.equal((await scanCards(root))[0].launchable, true);
    launcher = await startLauncher({ playRoot: root, spawnPi: () => { throw new Error("Pi must not start while browsing."); } });
    const catalog = await fetch(new URL("/api/v1/cards", launcher.url)).then(response => response.json());
    assert.equal(catalog.data.cards[0].name, "Demo");
    assert.deepEqual(catalog.data.recent, []);
    const rootResponse = await fetch(launcher.url);
    const html = await rootResponse.text();
    assert.match(html, /所有卡/);
    assert.match(html, /最近游玩/);
    assert.doesNotMatch(html, /const token =/);
    const cookie = rootResponse.headers.get("set-cookie");
    assert.match(cookie, /^rp-launcher=[^;]+; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.deepEqual(await launcher.recentCards(), []);
    await mkdir(join(root, "launcher", "state"), { recursive: true });
    await writeFile(join(root, "launcher", "state", "recent-cards.json"), JSON.stringify({ schemaVersion: 1, cards: [null, { id: "demo", lastOpenedAt: 123 }, { id: "demo", lastOpenedAt: "2026-09-19T00:00:00.000Z" }, { id: "demo", lastOpenedAt: "2026-09-20T00:00:00.000Z" }] }));
    assert.deepEqual(await launcher.recentCards(), [{ id: "demo", lastOpenedAt: "2026-09-20T00:00:00.000Z" }]);
    await assert.rejects(launcher.launchCard("demo"), /invalid runtime dependencies/);
    assert.equal((await launcher.recentCards()).length, 1);
  } finally {
    if (launcher) await launcher.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function createLaunchableCard(root) {
  const card = join(root, "cards", "demo");
  const launch = { schemaVersion: 2, webApiVersion: 1, cardId: "demo", entry: "runtime/entry.ts", skills: [], engine: { name: "@earendil-works/pi-coding-agent", testedVersion: "0.86.0", testedNodeMajor: Number(process.versions.node.split(".")[0]) } };
  const frontend = {
    schemaVersion: 1,
    id: "official",
    version: "1.0.0",
    kind: "builtin",
    root: "public/gameplay/official",
    entry: "index.mjs",
    apiVersion: { major: 1, minor: 0 },
    hostVersion: { major: 1, minor: 0 },
    requiredCapabilities: ["get.state"],
    optionalCapabilities: [],
    assets: ["index.mjs"],
    immersive: false,
  };
  const files = {
    "manifest.json": JSON.stringify({ schema_version: 2, id: "demo", name: "Demo", feature_modules: [] }),
    "web/frontend.json": JSON.stringify(frontend),
    "web/public/index.html": "<!doctype html><title>Test frontend</title>\n",
    "web/public/gameplay/official/index.mjs": "// Builtin frontend placeholder; validation only.\n",
    "runtime/launch.json": JSON.stringify(launch),
    "runtime/entry.ts": "// Test extension\n",
    "runtime/packages/rp-web-server/index.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-server/static-host.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-server/card-store.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-contract/index.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-contract/operations.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-contract/operations.json": "{}\n",
    "runtime/packages/rp-web-contract/schemas.json": "{}\n",
    "runtime/packages/rp-web-contract/frontend.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-client/index.mjs": "// Test package placeholder\n",
    "runtime/packages/rp-web-client/presentation-host.mjs": "// Test package placeholder\n",
    "prompts/system/base.md": "Test prompt\n",
    "prompts/system/tools.json": "{}",
    "defaults/common.json": "{}",
    "defaults/workflow-runtime.json": "{}",
    "defaults/model-profiles.json": "{}",
  };
  const hashes = {};
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(card, file)), { recursive: true });
    await writeFile(join(card, file), content);
    hashes[file] = createHash("sha256").update(content).digest("hex");
  }
  await writeFile(join(card, "runtime-lock.json"), JSON.stringify({ schemaVersion: 2, cardId: "demo", packageFormat: 3, runtimeVersion: "2.0.0", launchProtocolVersion: 2, webApiVersion: 1, testedNodeVersion: process.versions.node, externalDependencies: [{ name: launch.engine.name, testedVersion: launch.engine.testedVersion }], files: hashes }));
}

for (const { version, exitCode = 0, error } of [
  { version: "0.86.0" },
  { version: "Pi 1.1.0" },
  { version: "unknown", error: /Could not read the installed Pi version/ },
  { version: "", exitCode: 1, error: /Pi version check exited with 1/ },
]) {
  test(`launch handles Pi version ${version || "check failure"}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "rp-launcher-version-test-"));
    const frontend = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: { busy: false, blockingWorkflows: [], activeWorkflowRuns: 0 }, requestId: "fixture-state" }));
    });
    let launcher, runtimeStarts = 0;
    const warningLog = [];
    t.mock.method(console, "warn", warning => warningLog.push(warning));
    try {
      await createLaunchableCard(root);
      await new Promise(resolve => frontend.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${frontend.address().port}/`;
      const spawnPi = (_command, args, options) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
        child.kill = () => child.emit("exit", 0);
        if (args.includes("--version")) {
          queueMicrotask(() => { child.stdout.write(version); child.emit("exit", exitCode); });
        } else {
          runtimeStarts++;
          child.stdin.on("data", chunk => {
            const request = JSON.parse(chunk.toString());
            if (request.id === "open-card") {
              writeFile(options.env.BOBO_RP_READY_FILE, JSON.stringify({ cardId: "demo", url })).catch(error => child.emit("error", error));
            } else if (request.id === "stop-card") {
              queueMicrotask(() => child.emit("exit", 0));
            }
          });
        }
        return child;
      };
      launcher = await startLauncher({ playRoot: root, spawnPi });
      const rootResponse = await fetch(launcher.url);
      const html = await rootResponse.text();
      assert.doesNotMatch(html, /const token =/);
      const cookie = rootResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.match(cookie, /^rp-launcher=[^;]+$/);
      const connectionResponse = await fetch(new URL("/api/v1/connection", launcher.url));
      const connectionEnvelope = await connectionResponse.json();
      assert.equal(connectionResponse.status, 200);
      assert.equal(connectionEnvelope.data.mode, "launcher");
      assert.deepEqual(connectionEnvelope.data.apiVersion, { major: 1, minor: 0 });
      assert.deepEqual(connectionEnvelope.data.hostVersion, { major: 1, minor: 0 });
      assert.equal(typeof connectionEnvelope.data.serverInstanceId, "string");
      assert.deepEqual(connectionEnvelope.data.readContext, { serverInstanceId: connectionEnvelope.data.serverInstanceId, cardId: null, chatId: null, executionId: null });
      const launchUrl = new URL("/api/v1/launch", launcher.url);
      launchUrl.searchParams.set("readContext", JSON.stringify(connectionEnvelope.data.readContext));
      const response = await fetch(launchUrl, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ cardId: "demo" }) });
      const result = await response.json();
      if (error) {
        assert.equal(response.status, 400);
        assert.match(result.error.message, error);
        assert.equal(runtimeStarts, 0);
        assert.deepEqual(warningLog, []);
      } else {
        assert.equal(response.status, 200);
        assert.equal(result.data.url, url);
        assert.equal(runtimeStarts, 1);
        if (version === "0.86.0") assert.deepEqual(result.data.warnings, []);
        else {
          assert.equal(result.data.warnings.length, 1);
          assert.match(result.data.warnings[0], /0\.86\.0.*1\.1\.0.*继续启动/);
        }
        assert.deepEqual(warningLog, result.data.warnings);
        assert.deepEqual((await launcher.launchCard("demo")).warnings, result.data.warnings);
        assert.equal(runtimeStarts, 1);
      }
    } finally {
      if (launcher) await launcher.close();
      if (frontend.listening) await new Promise(resolve => frontend.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
