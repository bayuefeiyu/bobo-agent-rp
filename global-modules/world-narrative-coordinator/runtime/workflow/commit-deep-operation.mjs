import { open, readFile, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { submitCommitted } from "../lib/agent-change-batch.mjs";

const REPORT_KEYS = new Set(["basisTurn", "basisWorldTime", "coverage", "assumptions", "invalidatingSignals", "summary", "content", "worldNarrativeTopics", "nextReviewTriggers", "referenceUpdates"]);
const TOPIC_KEYS = new Set(["topicId", "title", "status", "premise", "conditions", "boundaries", "suggestedAngles", "invalidatingSignals"]);

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writePublicationPackage(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await rename(temporary, path); }
  catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
}

function assertTextArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label} must be an array of strings.`);
}

function assertExactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const unknown = Object.keys(value).filter(key => !keys.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
}

function validateReport(report, turn) {
  assertExactKeys(report, REPORT_KEYS, "Team report");
  if (report.basisTurn !== turn) throw new Error("Team report basisTurn must equal the frozen workflow turn.");
  if (report.basisWorldTime !== null && typeof report.basisWorldTime !== "string") throw new Error("Team report basisWorldTime must be a string or null.");
  for (const key of ["coverage", "assumptions", "invalidatingSignals", "nextReviewTriggers"]) assertTextArray(report[key], `Team report ${key}`);
  assertText(report.summary, "Team report summary");
  assertText(report.content, "Team report content");
  if (!Array.isArray(report.worldNarrativeTopics) || report.worldNarrativeTopics.length < 2) throw new Error("Team report must contain at least two world narrative topics.");
  for (const [index, topic] of report.worldNarrativeTopics.entries()) {
    assertExactKeys(topic, TOPIC_KEYS, `Team report topic ${index}`);
    assertText(topic.topicId, `Team report topic ${index} topicId`);
    assertText(topic.title, `Team report topic ${index} title`);
    assertText(topic.premise, `Team report topic ${index} premise`);
    if (!["active", "backup"].includes(topic.status)) throw new Error(`Team report topic ${index} has an invalid status.`);
    for (const key of ["conditions", "boundaries", "suggestedAngles", "invalidatingSignals"]) assertTextArray(topic[key], `Team report topic ${index} ${key}`);
  }
  if (report.worldNarrativeTopics.filter(item => item.status === "active").length !== 1 || !report.worldNarrativeTopics.some(item => item.status === "backup")) throw new Error("Team report must contain exactly one active world topic and at least one backup.");
  if (!Array.isArray(report.referenceUpdates)) throw new Error("Team report referenceUpdates must be an array.");
  for (const [index, item] of report.referenceUpdates.entries()) {
    assertText(item.referenceId, `Team report reference ${index} referenceId`);
    assertText(item.title, `Team report reference ${index} title`);
    assertText(item.summary, `Team report reference ${index} summary`);
    if (!["created", "updated"].includes(item.change)) throw new Error(`Team report reference ${item.referenceId} has an invalid change.`);
  }
  if (new Set(report.referenceUpdates.map(item => item.referenceId)).size !== report.referenceUpdates.length) throw new Error("Team report referenceUpdates must use unique referenceId values.");
}

function validateSources(basis, conversation) {
  const currentMessages = new Map(conversation.messages.map(message => [message.id, message]));
  for (const source of basis.sourceMessages || []) {
    const currentMessage = currentMessages.get(source.id);
    if (!currentMessage || (currentMessage.revision || 1) !== source.revision) throw Object.assign(new Error(`Deep publication source message changed or was removed: ${source.id}`), { code: "deep_source_conflict" });
  }
}

async function assertOperationOwner(data, operationId) {
  const state = await (data.getCurrent || data.get)({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-state-current", view: "deep-director" });
  const current = state?.value?.data || state?.value || {};
  if (!state || current.status !== "running" || current.currentRunId !== operationId) throw new Error("Deep operation no longer owns the running state.");
  return { state, current };
}

export async function execute({ run, workspace, conversation, data }) {
  const operationId = run.arguments?.operationId;
  const batchId = `${operationId}-deep-commit`;
  const priorReceipt = typeof data.receipt === "function" ? await data.receipt(batchId) : null;
  if (priorReceipt?.status === "committed") return { committed: true, reused: true, operationId, receipt: priorReceipt };
  const packagePath = resolve(workspace, "publication-package.json");
  const savedPackage = await readFile(packagePath, "utf8").then(JSON.parse).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (savedPackage) {
    if (savedPackage.operationId !== operationId || savedPackage.batch?.batchId !== batchId) throw new Error("Saved deep publication package does not belong to this operation.");
    if (!savedPackage.basis || savedPackage.basis.operationId !== operationId) throw new Error("Saved deep publication package is missing its immutable basis.");
    const savedInputs = await Promise.all(["report", "references", "basis"].map(name => readFile(resolve(workspace, `inputs/${name}.json`), "utf8")));
    for (const [index, name] of ["report", "references", "basis"].entries()) {
      if (savedPackage.inputHashes?.[name] !== contentHash(savedInputs[index])) throw Object.assign(new Error(`Saved deep publication input changed after packaging: ${name}.`), { code: "deep_package_conflict" });
    }
    validateSources(savedPackage.basis, conversation);
    await assertOperationOwner(data, operationId);
    const receipt = await submitCommitted(data, savedPackage.batch, savedPackage.submitOptions || {});
    return { committed: true, reused: true, operationId, reportRevision: savedPackage.reportRevision, referenceCount: savedPackage.referenceCount, receipt };
  }
  const [reportText, referencesText, basisText] = await Promise.all(["report", "references", "basis"].map(name => readFile(resolve(workspace, `inputs/${name}.json`), "utf8")));
  const report = JSON.parse(reportText);
  const references = JSON.parse(referencesText);
  const basis = JSON.parse(basisText);
  if (basis.schemaVersion !== 1 || basis.operationId !== operationId || basis.basisTurn !== run.turn) throw new Error("Deep publication basis does not match this operation and frozen turn.");
  validateSources(basis, conversation);
  validateReport(report, run.turn);
  if (!Array.isArray(references)) throw new Error("Team reference documents must be an array.");
  const approved = new Map(report.referenceUpdates.map(item => [item.referenceId, item]));
  if (references.length !== approved.size || references.some(item => !approved.has(item.referenceId))) throw new Error("Reference documents do not match report.referenceUpdates.");
  const { state, current } = await assertOperationOwner(data, operationId);
  const currentGet = data.getCurrent || data.get;
  const operation = await currentGet({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: operationId, view: "deep-director" });
  const operationValue = operation?.value?.data || operation?.value || null;
  if (!operation || operationValue?.status !== "running") throw Object.assign(new Error("Deep operation manifest is missing or no longer running."), { code: "operation_closed", operationId });
  const deepReport = await currentGet({ moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", id: "deep-report-current", view: "deep-director" });
  if (!deepReport) throw new Error("Current deep report is missing.");
  if (!basis.deepReport || basis.deepReport.id !== deepReport.id || basis.deepReport.revision !== deepReport.revision) throw Object.assign(new Error("The deep report changed after this meeting began."), { code: "revision_conflict" });
  const operations = [];
  for (const item of references) {
    const planned = approved.get(item.referenceId);
    assertText(item.title, `Reference ${item.referenceId} title`);
    assertText(item.summary, `Reference ${item.referenceId} summary`);
    assertText(item.content, `Reference ${item.referenceId} content`);
    if (!Array.isArray(item.sources) || item.sources.some(source => !source || typeof source !== "object" || Array.isArray(source) || typeof source.label !== "string" || !source.label.trim() || typeof source.reference !== "string" || !source.reference.trim())) throw new Error(`Reference ${item.referenceId} sources must be an array of {label,reference} objects.`);
    if (item.title !== planned.title || item.summary !== planned.summary || item.change !== planned.change) throw new Error(`Reference ${item.referenceId} no longer matches the approved report list.`);
    const existing = await currentGet({ moduleId: "world-narrative-coordinator", collectionId: "reference-library", id: item.referenceId, view: "maintenance" });
    const basisRevision = basis.references?.[item.referenceId];
    const action = basisRevision === undefined ? "create" : "update";
    if (action === "create" && existing || action === "update" && (!existing || existing.revision !== basisRevision)) throw Object.assign(new Error(`Reference ${item.referenceId} changed after this meeting began.`), { code: "revision_conflict" });
    if (action === "create" && item.change !== "created" || action === "update" && item.change !== "updated") throw new Error(`Reference ${item.referenceId} change does not match the meeting basis.`);
    operations.push({ operationId: `${operationId}-reference-${item.referenceId}`, moduleId: "world-narrative-coordinator", collectionId: "reference-library", recordType: "director.reference-document", action, targetId: item.referenceId, ...(action === "update" ? { expectedRevision: basisRevision } : {}), data: { title: item.title, summary: item.summary, content: item.content, sources: Array.isArray(item.sources) ? item.sources : [] }, note: null });
  }
  operations.push(
    { operationId: `${operationId}-report`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-report", action: "update", targetId: deepReport.id, expectedRevision: deepReport.revision, data: { ...report, previousRevision: deepReport.revision }, note: null },
    { operationId: `${operationId}-state`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-state", action: "update", targetId: state.id, expectedRevision: state.revision, data: { ...current, status: "idle", currentRunId: null, lastCompletedTurn: run.turn, lastCompletedWorldTime: report.basisWorldTime ?? null, currentReportRevision: deepReport.revision + 1, failure: null }, note: null },
    { operationId: `${operationId}-manifest-complete`, moduleId: "world-narrative-coordinator", collectionId: "deep-workbench", recordType: "director.deep-operation", action: "update", targetId: operation.id, expectedRevision: operation.revision, data: { ...operationValue, status: "completed", closedTurn: run.turn, terminalError: null }, note: null },
  );
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const sourceMessageIds = (basis.sourceMessages || []).map(item => item.id);
  const submitOptions = latest ? {
    binding: { turn: latest.binding.turn, messageId: latest.id },
    sourceMessageIds: sourceMessageIds.length ? sourceMessageIds : [latest.id],
    ...(sourceMessageIds.length ? { sourceMessageRevisions: Object.fromEntries((basis.sourceMessages || []).map(item => [item.id, item.revision])) } : {}),
  } : {};
  const batch = { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations };
  await writePublicationPackage(packagePath, {
    schemaVersion: 1,
    operationId,
    basis,
    inputHashes: { report: contentHash(reportText), references: contentHash(referencesText), basis: contentHash(basisText) },
    batch,
    submitOptions,
    reportRevision: deepReport.revision + 1,
    referenceCount: references.length,
  });
  const receipt = await submitCommitted(data, batch, submitOptions);
  return { committed: true, operationId, reportRevision: deepReport.revision + 1, referenceCount: references.length, receipt };
}
