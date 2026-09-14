import { validateAndNormalizeBatch } from "../lib/batch-validation.mjs";
import { submitCommitted } from "../lib/data-helpers.mjs";

export async function execute({ run, data }) {
  const raw = structuredClone(run.nodes["maintenance-model"]?.output);
  if (!raw || !Array.isArray(raw.operations) || !raw.operations.length) return { committed: false, skipped: true, reason: "no-changes" };
  raw.protocolVersion = 1;
  raw.batchId = `memory-maintenance-${run.id}`;
  raw.status = "pending";
  raw.commitPolicy = "atomic";
  raw.operations = raw.operations.map((operation, index) => ({ ...operation, operationId: `memory-maintenance-${run.id}-${index + 1}` }));
  const normalized = await validateAndNormalizeBatch(data, raw, { view: "maintenance" });
  const receipt = await submitCommitted(data, normalized);
  return { committed: true, batchId: normalized.batchId, receipt };
}
