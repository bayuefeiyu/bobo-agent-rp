import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assistantFailureReason, describeTurnFailureReason, isToolSchemaRejection, narrativeOutputUnavailableError, noTextOutputError } from "./rp-model-failures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(here, "rp-workflow-engine.mjs");

test("a real provider failure keeps its stopReason and message", () => {
  // RC-02: the actual provider answer was an HTTP 400 naming the malformed tool schema. It used to
  // reach the user as "Workflow agent returned no text output. 0 tokens".
  const message = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "Invalid schema for function 'rp_data_query': schema must be a JSON Schema of 'type: \"object\"', got 'type: null'.",
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const reason = assistantFailureReason(message);
  assert.match(reason, /^stopReason=error: /);
  assert.match(reason, /Invalid schema for function 'rp_data_query'/);
  const error = noTextOutputError({ message, label: "Workflow agent director-future" });
  assert.match(error.message, /Workflow agent director-future returned no text output \(stopReason=error: /);
  assert.match(error.message, /Invalid schema for function/);
  assert.match(error.message, /instead of switching models/);
  assert.equal(error.code, "tool_schema_invalid");
});

test("rate limits, network faults, and plain empty answers stay unclassified", () => {
  const rateLimited = { role: "assistant", content: [], stopReason: "error", errorMessage: "429 Too Many Requests: rate limit exceeded" };
  const reason = assistantFailureReason(rateLimited);
  assert.equal(isToolSchemaRejection(reason), false, "a rate limit is not a schema fault");
  const error = noTextOutputError({ message: rateLimited });
  assert.equal(error.code, undefined, "no deterministic code is invented for an unrecognised provider error");
  assert.match(error.message, /429 Too Many Requests/);

  const network = { role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed: ECONNRESET" };
  assert.equal(noTextOutputError({ message: network }).code, undefined);

  // A model that simply answered with nothing keeps the original short wording.
  assert.equal(assistantFailureReason({ role: "assistant", content: [], stopReason: "stop" }), null);
  assert.equal(noTextOutputError({ message: { role: "assistant", content: [], stopReason: "stop" }, label: "Workflow agent review" }).message, "Workflow agent review returned no text output.");
  assert.equal(noTextOutputError({ message: null, label: "Workflow agent review" }).message, "Workflow agent review returned no text output.");
});

test("truncation and abort are still reported with their own reason", () => {
  assert.equal(assistantFailureReason({ role: "assistant", content: [], stopReason: "length" }), "stopReason=length");
  assert.match(assistantFailureReason({ role: "assistant", content: [], stopReason: "aborted" }), /aborted/);
  assert.equal(assistantFailureReason({ role: "user", content: [] }), null, "only assistant turns describe a model failure");
});

test("the engine treats a rejected tool schema as configuration, not model output", async () => {
  const source = await readFile(enginePath, "utf8");
  const block = /const DETERMINISTIC_FAILURE_CODES = new Set\(\[([\s\S]*?)\]\);/.exec(source);
  assert.ok(block, "the engine declares its deterministic failure codes");
  const codes = [...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
  assert.ok(codes.includes("tool_schema_invalid"), "tool_schema_invalid is deterministic");
  assert.equal(codes.includes("data_schema_invalid"), false, "model-rendered data stays on the model retry path");
});

test("an unpublished narrative is reported as a node failure, not a missing file", () => {
  const error = narrativeOutputUnavailableError({
    nodeId: "finalize-turn",
    sourceNodeId: "write-narrative",
    outputId: "narrative",
    sourceState: { id: "write-narrative", status: "failed", error: "Workflow agent narrative-writer returned no text output (stopReason=error: 429)." },
  });
  assert.match(error.message, /finalize-turn cannot publish the narrative from write-narrative\/narrative/);
  assert.match(error.message, /write-narrative is failed \(Workflow agent narrative-writer returned no text output/);
  assert.equal(/ENOENT/.test(error.message), false, "a filesystem error never reaches the player as the cause");
  const neverRan = narrativeOutputUnavailableError({ nodeId: "finalize-turn", sourceNodeId: "write-narrative", outputId: "narrative", sourceState: undefined });
  assert.match(neverRan.message, /write-narrative is pending/);
});

test("a turn that ended without prose names the node the player has to look at", () => {
  // The narrative node itself failed: report that node and its error.
  assert.equal(
    describeTurnFailureReason({ status: "failed", nodes: { "write-narrative": { id: "write-narrative", status: "failed", error: "429 Too Many Requests" } } }, false),
    "write-narrative：429 Too Many Requests",
  );
  // An upstream dependency failed and the narrative node is only unreachable.
  assert.match(
    describeTurnFailureReason({ status: "completed", nodes: { "prepare-recent-narrative-stories": { id: "prepare-recent-narrative-stories", status: "failed", error: "Query condition sourceTurn must contain exactly one operator." }, "write-narrative": { id: "write-narrative", status: "skipped", error: "dependency_unavailable" } } }, false),
    /^prepare-recent-narrative-stories：Query condition sourceTurn/,
  );
  // A completed run with no prose keeps the existing message.
  assert.equal(describeTurnFailureReason({ status: "completed", nodes: {} }, false), "回合收尾节点未发布正文");
  // Nothing identifiable still reports the run status rather than throwing.
  assert.equal(describeTurnFailureReason({ status: "cancelled", nodes: {} }, false), "工作流以 cancelled 结束");
});
