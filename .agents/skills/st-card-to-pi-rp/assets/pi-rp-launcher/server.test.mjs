import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanCards, startLauncher } from "./server.mjs";

test("browses cards without Pi and keeps recent history separate from chats", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-launcher-test-"));
  let launcher;
  try {
    const card = join(root, "cards", "demo");
    await mkdir(join(card, "runtime"), { recursive: true });
    await writeFile(join(card, "manifest.json"), JSON.stringify({ schema_version: 2, id: "demo", name: "Demo", description: "A test card" }));
    await writeFile(join(card, "runtime-lock.json"), JSON.stringify({ schemaVersion: 1, cardId: "demo" }));
    await writeFile(join(card, "runtime", "launch.json"), JSON.stringify({ schemaVersion: 1, cardId: "demo", entry: "runtime/entry.ts", skills: [] }));
    assert.equal((await scanCards(root))[0].launchable, true);
    launcher = await startLauncher({ playRoot: root, spawnPi: () => { throw new Error("Pi must not start while browsing."); } });
    const catalog = await fetch(new URL("/api/cards", launcher.url)).then(response => response.json());
    assert.equal(catalog.cards[0].name, "Demo");
    assert.deepEqual(catalog.recent, []);
    const html = await fetch(launcher.url).then(response => response.text());
    assert.match(html, /所有卡/);
    assert.match(html, /最近游玩/);
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
