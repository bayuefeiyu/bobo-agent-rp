import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

function safeResolve(root, ...parts) {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error("Data transaction path escapes its root.");
  return target;
}

export async function readDataReceipt(sessionDirectory, batchId) {
  const path = safeResolve(sessionDirectory, "workspace", "receipts", `${batchId}.json`);
  return readFile(path, "utf8").then(JSON.parse).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

export async function listDataReceipts(sessionDirectory) {
  const receiptRoot = safeResolve(sessionDirectory, "workspace", "receipts");
  const names = await readdir(receiptRoot).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const receipts = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const receipt = await readFile(safeResolve(receiptRoot, name), "utf8").then(JSON.parse);
    if (receipt && typeof receipt === "object" && typeof receipt.batchId === "string") receipts.push(receipt);
  }
  return receipts;
}

export async function inspectDataImpact(sessionDirectory, { messageId, revision = null, allowedModuleIds = null } = {}) {
  if (typeof messageId !== "string" || !messageId) throw new Error("Impact inspection requires a messageId.");
  if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error("Impact inspection revision must be a positive integer or null.");
  const allowed = Array.isArray(allowedModuleIds) ? new Set(allowedModuleIds) : null;
  const receipts = await listDataReceipts(sessionDirectory);
  const batches = [];
  let untrackedReceipts = 0;
  for (const receipt of receipts) {
    if (!Array.isArray(receipt.sourceReferences)) {
      untrackedReceipts += 1;
      continue;
    }
    const references = receipt.sourceReferences.filter(source => source?.kind === "message" && source.id === messageId && (revision === null || source.revision === revision));
    if (!references.length) continue;
    const targets = (Array.isArray(receipt.targets) ? receipt.targets : [])
      .filter(target => !allowed || allowed.has(target.moduleId))
      .map(target => ({ moduleId: target.moduleId, collectionId: target.collectionId, recordType: target.recordType, recordId: target.recordId || null }));
    if (allowed && !targets.length) continue;
    batches.push({
      batchId: receipt.batchId,
      status: receipt.status,
      committedAt: receipt.committedAt || null,
      workflowId: receipt.workflowId || null,
      workflowRunId: receipt.workflowRunId || null,
      nodeId: receipt.nodeId || null,
      binding: receipt.binding || null,
      matchedRevisions: [...new Set(references.map(source => source.revision))],
      targets,
    });
  }
  batches.sort((left, right) => String(left.committedAt || "").localeCompare(String(right.committedAt || "")) || left.batchId.localeCompare(right.batchId));
  return {
    schemaVersion: 1,
    messageId,
    revision,
    matched: batches.length > 0,
    batches,
    scannedReceipts: receipts.length,
    untrackedReceipts,
    note: untrackedReceipts ? "Some legacy receipts have no source revisions and cannot be assessed automatically." : null,
  };
}

export async function inspectDataIntegrity(sessionDirectory, { messages = [], allowedModuleIds = null } = {}) {
  if (!Array.isArray(messages)) throw new Error("Data integrity inspection requires an authoritative message array.");
  const currentMessages = new Map();
  for (const message of messages) {
    if (!message || typeof message.id !== "string" || !Number.isSafeInteger(message.revision) || message.revision < 1) continue;
    currentMessages.set(message.id, { revision: message.revision, turn: Number.isSafeInteger(message.binding?.turn) ? message.binding.turn : 0 });
  }
  const allowed = Array.isArray(allowedModuleIds) ? new Set(allowedModuleIds) : null;
  const receipts = (await listDataReceipts(sessionDirectory)).filter(receipt => ["committed", "partial"].includes(receipt?.status));
  const grouped = new Map();
  let untrackedReceipts = 0;
  for (const receipt of receipts) {
    const targets = (Array.isArray(receipt.targets) ? receipt.targets : []).filter(target => target?.moduleId && (!allowed || allowed.has(target.moduleId)));
    if (!targets.length) continue;
    if (!Array.isArray(receipt.sourceReferences)) {
      untrackedReceipts += 1;
      continue;
    }
    const modules = new Set(targets.map(target => target.moduleId));
    for (const source of receipt.sourceReferences) {
      if (source?.kind !== "message") continue;
      const current = currentMessages.get(source.id);
      if (!current || current.revision === source.revision) continue;
      for (const moduleId of modules) {
        const key = `${moduleId}:${source.id}:${current.revision}`;
        const issue = grouped.get(key) || {
          id: key,
          type: "source-revised",
          severity: "warning",
          moduleId,
          messageId: source.id,
          startTurn: current.turn,
          endTurn: current.turn,
          recordedRevisions: [],
          currentRevision: current.revision,
          batchIds: [],
          targets: [],
        };
        issue.recordedRevisions.push(source.revision);
        issue.batchIds.push(receipt.batchId);
        issue.targets.push(...targets.filter(target => target.moduleId === moduleId));
        grouped.set(key, issue);
      }
    }
  }
  const issues = [...grouped.values()].map(issue => ({
    ...issue,
    recordedRevisions: [...new Set(issue.recordedRevisions)].sort((left, right) => left - right),
    batchIds: [...new Set(issue.batchIds)].sort(),
    targets: [...new Map(issue.targets.map(target => [`${target.collectionId}/${target.recordType}/${target.recordId || ""}`, target])).values()],
  })).sort((left, right) => left.startTurn - right.startTurn || left.moduleId.localeCompare(right.moduleId) || left.messageId.localeCompare(right.messageId));
  return {
    schemaVersion: 1,
    issues,
    scannedReceipts: receipts.length,
    untrackedReceipts,
    note: untrackedReceipts ? "Some legacy receipts have no source revisions and cannot be assessed automatically." : null,
  };
}

