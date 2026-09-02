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
