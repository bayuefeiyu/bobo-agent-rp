import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { createRpRandomService, executeRoll, normalizeRollRequest } from "./rp-random.mjs";

test("rolls structured dice groups and applies a modifier", () => {
  const values = [4, 6, 2];
  const result = executeRoll({ key: "check", dice: [{ count: 2, sides: 6 }, { count: 1, sides: 4 }], modifier: 3, reason: "test" }, {
    randomInteger: () => values.shift(),
  });
  assert.deepEqual(result, {
    key: "check",
    dice: [
      { count: 2, sides: 6, results: [4, 6], subtotal: 10 },
      { count: 1, sides: 4, results: [2], subtotal: 2 },
    ],
    modifier: 3,
    total: 15,
    reason: "test",
  });
});

test("rejects unsafe or excessive roll requests", () => {
  assert.throws(() => normalizeRollRequest({ key: "../escape", dice: [{ count: 1, sides: 6 }] }), /filesystem-safe/);
  assert.throws(() => normalizeRollRequest({ key: "many", dice: [{ count: 60, sides: 6 }, { count: 41, sides: 6 }] }), /at most 100 dice/);
  assert.throws(() => normalizeRollRequest({ key: "coin", dice: [{ count: 1, sides: 1 }] }), /from 2/);
});

test("persists one result per run, node, and key and replays it on retry", async () => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-random-"));
  let calls = 0;
  const service = createRpRandomService({
    sessionDirectory,
    workflowId: "standard-rp",
    workflowRunId: "run-1",
    nodeId: "judge",
    caller: { kind: "code", id: "judge" },
    randomInteger: () => (++calls === 1 ? 5 : 1),
    now: () => "2026-09-10T00:00:00.000Z",
    uuid: () => "roll-1",
  });
  const request = { key: "lockpick", dice: [{ count: 1, sides: 20 }], modifier: 4, reason: "Lockpick" };
  assert.deepEqual(await service.roll(request), {
    key: "lockpick",
    dice: [{ count: 1, sides: 20, results: [5], subtotal: 5 }],
    modifier: 4,
    total: 9,
    reason: "Lockpick",
    rollId: "roll-1",
    createdAt: "2026-09-10T00:00:00.000Z",
    replayed: false,
  });
  assert.equal((await service.roll(request)).replayed, true);
  assert.equal(calls, 1);
  const record = JSON.parse(await readFile(resolve(sessionDirectory, "workflow", "random", "run-1", "judge", "lockpick.json"), "utf8"));
  assert.equal(record.rollId, "roll-1");
  assert.deepEqual(record.caller, { kind: "code", id: "judge" });
  await assert.rejects(service.roll({ ...request, modifier: 5 }), /different parameters/);
});