export async function writeDataReceipt(sessionDirectory, receipt) {
  const receiptRoot = safeResolve(sessionDirectory, "workspace", "receipts");
  await mkdir(receiptRoot, { recursive: true });
  const receiptPath = safeResolve(receiptRoot, `${receipt.batchId}.json`);
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

export async function commitDataFiles(sessionDirectory, batchId, files, receipt) {
  const transactionRoot = safeResolve(sessionDirectory, "workspace", "transactions");
  const receiptRoot = safeResolve(sessionDirectory, "workspace", "receipts");
  await Promise.all([mkdir(transactionRoot, { recursive: true }), mkdir(receiptRoot, { recursive: true })]);
  const transactionPath = safeResolve(transactionRoot, `${batchId}.json`);
  const stagingRoot = safeResolve(transactionRoot, batchId);
  const receiptPath = safeResolve(receiptRoot, `${batchId}.json`);
  const transactionFiles = [...files, { path: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n` }];
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  const staged = [];
  for (const [index, file] of transactionFiles.entries()) {
    const target = resolve(file.path);
    const sessionRoot = resolve(sessionDirectory);
    if (target !== sessionRoot && !target.startsWith(`${sessionRoot}${sep}`)) throw new Error("A data transaction target escapes its session directory.");
    const temp = safeResolve(stagingRoot, `${String(index).padStart(6, "0")}.next`);
    const backup = safeResolve(stagingRoot, `${String(index).padStart(6, "0")}.previous`);
    const existed = await stat(target).then(value => value.isFile()).catch(error => error?.code === "ENOENT" ? false : Promise.reject(error));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(temp, file.content, "utf8");
    if (existed) await copyFile(target, backup);
    staged.push({ target, temp, backup, existed });
  }
  await writeFile(transactionPath, `${JSON.stringify({ schemaVersion: 1, batchId, status: "staged", entries: staged }, null, 2)}\n`, "utf8");
  try {
    for (const file of staged) await rename(file.temp, file.target);
    await rm(transactionPath, { force: true });
    await rm(stagingRoot, { recursive: true, force: true });
    return receipt;
  } catch (error) {
    for (const file of staged) {
      if (file.existed) await copyFile(file.backup, file.target).catch(() => {});
      else await rm(file.target, { force: true }).catch(() => {});
    }
    await writeFile(transactionPath, `${JSON.stringify({ schemaVersion: 1, batchId, status: "rolled-back", error: String(error?.message || error), entries: staged.map(({ target, existed }) => ({ target, existed })) }, null, 2)}\n`, "utf8");
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function recoverDataTransactions(sessionDirectory) {
  const transactionRoot = safeResolve(sessionDirectory, "workspace", "transactions");
  await mkdir(transactionRoot, { recursive: true });
  const recovered = [];
  for (const name of await readdir(transactionRoot)) {
    if (!name.endsWith(".json")) continue;
    const journalPath = safeResolve(transactionRoot, name);
    const journal = await readFile(journalPath, "utf8").then(JSON.parse);
    if (!['staged', 'interrupted'].includes(journal.status) || !Array.isArray(journal.entries)) continue;
    const receipt = await readDataReceipt(sessionDirectory, journal.batchId);
    if (receipt && ["committed", "partial"].includes(receipt.status)) {
      await rm(journalPath, { force: true });
      await rm(safeResolve(transactionRoot, journal.batchId), { recursive: true, force: true });
      recovered.push(journal.batchId);
      continue;
    }
    for (const entry of journal.entries) {
      const target = resolve(entry.target);
      const sessionRoot = resolve(sessionDirectory);
      if (target !== sessionRoot && !target.startsWith(`${sessionRoot}${sep}`)) throw new Error(`Transaction ${journal.batchId} contains an unsafe recovery target.`);
      if (entry.existed) await copyFile(entry.backup, target);
      else await rm(target, { force: true });
    }
    journal.status = "recovered-rolled-back";
    journal.recoveredAt = new Date().toISOString();
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await rm(safeResolve(transactionRoot, journal.batchId), { recursive: true, force: true });
    recovered.push(journal.batchId);
  }
  return recovered;
}
