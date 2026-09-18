import { createHash } from "node:crypto";

/**
 * Seed range for a bound ComfyUI seed input.
 *
 * The bound node decides which seeds it accepts. The real defect behind RC-07 was a *derivation*
 * bug, not a rounding one: the runtime took 13 hex digits of a SHA-256 digest (~0..2^52-1) and a real
 * rgthree `Seed (rgthree)` node caps at 2^50, so roughly three attempts in four exceeded the node's
 * limit. ComfyUI accepted the queue entry, skipped the save branch, still reported
 * `status_str: "success"` because an unrelated text node ran, and the card recorded a failure with
 * no image.
 *
 * The range therefore comes from the profile — written by the adaptation step from the bound node's
 * own metadata, or filled in explicitly when that metadata is unavailable — and it is frozen into
 * the profile snapshot so a submitted attempt stays reproducible. Seeds remain deterministically
 * derived from `renderId` + `attemptNumber`; only the bucket they land in changes.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Legacy behaviour for profiles written before `seedRange` existed: an unbounded 52-bit seed. */
export const LEGACY_SEED_RANGE = Object.freeze({ min: 0, max: 2 ** 52 - 1, source: "legacy-13-hex-digits" });

/** The range frozen into a snapshot, or the documented legacy range for an older profile. */
export function effectiveSeedRange(profile) {
  const value = profile?.seedRange;
  if (value === undefined || value === null) return structuredClone(LEGACY_SEED_RANGE);
  return { min: value.min, max: value.max, source: value.source || "declared" };
}

/**
 * Validate one declared range.
 *
 * Both bounds must survive JSON and JavaScript exactly, so they are limited to `Number.MAX_SAFE_INTEGER`
 * — a bound beyond that is rounded on the way in, and a seed built from a rounded bound can silently
 * map outside the node's real limit all over again.
 */
export function normalizeSeedRange(value, label = "seedRange") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object with integer min and max.`);
  const unknown = Object.keys(value).filter(key => !["min", "max", "source"].includes(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
  const { min, max } = value;
  if (!Number.isSafeInteger(min) || min < 0) throw new Error(`${label}.min must be a non-negative safe integer.`);
  if (!Number.isSafeInteger(max) || max < 0) throw new Error(`${label}.max must be a non-negative safe integer.`);
  if (min > max) throw new Error(`${label}.min must not exceed ${label}.max.`);
  if (typeof value.source === "string" && value.source.length > 200) throw new Error(`${label}.source must be at most 200 characters.`);
  return { min, max, source: typeof value.source === "string" && value.source ? value.source : "declared" };
}

/**
 * Intersect the ranges of several seed bindings.
 *
 * One profile can write the same seed into several nodes. The seed the runtime picks has to be legal
 * for all of them, and an empty intersection means the profile cannot be executed at all — which must
 * fail before submission, not be discovered when the image never appears.
 */
export function intersectSeedRanges(ranges, label = "profile seed range") {
  if (!Array.isArray(ranges) || !ranges.length) throw new Error(`${label} requires at least one declared range.`);
  const normalized = ranges.map((range, index) => normalizeSeedRange(range, `${label}[${index}]`));
  const min = Math.max(...normalized.map(range => range.min));
  const max = Math.min(...normalized.map(range => range.max));
  if (min > max) throw new Error(`${label} has an empty intersection: no seed is valid for every bound node.`);
  const sources = [...new Set(normalized.map(range => range.source))];
  return { min, max, source: sources.length === 1 ? sources[0] : `intersection(${sources.join(" + ")})` };
}

/**
 * Derive the seed for one attempt inside a frozen range.
 *
 * Deterministic in `renderId` + `attemptNumber`, so a resumed or retried attempt replays the exact
 * seed and `promptId` the earlier submission used. The modulo has a negligible bias at these spans
 * and is the only mapping that stays exact in double precision.
 */
export function deriveSeed(renderId, attemptNumber, range) {
  if (typeof renderId !== "string" || !renderId) throw new Error("A seed requires the render id.");
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("A seed requires a positive attempt number.");
  const effective = range ? normalizeSeedRange(range, "seed range") : LEGACY_SEED_RANGE;
  const span = BigInt(effective.max) - BigInt(effective.min) + 1n;
  const digest = createHash("sha256").update(`${renderId}:seed:${attemptNumber}`).digest("hex").slice(0, 16);
  const offset = BigInt(`0x${digest}`) % span;
  const seed = BigInt(effective.min) + offset;
  if (seed > BigInt(MAX_SAFE)) throw new Error("Derived seed exceeds the exactly representable integer range.");
  return Number(seed);
}

/** Human-readable range, for diagnostics and records. */
export function seedRangeLabel(range) {
  const effective = range || LEGACY_SEED_RANGE;
  return `${effective.min}..${effective.max}`;
}
