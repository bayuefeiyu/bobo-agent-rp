import assert from "node:assert/strict";
import test from "node:test";

import { extractJsonCandidates, parseAgentJson } from "./rp-agent-output.mjs";

/**
 * The opening director failed every attempt with "must return valid JSON" while its reply was a
 * perfectly usable object preceded by one sentence of preamble and wrapped in a ```json fence. The
 * old check accepted only a reply that started with JSON, so the node died and the card could not be
 * played at all — and the error did not quote the reply, so the cause was invisible in the field log.
 */
test("a JSON reply wrapped in prose and a fence is accepted", () => {
  const reply = [
    "I have completed the full review of the module Skill and the private directory.",
    "This is `phase=opening`: initialise plans, guidance and run state only.",
    "",
    "```json",
    '{ "changes": { "operations": [] }, "delegations": { "local": null, "world": null } }',
    "```",
    "",
    "No delegations were started this phase.",
  ].join("\n");
  const parsed = parseAgentJson(reply);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source, "fenced-block");
  assert.deepEqual(parsed.value, { changes: { operations: [] }, delegations: { local: null, world: null } });
});

test("a bare JSON reply, a fenced reply, and a prefixed reply all parse", () => {
  assert.deepEqual(parseAgentJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(parseAgentJson('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(parseAgentJson('Here it is: {"a":1}').value, { a: 1 });
  assert.deepEqual(parseAgentJson('Here it is: {"a":{"b":[1,2]}} done.').value, { a: { b: [1, 2] } });
  assert.deepEqual(parseAgentJson('```\n[1,2,3]\n```').value, [1, 2, 3]);
  assert.equal(parseAgentJson('{"a":1} trailing note').ok, true, "a trailing note does not break the value");
});

test("a reply with no JSON value is reported with its opening text", () => {
  const parsed = parseAgentJson("I could not complete the review because the directory was empty.");
  assert.equal(parsed.ok, false);
  assert.match(parsed.preview, /^I could not complete the review/);
  assert.ok(parsed.characters > 0);
  assert.ok(parsed.preview.length <= 400);
});

test("malformed JSON is a failure, and braces inside strings do not confuse the scan", () => {
  const broken = parseAgentJson('{"a": }');
  assert.equal(broken.ok, false, "a broken object is not silently repaired");
  assert.equal(parseAgentJson('note {"a":"}"} done').ok, true, "a brace inside a string is not a delimiter");
  assert.equal(parseAgentJson('note {"a":"\\""} done').ok, true, "an escaped quote is handled");
  assert.equal(parseAgentJson("no json here").ok, false);
  assert.equal(parseAgentJson("").ok, false);
  assert.equal(parseAgentJson(null).ok, false);
});

test("candidates are ordered and deduplicated", () => {
  const candidates = extractJsonCandidates('word {"a":1} word');
  assert.deepEqual(candidates.map(candidate => candidate.source), ["whole-reply", "balanced-value"]);
  // The fenced block *is* the only balanced value here, so it is offered once.
  assert.deepEqual(extractJsonCandidates('```json\n{"a":1}\n```').map(candidate => candidate.source), ["whole-reply", "fenced-block"]);
  assert.deepEqual(extractJsonCandidates("nothing").map(candidate => candidate.source), ["whole-reply"]);
});
