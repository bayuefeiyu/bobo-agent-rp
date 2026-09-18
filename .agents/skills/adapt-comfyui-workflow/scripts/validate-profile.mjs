#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const directory = process.argv[2];
const errors = [];
if (!directory) {
  console.error("Usage: node validate-profile.mjs <profile-directory>");
  process.exit(2);
}
const profilePath = resolve(directory, "profile.json");
let profile;
let workflow;
try { profile = JSON.parse(await readFile(profilePath, "utf8")); }
catch (error) { errors.push(`profile.json: ${error.message}`); }
if (profile) {
  const fields = ["schemaVersion", "id", "title", "revision", "guideId", "connectionId", "workflowFile", "bindings", "prompt", "output", "seedRange"];
  if (profile.schemaVersion !== 1 || Object.keys(profile).some(key => !fields.includes(key)) || fields.some(key => !(key in profile))) errors.push("profile.json must use the exact profile v1 field set, including seedRange.");
  for (const key of ["id", "guideId", "connectionId"]) if (!SAFE_ID.test(profile[key] || "")) errors.push(`${key} must be a safe ID.`);
  if (profile.id !== basename(resolve(directory))) errors.push("profile id must match its directory name.");
  if (profile.workflowFile !== "workflow.api.json") errors.push("workflowFile must be workflow.api.json.");
  try { workflow = JSON.parse(await readFile(resolve(directory, profile.workflowFile), "utf8")); }
  catch (error) { errors.push(`workflow: ${error.message}`); }
  try { await readFile(resolve(directory, "..", "..", "skill", "guides", profile.guideId, "SKILL.md"), "utf8"); }
  catch (error) { errors.push(`guide ${profile.guideId}: ${error.message}`); }
  const roles = ["positive", "negative", "seed", "filenamePrefix"];
  if (!profile.bindings || Object.keys(profile.bindings).some(key => !roles.includes(key)) || roles.some(key => !Array.isArray(profile.bindings?.[key]))) errors.push("bindings must contain exactly positive, negative, seed, and filenamePrefix arrays.");
  if (!profile.bindings?.positive?.length) errors.push("at least one positive binding is required.");
  if (!profile.bindings?.filenamePrefix?.length) errors.push("at least one filenamePrefix binding is required.");
  if (workflow && (!workflow || typeof workflow !== "object" || Array.isArray(workflow))) errors.push("workflow root must be an API-format node object.");
  if (workflow && profile.bindings) for (const role of roles) for (const binding of profile.bindings[role] || []) {
    if (!binding || Object.keys(binding).length !== 2 || !SAFE_ID.test(String(binding.nodeId || "")) || typeof binding.input !== "string") errors.push(`${role} contains an invalid binding.`);
    else if (!workflow[binding.nodeId]?.inputs || !Object.hasOwn(workflow[binding.nodeId].inputs, binding.input)) errors.push(`${role} binding ${binding.nodeId}.${binding.input} does not exist.`);
  }
  for (const nodeId of profile.output?.nodeIds || []) if (!workflow?.[nodeId]) errors.push(`output node ${nodeId} does not exist.`);
  const promptFields = ["separator", "positivePrefix", "positiveSuffix", "negative"];
  if (!profile.prompt || promptFields.some(key => typeof profile.prompt[key] !== "string") || Object.keys(profile.prompt).some(key => !promptFields.includes(key))) errors.push("prompt must contain exactly four string fields.");
  // A seed range that is missing, or a bound whose value survives JSON inexactly, is the RC-07 class
  // of defect: ComfyUI accepts the submission, skips the save branch, and still reports success.
  const seedRange = profile.seedRange;
  if (!seedRange || typeof seedRange !== "object" || Array.isArray(seedRange)) errors.push("seedRange is required: declare the bound seed node's accepted integer range.");
  else {
    const unknownRangeFields = Object.keys(seedRange).filter(key => !["min", "max", "source"].includes(key));
    if (unknownRangeFields.length) errors.push(`seedRange contains unsupported fields: ${unknownRangeFields.join(", ")}.`);
    if (!Number.isSafeInteger(seedRange.min) || seedRange.min < 0) errors.push("seedRange.min must be a non-negative safe integer that survives JSON exactly.");
    if (!Number.isSafeInteger(seedRange.max) || seedRange.max < 0) errors.push("seedRange.max must be a non-negative safe integer that survives JSON exactly.");
    if (Number.isSafeInteger(seedRange.min) && Number.isSafeInteger(seedRange.max) && seedRange.min > seedRange.max) errors.push("seedRange.min must not exceed seedRange.max.");
    if (typeof seedRange.source !== "string" || !seedRange.source.trim()) errors.push("seedRange.source must record where the limit comes from (node title, node metadata, or an explicit statement).");
  }
  if (profile.bindings?.seed?.length && workflow) {
    for (const binding of profile.bindings.seed) {
      const limit = workflow[binding?.nodeId]?.inputs?.max ?? workflow[binding?.nodeId]?.inputs?.maximum ?? null;
      if (typeof limit === "number" && Number.isFinite(limit) && Number.isSafeInteger(seedRange?.max) && seedRange.max > limit) {
        errors.push(`seed binding ${binding.nodeId}.${binding.input} accepts at most ${limit}, but seedRange.max is ${seedRange.max}.`);
      }
    }
  }
}
if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  const digest = createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
  console.log(JSON.stringify({ ok: true, profileId: profile.id, workflowDigest: digest }, null, 2));
}
