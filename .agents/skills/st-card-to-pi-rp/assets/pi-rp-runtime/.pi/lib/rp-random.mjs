import { randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_GROUPS = 10;
const MAX_DICE = 100;
const MAX_SIDES = 1_000_000;
const MAX_MODIFIER = 1_000_000_000;

function integer(value, label, { minimum, maximum }) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function normalizeRollRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Roll request must be an object.");
  const unknown = Object.keys(value).filter(key => !["key", "dice", "modifier", "reason"].includes(key));
  if (unknown.length) throw new Error(`Roll request contains unsupported fields: ${unknown.join(", ")}.`);
  if (typeof value.key !== "string" || !KEY_PATTERN.test(value.key)) {
    throw new Error("Roll key must be a filesystem-safe ID of at most 128 characters.");
  }
  if (!Array.isArray(value.dice) || value.dice.length < 1 || value.dice.length > MAX_GROUPS) {
    throw new Error(`Roll dice must contain from 1 to ${MAX_GROUPS} groups.`);
  }
  let totalDice = 0;
  const dice = value.dice.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Roll dice[${index}] must be an object.`);
    const groupUnknown = Object.keys(raw).filter(key => !["count", "sides"].includes(key));
    if (groupUnknown.length) throw new Error(`Roll dice[${index}] contains unsupported fields: ${groupUnknown.join(", ")}.`);
    const count = integer(raw.count, `Roll dice[${index}].count`, { minimum: 1, maximum: MAX_DICE });
    const sides = integer(raw.sides, `Roll dice[${index}].sides`, { minimum: 2, maximum: MAX_SIDES });
    totalDice += count;
    return { count, sides };
  });
  if (totalDice > MAX_DICE) throw new Error(`A roll may contain at most ${MAX_DICE} dice in total.`);
  const modifier = integer(value.modifier ?? 0, "Roll modifier", { minimum: -MAX_MODIFIER, maximum: MAX_MODIFIER });
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 500)) {
    throw new Error("Roll reason must be a string of at most 500 characters.");
  }
  return { key: value.key, dice, modifier, reason: value.reason?.trim() || "" };
}

export function executeRoll(request, options = {}) {
  const normalized = normalizeRollRequest(request);
  const randomInteger = options.randomInteger || randomInt;
  const dice = normalized.dice.map(group => {
    const results = Array.from({ length: group.count }, () => {
      const result = randomInteger(1, group.sides + 1);
      if (!Number.isSafeInteger(result) || result < 1 || result > group.sides) throw new Error("Random source returned an out-of-range die result.");
      return result;
    });
    return { ...group, results, subtotal: results.reduce((sum, result) => sum + result, 0) };
  });
  return {
    key: normalized.key,
    dice,
    modifier: normalized.modifier,
    total: dice.reduce((sum, group) => sum + group.subtotal, normalized.modifier),
    reason: normalized.reason,
  };
}

export function createRpRandomService({ sessionDirectory, workflowId, workflowRunId, nodeId, caller, randomInteger = randomInt, now = () => new Date().toISOString(), uuid = randomUUID }) {
  for (const [label, value] of Object.entries({ workflowId, workflowRunId, nodeId })) {
    if (typeof value !== "string" || !KEY_PATTERN.test(value)) throw new Error(`Random service ${label} must be a filesystem-safe ID.`);
  }
  if (!sessionDirectory || typeof sessionDirectory !== "string") throw new Error("Random service requires a session directory.");
  if (!caller || !["agent", "code"].includes(caller.kind) || typeof caller.id !== "string" || !caller.id) {
    throw new Error("Random service requires an agent or code caller.");
  }
  const directory = resolve(sessionDirectory, "workflow", "random", workflowRunId, nodeId);

  return Object.freeze({
    async roll(request) {
      const normalized = normalizeRollRequest(request);
      const path = resolve(directory, `${normalized.key}.json`);
      const existing = await readFile(path, "utf8").then(JSON.parse).catch(error => {
        if (error?.code !== "ENOENT") throw error;
        return null;
      });
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(normalized)) throw new Error(`Roll key ${normalized.key} was already used with different parameters.`);
        return { ...existing.result, replayed: true };
      }

      const rolled = executeRoll(normalized, { randomInteger });
      const rollId = uuid();
      const createdAt = now();
      const result = { ...rolled, rollId, createdAt, replayed: false };
      const record = {
        schemaVersion: 1,
        rollId,
        createdAt,
        workflowId,
        workflowRunId,
        nodeId,
        caller: { kind: caller.kind, id: caller.id },
        request: normalized,
        result,
      };
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        return record.result;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const raced = JSON.parse(await readFile(path, "utf8"));
        if (JSON.stringify(raced.request) !== JSON.stringify(normalized)) throw new Error(`Roll key ${normalized.key} was concurrently used with different parameters.`);
        return { ...raced.result, replayed: true };
      }
    },
  });
}
