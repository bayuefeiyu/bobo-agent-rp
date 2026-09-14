import { getById } from "../lib/data-helpers.mjs";

const COLLECTIONS = ["entities", "relationships", "events", "cognitions", "knower-groups"];

export async function execute({ run, data }) {
  const request = run.arguments?.request?.maintenanceRequest;
  if (!request || typeof request.taskType !== "string" || !Array.isArray(request.targetIds) || !request.targetIds.length) throw new Error("Maintenance requires taskType and at least one target ID.");
  const targets = [];
  for (const id of request.targetIds) {
    let target = null;
    for (const collectionId of COLLECTIONS) {
      target = await getById(data, collectionId, id, "maintenance");
      if (target) break;
    }
    if (!target) throw new Error(`Maintenance target ${id} was not found.`);
    targets.push(target);
  }
  return { schemaVersion: 1, request, targets };
}
