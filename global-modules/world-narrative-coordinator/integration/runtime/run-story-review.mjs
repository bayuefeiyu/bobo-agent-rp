import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function ensureReviewPackage(root, key, status) {
  const target = resolve(root, "reviewed", key);
  await mkdir(target, { recursive: true });
  if (!(await exists(resolve(target, "approval.json"))) && !(await exists(resolve(target, "status.json")))) {
    await writeFile(resolve(target, "status.json"), `${JSON.stringify({ status }, null, 2)}\n`, "utf8");
  }
}

export async function execute({ workspace, calls }) {
  const documents = { "turn-context": "trigger/turn-context" };
  const local = resolve(workspace, "handoff", "dispatch-local", "candidate-set", "candidate");
  const world = resolve(workspace, "handoff", "dispatch-world", "candidate-set", "candidate");
  if (await exists(resolve(local, "metadata.json"))) documents["local-candidate"] = "handoff/dispatch-local/candidate-set/candidate";
  if (await exists(resolve(world, "metadata.json"))) documents["world-candidate"] = "handoff/dispatch-world/candidate-set/candidate";
  const candidateCount = Object.keys(documents).length - 1;
  if (!candidateCount) {
    await Promise.all([ensureReviewPackage(workspace, "local", "no-candidate"), ensureReviewPackage(workspace, "world", "no-candidate")]);
    return { reviewed: false, candidateCount: 0 };
  }
  const child = await calls.invoke({ workflow: "world-narrative-coordinator/review-story-candidates", arguments: {}, documents, outputPaths: { reviewed: "reviewed" } });
  await Promise.all([ensureReviewPackage(workspace, "local", "no-candidate"), ensureReviewPackage(workspace, "world", "no-candidate")]);
  return { reviewed: true, candidateCount, childCallId: child.callId || null };
}
