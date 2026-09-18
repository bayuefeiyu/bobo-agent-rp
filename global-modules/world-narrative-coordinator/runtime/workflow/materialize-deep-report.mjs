import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { deepReportDocument, validateDeepReport } from "../lib/deep-report.mjs";

/**
 * Turn the planning Agent's structured JSON output into the declared `deep-report.json` artifact.
 *
 * The plan node's only job is to answer with JSON; asking the Agent to also remember to write a file
 * leaves the declared output empty whenever it does not. This node reads the plan's structured output
 * from the run, validates it once, writes the artifact, and hands it to `commit` through an explicit
 * workspace handoff. The commit node re-validates what it reads, so a tampered or stale file is still
 * rejected at the point where authoritative data would change.
 */
export async function execute({ run, node, workspace }) {
  const sourceNodeId = node.metadata?.sourceNode;
  if (typeof sourceNodeId !== "string" || !sourceNodeId) throw new Error(`Node ${node.id} metadata.sourceNode is required.`);
  const state = run.nodes?.[sourceNodeId];
  if (!state) throw new Error(`Deep report source node ${sourceNodeId} is not part of this run.`);
  if (state.status !== "completed") throw new Error(`Deep report source node ${sourceNodeId} is ${state.status}; the report cannot be materialized.`);
  const outputId = node.metadata?.sourceOutput || "report";
  const proposed = validateDeepReport(state.output, { basisTurn: run.turn });

  const declared = node.outputs?.[node.metadata?.outputName || "report"];
  if (!declared || declared.kind === "directory") throw new Error(`Node ${node.id} must declare a file output for the materialized deep report.`);
  const target = resolve(workspace, declared.path);
  const relation = relative(resolve(workspace), target).replaceAll("\\", "/");
  if (!relation || relation.startsWith("..") || relation.split("/").includes("..")) throw new Error(`Deep report output path escapes the node workspace.`);
  await mkdir(dirname(target), { recursive: true });
  // `wx` would fail a legitimate retry, so the file is rewritten from the validated source instead:
  // the content is a pure function of the plan output, so a retry is idempotent by construction.
  await writeFile(target, deepReportDocument(proposed), "utf8");
  return { output: { materialized: true, output: outputId, path: declared.path, basisTurn: proposed.basisTurn, worldNarrativeTopics: proposed.worldNarrativeTopics.length } };
}
