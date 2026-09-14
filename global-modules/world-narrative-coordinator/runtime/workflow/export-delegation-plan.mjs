import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const KEYS = ["local", "world"];
const PUBLICATIONS = { local: "publication-local-scene-narrative", world: "publication-world-scope-narrative" };
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function optionalSafeId(value, label) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !SAFE_ID.test(value.trim())) throw new Error(`${label} must be a safe ID.`);
  return value.trim();
}

function normalizeEntry(value, key, run) {
  if (value === null || value === undefined || value.enabled === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`delegations.${key} must be an object or null.`);
  if (typeof value.notAfter !== "string" || !value.notAfter.trim()) throw new Error(`delegations.${key}.notAfter is required.`);
  if (typeof value.action !== "string" || !value.action.trim()) throw new Error(`delegations.${key}.action is required.`);
  const suffix = randomUUID();
  return {
    enabled: true,
    action: value.action.trim(),
    scene: key === "local" && typeof value.scene === "string" ? value.scene.trim() : null,
    topicId: key === "world" && typeof value.topicId === "string" ? value.topicId.trim() : null,
    angle: typeof value.angle === "string" ? value.angle.trim() : null,
    notes: Array.isArray(value.notes) ? value.notes.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [],
    publicationId: PUBLICATIONS[key],
    notAfter: value.notAfter.trim(),
    seriesId: optionalSafeId(value.seriesId, `delegations.${key}.seriesId`) || `${key}-series-${suffix}`,
    originStoryId: optionalSafeId(value.originStoryId, `delegations.${key}.originStoryId`),
    candidateId: `${key}-candidate-${suffix}`,
    storyId: `${key}-story-${suffix}`,
    sourceTurn: Number.isSafeInteger(run.turn) ? run.turn : 0,
  };
}

export async function execute({ run, node, workspace }) {
  const source = run.nodes[node.metadata.sourceNode]?.output;
  const raw = source?.delegations && typeof source.delegations === "object" ? source.delegations : {};
  const plan = Object.fromEntries(KEYS.map(key => [key, normalizeEntry(raw[key], key, run)]));
  const root = resolve(workspace, "delegations");
  await mkdir(root, { recursive: true });
  await writeFile(resolve(root, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await writeFile(resolve(root, "DOCUMENTS.md"), "# Director delegation plan\n\nRead `plan.json` as the complete binding delegation decision for this turn. A missing or null channel means no candidate should be started for that channel; do not infer a delegation from other director materials.\n\n- path: `plan.json`\n- readPolicy: `required`\n- authority: `binding`\n- appliesAt: `planning`\n", "utf8");
  return { local: Boolean(plan.local), world: Boolean(plan.world) };
}
