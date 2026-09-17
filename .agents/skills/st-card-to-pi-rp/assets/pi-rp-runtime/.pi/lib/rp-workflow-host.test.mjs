import assert from "node:assert/strict";
import test from "node:test";

import { withTerminalForegroundRelease } from "./rp-workflow-host.mjs";

test("terminal foreground release runs even when host persistence fails", async () => {
  let released = 0;
  await assert.rejects(
    () => withTerminalForegroundRelease(
      { status: "failed" },
      { kind: "foreground" },
      async () => { throw new Error("persistence unavailable"); },
      () => { released += 1; },
    ),
    /persistence unavailable/,
  );
  assert.equal(released, 1);
});

test("nonterminal and background changes do not release foreground occupation", async () => {
  let released = 0;
  await withTerminalForegroundRelease({ status: "running" }, { kind: "foreground" }, async () => {}, () => { released += 1; });
  await withTerminalForegroundRelease({ status: "failed" }, { kind: "turn-background" }, async () => {}, () => { released += 1; });
  assert.equal(released, 0);
});
