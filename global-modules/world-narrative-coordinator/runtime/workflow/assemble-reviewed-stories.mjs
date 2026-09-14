import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildAgentChangeBatch, submitCommitted } from "../lib/agent-change-batch.mjs";
import { validateStoryMetadata } from "../lib/story-contract.mjs";

const SPECS = {
  local: { input: "local-candidate", module: "local-scene-narrative" },
  world: { input: "world-candidate", module: "world-scope-narrative" },
};

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export async function execute({ run, node, workspace, data }) {
  const review = object(run.nodes[node.metadata.sourceNode]?.output, "review result");
  const decisions = object(review.decisions || {}, "review decisions");
  const output = resolve(workspace, "reviewed");
  await mkdir(output, { recursive: true });
  const manifest = {};
  for (const [key, spec] of Object.entries(SPECS)) {
    const input = resolve(workspace, "inputs", spec.input);
    let originalMetadata;
    try { originalMetadata = JSON.parse(await readFile(resolve(input, "metadata.json"), "utf8")); }
    catch { continue; }
    const decision = object(decisions[key], `${key} decision`);
    if (!["accept-original", "replace", "withhold"].includes(decision.decision) || typeof decision.reason !== "string") throw new Error(`${key} decision is invalid.`);
    const target = resolve(output, key); await mkdir(target, { recursive: true });
    if (decision.decision === "withhold") {
      await writeFile(resolve(target, "status.json"), `${JSON.stringify({ status: "withheld", reason: decision.reason }, null, 2)}\n`, "utf8");
      manifest[key] = { status: "withheld" };
      continue;
    }
    const story = decision.decision === "replace" ? decision.story : await readFile(resolve(input, "story.md"), "utf8");
    const metadata = decision.decision === "replace" ? validateStoryMetadata(decision.metadata, spec.module, "replacement metadata") : validateStoryMetadata(originalMetadata, spec.module, "candidate metadata");
    if (typeof story !== "string" || !story.trim()) throw new Error(`${key} story is empty.`);
    const control = await readFile(resolve(input, "control.json"), "utf8");
    await writeFile(resolve(target, "story.md"), `${story.trim()}\n`, "utf8");
    await writeFile(resolve(target, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeFile(resolve(target, "control.json"), control, "utf8");
    await writeFile(resolve(target, "approval.json"), `${JSON.stringify({ authority: "world-narrative-coordinator/review-story-candidates", runId: run.id, decision: decision.decision, reason: decision.reason }, null, 2)}\n`, "utf8");
    manifest[key] = { status: "approved", decision: decision.decision };
  }
  await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const batch = buildAgentChangeBatch(review.directorBatch, { batchId: `${run.id}-story-review-effects`, allowedCollections: ["private-state"] });
  if (batch.operations.length) await submitCommitted(data, batch);
  return { reviewed: manifest, directorEffects: batch.operations.length };
}
