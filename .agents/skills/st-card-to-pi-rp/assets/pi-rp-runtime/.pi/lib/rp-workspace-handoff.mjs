import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import { readVisibleArtifacts, workflowNodeWorkspace } from "./rp-data-artifacts.mjs";
import { copyWorkspaceEntry } from "./rp-document-sets.mjs";

// A text-file call reads only an explicitly named regular file in the caller's
// workspace. Its full content becomes the persisted call text, not a live link.
export async function readWorkflowCallTextFile({ sessionDirectory, workflow, run, node, path }) {
  if (typeof path !== "string" || !path.trim() || path.startsWith("/") || path.startsWith("\\") || /[:\0]/.test(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error("Workflow call textFile must be a safe caller-workspace relative path.");
  }
  const callerWorkspace = await realpath(workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, node.id));
  const parts = path.split(/[\\/]/).filter(part => part && part !== ".");
  if (!parts.length) throw new Error("Workflow call textFile must name a regular file.");
  let target = callerWorkspace;
  for (let index = 0; index < parts.length; index += 1) {
    target = resolve(target, parts[index]);
    const entry = await lstat(target);
    if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error("Workflow call textFile must use real directories and a regular file, without symbolic links.");
    }
  }
  const resolvedTarget = await realpath(target);
  const relation = relative(callerWorkspace, resolvedTarget);
  if (!relation || isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("Workflow call textFile escapes its caller workspace.");
  }
  const content = await readFile(resolvedTarget);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  if (text.includes("\0")) throw new Error("Workflow call textFile must contain UTF-8 text.");
  return text;
}

export async function stageWorkflowCallInputs({ sessionDirectory, workflow, run, node }) {
  if (!run.callContext) return [];
  const nodeWorkspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, node.id);
  const callerWorkspace = workflowNodeWorkspace(sessionDirectory, run.callContext.parentWorkflowId, run.callContext.parentRunId, run.callContext.parentNodeId);
  const inputs = [];
  const permitted = new Set(Array.isArray(node.metadata?.callInputs) ? node.metadata.callInputs : []);
  const permittedArguments = new Set(Array.isArray(node.metadata?.argumentInputs) ? node.metadata.argumentInputs : []);
  const selectedArguments = Object.fromEntries(Object.entries(run.arguments || {}).filter(([id]) => permittedArguments.has(id)));
  const documents = run.documents && typeof run.documents === "object" ? run.documents : {};
  await mkdir(nodeWorkspace, { recursive: true });
  for (const [documentId, sourceRelative] of Object.entries(documents)) {
    if (!permitted.has(documentId)) continue;
    if (typeof sourceRelative !== "string") throw new Error(`Call input document ${documentId} must be a caller-workspace relative path.`);
    const sourcePath = resolve(callerWorkspace, sourceRelative);
    const sourceRelation = relative(callerWorkspace, sourcePath);
    if (!sourceRelation || sourceRelation.startsWith("..") || sourceRelation.includes(`..${sep}`)) throw new Error(`Call input document ${documentId} escapes its caller workspace.`);
    const sourceEntry = await lstat(sourcePath);
    if (sourceEntry.isSymbolicLink() || (!sourceEntry.isFile() && !sourceEntry.isDirectory())) throw new Error(`Call input document ${documentId} must be a regular file or real directory.`);
    const kind = sourceEntry.isDirectory() ? "directory" : "file";
    const expectedKind = workflow.interface?.inputs?.[documentId]?.kind || "file";
    if (expectedKind !== "either" && kind !== expectedKind) throw new Error(`Call input document ${documentId} must be a ${expectedKind}.`);
    const targetRelative = kind === "directory" ? `inputs/${documentId}` : `inputs/${documentId}${extname(sourceRelative) || ".md"}`;
    await copyWorkspaceEntry(sourcePath, resolve(nodeWorkspace, targetRelative), `call input ${documentId}`);
    inputs.push({ id: documentId, path: targetRelative, kind });
  }
  await writeFile(resolve(nodeWorkspace, "CALL-INPUTS.md"), [
    "# Module workflow call inputs",
    "",
    "This file lists the call inputs selected for this node. Text input, when declared, is delivered once in the current task message.",
    "",
    "## Selected parameters",
    "",
    "```json",
    JSON.stringify(selectedArguments, null, 2),
    "```",
    ...inputs.flatMap(document => ["", `- ${document.id}: \`${document.path}\` (${document.kind})`]),
    "",
  ].join("\n"), "utf8");
  return inputs;
}

export async function stageWorkspaceHandoffs({ sessionDirectory, workflow, run, node }) {
  const sourceNodeIds = node.context?.fromNodes?.length ? node.context.fromNodes : node.dependsOn || [];
  if (!sourceNodeIds.length) return [];
  const artifacts = await readVisibleArtifacts({
    sessionDirectory,
    target: { workflowRunId: run.id, nodeId: node.id, turn: run.turn },
    fromNodeIds: sourceNodeIds,
    sourceWorkflowRunId: run.id,
    handoffOnly: true,
  });
  const selected = Array.isArray(node.metadata?.handoffInputs)
    ? new Set(node.metadata.handoffInputs.map(item => `${item.nodeId}/${item.output}`))
    : null;
  const visibleArtifacts = selected ? artifacts.filter(artifact => selected.has(`${artifact.nodeId}/${artifact.id}`)) : artifacts;
  if (!visibleArtifacts.length) return [];
  const nodeWorkspace = workflowNodeWorkspace(sessionDirectory, workflow.id, run.id, node.id);
  await mkdir(nodeWorkspace, { recursive: true });
  const staged = [];
  for (const artifact of visibleArtifacts) {
    const targetRelative = `handoff/${artifact.nodeId}/${artifact.handoffPath}`.replaceAll("\\", "/");
    const targetPath = resolve(nodeWorkspace, targetRelative);
    const targetRelation = relative(nodeWorkspace, targetPath);
    if (!targetRelation || targetRelation.startsWith("..") || targetRelation.includes(`..${sep}`)) throw new Error(`Workspace handoff ${artifact.id} escapes node ${node.id}.`);
    await copyWorkspaceEntry(artifact.path, targetPath, `workspace handoff ${artifact.nodeId}/${artifact.id}`);
    staged.push({ ...artifact, stagedPath: targetRelative });
  }
  return staged;
}
