import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { submitCommitted } from "../lib/agent-change-batch.mjs";
import { queryAll } from "../lib/data.mjs";

export async function execute({ run, workspace, conversation, data }) {
  const targets = [
    ["private-state", ["director.incubation", "director.actor-plan", "director.story-plan", "director.world-trajectory", "director.watch", "director.player-signal", "director.guidance", "director.publication", "director.turn-brief", "director.bootstrap-state"], "director"],
    ["deep-workbench", ["director.deep-report", "director.deep-state"], "deep-status"],
    ["reference-library", ["director.reference-document"], "director-reference"],
    ["archive-outbox", ["director.archive-handoff"], "director-status"],
  ];
  const collections = [];
  for (const [collectionId, recordTypes, view] of targets) {
    const items = await queryAll(data, { moduleId: "world-narrative-coordinator", collectionId, recordTypes, view, includeInactive: true });
    collections.push({ collectionId, recordCount: items.length, characters: JSON.stringify(items).length, byType: Object.fromEntries(recordTypes.map(type => [type, items.filter(item => item.recordType === type).length])) });
  }
  const settings = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "settings", id: "director-settings-current", view: "health" });
  const reference = settings?.value?.data?.healthReference || settings?.value?.healthReference || {};
  const totals = { recordCount: collections.reduce((sum, item) => sum + item.recordCount, 0), characters: collections.reduce((sum, item) => sum + item.characters, 0) };
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), reference, totals, exceedsReference: { recordCount: totals.recordCount > (reference.recordCount || Infinity), characters: totals.characters > (reference.characters || Infinity) }, collections };
  const current = await data.get({ moduleId: "world-narrative-coordinator", collectionId: "health-dashboard", id: "director-health-current", view: "health" });
  if (!current) throw new Error("Director health dashboard record is missing.");
  const latest = [...conversation.messages].reverse().find(message => message.binding?.turn <= run.turn) || null;
  const persisted = { ...report };
  delete persisted.schemaVersion;
  await submitCommitted(data, {
    protocolVersion: 1,
    batchId: `${run.id}-health-report`,
    status: "pending",
    commitPolicy: "atomic",
    operations: [{ operationId: `${run.id}-health-report-current`, moduleId: "world-narrative-coordinator", collectionId: "health-dashboard", recordType: "director.health-report", action: "update", targetId: current.id, expectedRevision: current.revision, data: persisted, note: null }],
  }, latest ? { binding: { turn: latest.binding.turn, messageId: latest.id }, sourceMessageIds: [latest.id] } : {});
  await writeFile(resolve(workspace, "health-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}
