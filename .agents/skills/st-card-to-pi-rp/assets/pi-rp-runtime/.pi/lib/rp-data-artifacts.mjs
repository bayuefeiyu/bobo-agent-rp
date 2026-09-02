import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const artifactQueues = new Map();

async function withArtifactLock(sessionDirectory, operation) {
  const key = resolve(sessionDirectory);
  const previous = artifactQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolveLock => { release = resolveLock; });
  const queued = previous.catch(() => {}).then(() => current);
  artifactQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (artifactQueues.get(key) === queued) artifactQueues.delete(key);
  }
}

function safeResolve(root, ...parts) {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Artifact path escapes its workspace.");
  return target;
}

function nodeRoot(sessionDirectory, workflowId, runId, nodeId) {
  return safeResolve(sessionDirectory, "workspace", "private", workflowId, runId, nodeId);
}

async function registerNodeArtifactsUnlocked({ sessionDirectory, workflow, run, node }) {
  const artifacts = {};
  const root = nodeRoot(sessionDirectory, workflow.id, run.id, node.id);
  for (const [id, definition] of Object.entries(node.outputs || {})) {
    const path = safeResolve(root, definition.path);
    const exists = await stat(path).then(value => value.isFile()).catch(error => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) continue;
    artifacts[id] = {
      schemaVersion: 1,
      id,
      workflowId: workflow.id,
      workflowRunId: run.id,
      nodeId: node.id,
      turn: Number.isSafeInteger(run.turn) ? run.turn : null,
      path,
      relativePath: definition.path,
      scope: definition.scope,
      retain: definition.retain,
      format: definition.format,
      createdAt: new Date().toISOString(),
    };
  }
  if (Object.keys(artifacts).length) {
    const registry = safeResolve(sessionDirectory, "workspace", "artifacts.jsonl");
    await mkdir(dirname(registry), { recursive: true });
    await appendFile(registry, `${Object.values(artifacts).map(item => JSON.stringify(item)).join("\n")}\n`, "utf8");
  }
  return artifacts;
}

export async function registerNodeArtifacts(options) {
  return withArtifactLock(options.sessionDirectory, () => registerNodeArtifactsUnlocked(options));
}

export function artifactVisibleTo(artifact, target) {
  if (artifact.scope === "node") return artifact.workflowRunId === target.workflowRunId && artifact.nodeId === target.nodeId;
  if (artifact.scope === "workflow") return artifact.workflowRunId === target.workflowRunId;
  if (artifact.scope === "turn") return artifact.turn === target.turn;
  if (artifact.scope === "session" || artifact.scope === "public") return true;
  return false;
}

async function readVisibleArtifactsUnlocked({ sessionDirectory, target, fromNodeIds = [] }) {
  const registry = safeResolve(sessionDirectory, "workspace", "artifacts.jsonl");
  const records = await readFile(registry, "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const allowedNodes = new Set(fromNodeIds);
  const latest = new Map();
  for (const artifact of records) {
    if (allowedNodes.size && !allowedNodes.has(artifact.nodeId)) continue;
    if (!artifactVisibleTo(artifact, target)) continue;
    latest.set(`${artifact.workflowRunId}/${artifact.nodeId}/${artifact.id}`, artifact);
  }
  return [...latest.values()];
}

export async function readVisibleArtifacts(options) {
  return withArtifactLock(options.sessionDirectory, () => readVisibleArtifactsUnlocked(options));
}

async function cleanupArtifactsUnlocked(sessionDirectory, event) {
  const registry = safeResolve(sessionDirectory, "workspace", "artifacts.jsonl");
  const records = await readFile(registry, "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const shouldRemove = artifact => {
    if (event.type === "node") return artifact.retain === "node" && artifact.workflowRunId === event.workflowRunId && artifact.nodeId === event.nodeId;
    if (event.type === "run") return artifact.retain === "run" && artifact.workflowRunId === event.workflowRunId;
    if (event.type === "turn") return artifact.retain === "turn" && Number.isSafeInteger(artifact.turn) && artifact.turn < event.turn;
    return false;
  };
  const removed = records.filter(shouldRemove);
  const kept = records.filter(artifact => !shouldRemove(artifact));
  for (const artifact of removed) await rm(safeResolve(sessionDirectory, artifact.path), { force: true });
  await mkdir(dirname(registry), { recursive: true });
  await writeFile(registry, kept.map(item => JSON.stringify(item)).join("\n") + (kept.length ? "\n" : ""), "utf8");
  return removed;
}

export async function cleanupArtifacts(sessionDirectory, event) {
  return withArtifactLock(sessionDirectory, () => cleanupArtifactsUnlocked(sessionDirectory, event));
}

export async function readArtifactJson(artifact) {
  return JSON.parse(await readFile(artifact.path, "utf8"));
}

export function workflowNodeWorkspace(sessionDirectory, workflowId, runId, nodeId) {
  return nodeRoot(sessionDirectory, workflowId, runId, nodeId);
}
