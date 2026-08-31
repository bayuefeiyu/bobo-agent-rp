import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

function safeResolve(root, ...segments) {
  const base = resolve(root);
  const target = resolve(base, ...segments);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Resolved workflow path escapes its root.");
  return target;
}

export function workflowWorkspacePaths(sessionDirectory, workflowId, runId, kind) {
  const privateKind = kind === "global-background" ? "global-background" : "turn-background";
  const workspace = safeResolve(sessionDirectory, "workspace");
  return {
    publicTurn: safeResolve(workspace, "public", "turn"),
    publicLongTerm: safeResolve(workspace, "public", "long-term"),
    privateRun: safeResolve(workspace, "private", privateKind, workflowId, runId),
    workflowRuns: safeResolve(sessionDirectory, "workflow", "runs.jsonl"),
    workflowArtifacts: safeResolve(sessionDirectory, "workflow", "artifacts"),
  };
}

export async function ensureWorkflowWorkspace(paths) {
  await Promise.all([
    mkdir(paths.publicTurn, { recursive: true }),
    mkdir(paths.publicLongTerm, { recursive: true }),
    mkdir(paths.privateRun, { recursive: true }),
    mkdir(resolve(paths.workflowRuns, ".."), { recursive: true }),
    mkdir(paths.workflowArtifacts, { recursive: true }),
  ]);
  return paths;
}

export async function clearPublicTurnWorkspace(sessionDirectory) {
  const path = safeResolve(sessionDirectory, "workspace", "public", "turn");
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
  return path;
}

export async function appendWorkflowRunRecord(path, record) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function publishLongTermRecord(publicLongTerm, namespace, record, schema) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(namespace)) throw new Error("Long-term namespace is invalid.");
  const directory = safeResolve(publicLongTerm, namespace);
  await mkdir(directory, { recursive: true });
  const envelope = {
    schemaVersion: 1,
    id: record.id || `publication-${randomUUID()}`,
    namespace,
    revision: Number.isSafeInteger(record.revision) && record.revision > 0 ? record.revision : 1,
    createdAt: record.createdAt || new Date().toISOString(),
    binding: record.binding || { messageIds: [], throughTurn: null },
    data: record.data,
  };
  const currentPath = safeResolve(directory, "current.json");
  const recordsPath = safeResolve(directory, "records.jsonl");
  const schemaPath = safeResolve(directory, "schema.json");
  const temporary = safeResolve(directory, `.current-${process.pid}-${randomUUID()}.tmp`);
  if (schema !== undefined) await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  await appendFile(recordsPath, `${JSON.stringify(envelope)}\n`, "utf8");
  await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  await rename(temporary, currentPath);
  return envelope;
}

export async function readLatestLongTermRecord(publicLongTerm, namespace) {
  const path = safeResolve(publicLongTerm, namespace, "current.json");
  return JSON.parse(await readFile(path, "utf8"));
}

async function jsonLines(path) {
  return readFile(path, "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

export async function pruneWorkflowState(sessionDirectory, fromTurn) {
  if (!Number.isSafeInteger(fromTurn) || fromTurn < 0) throw new Error("fromTurn must be a non-negative integer.");
  const workflowDirectory = safeResolve(sessionDirectory, "workflow");
  const runsPath = safeResolve(workflowDirectory, "runs.jsonl");
  const snapshots = await jsonLines(runsPath);
  const removedRunIds = new Set(snapshots.filter(run => (Number.isSafeInteger(run.turn) && run.turn >= fromTurn) || (Number.isSafeInteger(run.visibleThroughTurn) && run.visibleThroughTurn >= fromTurn)).map(run => run.id));
  const kept = snapshots.filter(run => !removedRunIds.has(run.id));
  await mkdir(workflowDirectory, { recursive: true });
  await writeFile(runsPath, kept.map(record => JSON.stringify(record)).join("\n") + (kept.length ? "\n" : ""), "utf8");

  const artifacts = safeResolve(workflowDirectory, "artifacts");
  for (const runId of removedRunIds) await rm(safeResolve(artifacts, runId), { recursive: true, force: true });
  const privateRoot = safeResolve(sessionDirectory, "workspace", "private");
  for (const kind of await readdir(privateRoot, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (!kind.isDirectory()) continue;
    const kindPath = safeResolve(privateRoot, kind.name);
    for (const workflow of await readdir(kindPath, { withFileTypes: true })) {
      if (!workflow.isDirectory()) continue;
      for (const runId of removedRunIds) await rm(safeResolve(kindPath, workflow.name, runId), { recursive: true, force: true });
    }
  }

  const longTerm = safeResolve(sessionDirectory, "workspace", "public", "long-term");
  for (const namespace of await readdir(longTerm, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (!namespace.isDirectory()) continue;
    const directory = safeResolve(longTerm, namespace.name);
    const recordsPath = safeResolve(directory, "records.jsonl");
    const records = await jsonLines(recordsPath);
    const surviving = records.filter(record => !Number.isSafeInteger(record.binding?.throughTurn) || record.binding.throughTurn < fromTurn);
    await writeFile(recordsPath, surviving.map(record => JSON.stringify(record)).join("\n") + (surviving.length ? "\n" : ""), "utf8");
    if (surviving.length) await writeFile(safeResolve(directory, "current.json"), `${JSON.stringify(surviving.at(-1), null, 2)}\n`, "utf8");
    else await rm(safeResolve(directory, "current.json"), { force: true });
  }
  await clearPublicTurnWorkspace(sessionDirectory);
  return { removedRunIds: [...removedRunIds], keptSnapshots: kept.length };
}
