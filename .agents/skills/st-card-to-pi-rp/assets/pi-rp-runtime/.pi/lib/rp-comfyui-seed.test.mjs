import assert from "node:assert/strict";
import test from "node:test";

import { deriveSeed, effectiveSeedRange, intersectSeedRanges, LEGACY_SEED_RANGE, normalizeSeedRange, seedRangeLabel } from "./rp-comfyui-seed.mjs";

/**
 * RC-07: the runtime derived a seed by taking 13 hex digits of a SHA-256 digest (~0..2^52-1) while a
 * real `Seed (rgthree)` node caps at 2^50 (= 1125899906842624). ComfyUI accepted the queue entry,
 * skipped the save branch, and still reported `status_str: "success"` because an unrelated text node
 * ran, so the card recorded a failure with no image. Roughly three attempts in four landed above the
 * node's limit.
 */

const RGTHREE_LIMIT = 1125899906842624;

test("the shipped rgthree limit is inside the exactly representable range", () => {
  assert.equal(Number.isSafeInteger(RGTHREE_LIMIT), true);
  assert.equal(RGTHREE_LIMIT, 2 ** 50);
  assert.equal(JSON.parse(JSON.stringify(RGTHREE_LIMIT)), RGTHREE_LIMIT);
});

test("a declared range is validated instead of trusted", () => {
  assert.deepEqual(normalizeSeedRange({ min: 0, max: RGTHREE_LIMIT, source: "node 720" }), { min: 0, max: RGTHREE_LIMIT, source: "node 720" });
  assert.throws(() => normalizeSeedRange({ min: 5, max: 1 }), /min must not exceed/);
  assert.throws(() => normalizeSeedRange({ min: -1, max: 5 }), /non-negative safe integer/);
  assert.throws(() => normalizeSeedRange({ min: 0, max: 2 ** 53 }), /non-negative safe integer/);
  assert.throws(() => normalizeSeedRange({ min: 0, max: 1, extra: true }), /unsupported fields/);
  assert.throws(() => normalizeSeedRange(null), /must be an object/);
});

test("a profile written before the field existed is reported as unverified, not as valid", () => {
  const legacy = effectiveSeedRange({ id: "old" });
  assert.deepEqual(legacy, LEGACY_SEED_RANGE);
  assert.equal(legacy.max, 2 ** 52 - 1);
  assert.equal(legacy.source, "legacy-13-hex-digits");
  const declared = effectiveSeedRange({ seedRange: { min: 0, max: RGTHREE_LIMIT } });
  assert.equal(declared.max, RGTHREE_LIMIT);
});

test("every derived seed stays inside the frozen range", () => {
  const range = { min: 0, max: RGTHREE_LIMIT, source: "test" };
  for (let attempt = 1; attempt <= 200; attempt += 1) {
    const seed = deriveSeed("render-abcdef", attempt, range);
    assert.equal(Number.isSafeInteger(seed), true);
    assert.ok(seed >= range.min && seed <= range.max, `attempt ${attempt} produced ${seed}`);
  }
  // The failing real seed from RC-07 is now impossible: the same render/attempt maps into the range.
  const before = Number.parseInt("f2f4f8a1c3d0e", 16);
  assert.ok(before > RGTHREE_LIMIT, "the historical legacy seed really did exceed the node limit");
  assert.ok(deriveSeed("render-abcdef", 1, range) <= RGTHREE_LIMIT);
});

test("derivation is deterministic per render and attempt", () => {
  const range = { min: 0, max: RGTHREE_LIMIT };
  assert.equal(deriveSeed("render-1", 1, range), deriveSeed("render-1", 1, range), "a retried attempt replays the persisted seed");
  assert.notEqual(deriveSeed("render-1", 1, range), deriveSeed("render-1", 2, range));
  assert.notEqual(deriveSeed("render-1", 1, range), deriveSeed("render-2", 1, range));
  assert.throws(() => deriveSeed("", 1, range), /requires the render id/);
  assert.throws(() => deriveSeed("render-1", 0, range), /positive attempt number/);
});

test("a non-zero minimum is honoured", () => {
  const range = { min: 1000, max: 1005 };
  const seen = new Set();
  for (let attempt = 1; attempt <= 50; attempt += 1) seen.add(deriveSeed("render-xyz", attempt, range));
  for (const seed of seen) assert.ok(seed >= 1000 && seed <= 1005, `${seed} outside the declared range`);
  assert.ok(seen.size > 1, "the range is actually used, not pinned to one value");
});

test("multiple seed bindings intersect, and an empty intersection fails before submission", () => {
  assert.deepEqual(
    intersectSeedRanges([{ min: 0, max: 1000, source: "a" }, { min: 500, max: RGTHREE_LIMIT, source: "b" }]),
    { min: 500, max: 1000, source: "intersection(a + b)" },
  );
  assert.throws(
    () => intersectSeedRanges([{ min: 0, max: 100, source: "a" }, { min: 200, max: 300, source: "b" }]),
    /empty intersection/,
  );
  assert.throws(() => intersectSeedRanges([]), /requires at least one declared range/);
  assert.equal(seedRangeLabel({ min: 0, max: RGTHREE_LIMIT }), `0..${RGTHREE_LIMIT}`);
});
