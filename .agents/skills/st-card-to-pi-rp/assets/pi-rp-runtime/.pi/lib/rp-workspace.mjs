import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
    privateRun: safeResolve(workspace, "private", privateKind, workflowId, runId),
    workflowRuns: safeResolve(sessionDirectory, "workflow", "runs.jsonl"),
    workflowArtifacts: safeResolve(sessionDirectory, "workflow", "artifacts"),
    workflowProcessRecords: safeResolve(sessionDirectory, "workflow", "process-records"),
  };
}

export async function ensureWorkflowWorkspace(paths) {
  await Promise.all([
    mkdir(paths.publicTurn, { recursive: true }),
    mkdir(paths.privateRun, { recursive: true }),
    mkdir(resolve(paths.workflowRuns, ".."), { recursive: true }),
    mkdir(paths.workflowArtifacts, { recursive: true }),
    mkdir(paths.workflowProcessRecords, { recursive: true }),
  ]);
  return paths;
}

function markdownFence(content) {
  const longest = Math.max(0, ...String(content).matchAll(/`+/g).map(match => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function processRecordSection(title, exchange) {
  if (!exchange?.content) return `## ${title}\n\n（无内容）`;
  const content = String(exchange.content);
  const fence = markdownFence(content);
  return `## ${title}\n\n角色：\`${exchange.role || "unknown"}\`\n\n${fence}text\n${content}\n${fence}`;
}

export async function writeWorkflowProcessRecord(processRecordsRoot, record) {
  const runId = String(record.runId || "");
  const nodeId = String(record.nodeId || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(nodeId)) {
    throw new Error("Workflow process record IDs must be filesystem-safe.");
  }
  const directory = safeResolve(processRecordsRoot, runId);
  const path = safeResolve(directory, `${nodeId}.md`);
  const exchange = record.exchange || null;
  const body = [
    "# 工作流节点过程记录",
    "",
    `- 工作流：\`${record.workflowId}\``,
    `- 实例：\`${runId}\``,
    `- 节点：\`${nodeId}\``,
    `- 节点类型：\`${record.nodeType || "unknown"}\``,
    `- Agent：\`${record.agentId || "未调用"}\``,
    `- 模型：\`${record.modelId || "未调用"}\``,
    `- 完成时间：${record.completedAt || new Date().toISOString()}`,
    "",
    exchange
      ? processRecordSection("Agent 最后接收的内容", exchange.received)
      : "## Agent 最后接收的内容\n\n此节点未调用 Agent，没有 Agent 输入。",
    "",
    exchange
      ? processRecordSection("Agent 最后发送的内容", exchange.sent)
      : "## Agent 最后发送的内容\n\n此节点未调用 Agent，没有 Agent 输出。",
    "",
    "> 此文件仅用于用户查看与调试，不会加入 Agent 上下文。",
    "",
  ].join("\n");
  await mkdir(directory, { recursive: true });
  await writeFile(path, body, "utf8");
  return path;
}

export function workflowProcessRecordPath(processRecordsRoot, runId, nodeId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(nodeId)) {
    throw new Error("Workflow process record IDs must be filesystem-safe.");
  }
  return safeResolve(processRecordsRoot, runId, `${nodeId}.md`);
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
  const processRecords = safeResolve(workflowDirectory, "process-records");
  for (const runId of removedRunIds) await rm(safeResolve(processRecords, runId), { recursive: true, force: true });
  const randomRecords = safeResolve(workflowDirectory, "random");
  for (const runId of removedRunIds) await rm(safeResolve(randomRecords, runId), { recursive: true, force: true });
  const privateRoot = safeResolve(sessionDirectory, "workspace", "private");
  for (const kind of await readdir(privateRoot, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error))) {
    if (!kind.isDirectory()) continue;
    const kindPath = safeResolve(privateRoot, kind.name);
    for (const workflow of await readdir(kindPath, { withFileTypes: true })) {
      if (!workflow.isDirectory()) continue;
      for (const runId of removedRunIds) await rm(safeResolve(kindPath, workflow.name, runId), { recursive: true, force: true });
    }
  }

  await clearPublicTurnWorkspace(sessionDirectory);
  return { removedRunIds: [...removedRunIds], keptSnapshots: kept.length };
}
