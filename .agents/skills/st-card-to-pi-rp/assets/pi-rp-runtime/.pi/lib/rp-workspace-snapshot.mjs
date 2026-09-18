import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { copyWorkspaceEntry } from "./rp-document-sets.mjs";

function safeChild(root, path, label) {
  const base = resolve(root);
  const target = resolve(base, path);
  const relation = relative(base, target);
  if (!relation || relation.startsWith("..") || relation.includes(`..${sep}`)) throw new Error(`${label} escapes its workspace.`);
  return target;
}

function safeSegment(value) {
  return String(value || "document").replace(/[^a-zA-Z0-9._-]/g, "-");
}

const SNAPSHOT_LIMITS = Object.freeze({ maxFiles: 500, maxTotalBytes: 20 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxDepth: 12 });

export function workspaceDocumentFromArtifact(artifact, declared = {}) {
  const path = artifact.stagedPath;
  return {
    id: `${artifact.nodeId}.${artifact.id}`,
    path,
    entryPath: artifact.format === "document-set" ? `${path}/DOCUMENTS.md` : path,
    kind: artifact.kind,
    readPolicy: declared.readPolicy || "conditional",
    authority: declared.authority || "advisory",
    appliesAt: declared.appliesAt || "planning-and-writing",
    perspective: declared.perspective || "general",
    priority: Number.isFinite(declared.priority) ? declared.priority : 0,
    description: declared.description || `Workspace handoff ${artifact.id} from node ${artifact.nodeId}`,
    frozenTriggerInput: artifact.frozenTriggerInput === true,
  };
}

async function inventoryEntry(path, relativePath = "", depth = 0) {
  if (depth > SNAPSHOT_LIMITS.maxDepth) throw new Error(`Document workspace snapshot exceeds directory depth ${SNAPSHOT_LIMITS.maxDepth}.`);
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("Document workspace snapshots cannot contain symbolic links.");
  if (stat.isFile()) {
    if (stat.size > SNAPSHOT_LIMITS.maxFileBytes) throw new Error(`Snapshot file ${relativePath || path} exceeds ${SNAPSHOT_LIMITS.maxFileBytes} bytes.`);
    const content = await readFile(path);
    return [{ path: relativePath || ".", bytes: stat.size, sha256: createHash("sha256").update(content).digest("hex") }];
  }
  if (!stat.isDirectory()) throw new Error("Document workspace snapshots accept only regular files and real directories.");
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    files.push(...await inventoryEntry(resolve(path, entry.name), childRelative, depth + 1));
  }
  return files;
}

function filesDigest(files) {
  return createHash("sha256").update(JSON.stringify(files.map(file => ({ path: file.path, sha256: file.sha256 })))).digest("hex");
}

function enforceInventoryLimits(files) {
  if (files.length > SNAPSHOT_LIMITS.maxFiles) throw new Error(`Document workspace snapshot exceeds ${SNAPSHOT_LIMITS.maxFiles} files.`);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > SNAPSHOT_LIMITS.maxTotalBytes) throw new Error(`Document workspace snapshot exceeds ${SNAPSHOT_LIMITS.maxTotalBytes} bytes.`);
  return total;
}

export async function createDocumentWorkspaceSnapshot({ nodeWorkspace, outputPath, documents, dynamicOutputs = [], currentInput = "", narrative = "", turnContext = null }) {
  const root = safeChild(nodeWorkspace, outputPath, "Document workspace snapshot");
  const existing = await readFile(resolve(root, "SNAPSHOT.json"), "utf8").then(JSON.parse).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) return { root, manifest: existing, reused: true };
  await mkdir(root, { recursive: true });
  const entries = [];
  const allFiles = [];
  for (const [index, document] of [...documents, ...dynamicOutputs].entries()) {
    // Every registered document resolves inside the node workspace. Frozen trigger inputs are
    // delivered to `trigger/<id>` there rather than read from the run-level baseline, so nothing
    // here needs to step outside its own workspace.
    const source = safeChild(nodeWorkspace, document.path, `Snapshot source ${document.id}`);
    const stat = await lstat(source);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Snapshot source ${document.id} is not a regular file or directory.`);
    const files = await inventoryEntry(source);
    allFiles.push(...files.map(file => ({ ...file, documentId: document.id })));
    enforceInventoryLimits(allFiles);
    const destinationRelative = `documents/${String(index + 1).padStart(3, "0")}-${safeSegment(document.id)}`;
    const destination = resolve(root, destinationRelative);
    await copyWorkspaceEntry(source, destination, `snapshot document ${document.id}`);
    entries.push({
      id: document.id,
      path: destinationRelative,
      entryPath: document.entryPath && document.entryPath !== document.path
        ? `${destinationRelative}/${relative(document.path, document.entryPath).replaceAll("\\", "/")}`
        : destinationRelative,
      kind: stat.isDirectory() ? "directory" : "file",
      readPolicy: document.readPolicy || "conditional",
      authority: document.authority || "advisory",
      appliesAt: document.appliesAt || "task",
      perspective: document.perspective || "general",
      priority: Number.isFinite(document.priority) ? document.priority : 0,
      description: document.description || "Authorized source document",
      sourceReferences: Array.isArray(document.sourceReferences) ? document.sourceReferences : [],
      files,
    });
  }
  if (currentInput.trim()) {
    const frozenInput = `${currentInput.trim()}\n`;
    const bytes = Buffer.byteLength(frozenInput, "utf8");
    if (bytes > SNAPSHOT_LIMITS.maxFileBytes) throw new Error("Snapshot current input exceeds the per-file limit.");
    const file = { path: "current-input.md", bytes, sha256: createHash("sha256").update(frozenInput).digest("hex"), documentId: "current-input" };
    allFiles.push(file);
    enforceInventoryLimits(allFiles);
    await writeFile(resolve(root, "current-input.md"), frozenInput, "utf8");
    entries.push({ id: "current-input", path: "current-input.md", entryPath: "current-input.md", kind: "file", readPolicy: "required", authority: "canonical", appliesAt: "review", perspective: "player", priority: 1000, description: "The player input for the completed foreground turn.", sourceReferences: [], files: [file] });
  }
  if (narrative.trim()) {
    const frozenNarrative = `${narrative.trim()}\n`;
    const bytes = Buffer.byteLength(frozenNarrative, "utf8");
    if (bytes > SNAPSHOT_LIMITS.maxFileBytes) throw new Error("Snapshot narrative exceeds the per-file limit.");
    const file = { path: "published-narrative.md", bytes, sha256: createHash("sha256").update(frozenNarrative).digest("hex"), documentId: "published-narrative" };
    allFiles.push(file);
    enforceInventoryLimits(allFiles);
    await writeFile(resolve(root, "published-narrative.md"), frozenNarrative, "utf8");
    entries.push({ id: "published-narrative", path: "published-narrative.md", entryPath: "published-narrative.md", kind: "file", readPolicy: "required", authority: "canonical", appliesAt: "review", perspective: "story", priority: 1000, description: "The narrative selected for publication by this foreground workflow.", sourceReferences: [], files: [file] });
  }
  const manifest = { schemaVersion: 1, kind: "document-workspace-snapshot", immutable: true, turnContext, limits: SNAPSHOT_LIMITS, fileCount: allFiles.length, totalBytes: enforceInventoryLimits(allFiles), documents: entries };
  await writeFile(resolve(root, "SNAPSHOT.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(root, "DOCUMENTS.md"), [
    "# Frozen authorized document workspace",
    "",
    "This snapshot contains only runtime-registered documents and explicit narrative inputs. It grants no tools or data permissions.",
    "",
    ...entries.flatMap(entry => [`## ${entry.id}`, "", `- delivered path: \`${entry.path}\``, ...(entry.entryPath !== entry.path ? [`- reading entry: \`${entry.entryPath}\``] : []), `- kind: \`${entry.kind}\``, `- readPolicy: \`${entry.readPolicy}\``, `- authority: \`${entry.authority}\``, `- appliesAt: \`${entry.appliesAt}\``, `- perspective: \`${entry.perspective}\``, `- priority: \`${entry.priority}\``, `- description: ${entry.description}`, ""]),
  ].join("\n"), "utf8");
  return { root, manifest };
}

/**
 * Deliver the trigger documents a node is authorized for at the stable address the card authored.
 *
 * The trigger contract is `trigger/<documentId>` in the consuming node's own workspace, and call
 * nodes, code nodes and Agent document indexes all read it from there. The frozen authority under
 * `_trigger-inputs/` stays the recovery baseline and is never handed to a node directly: each node
 * receives its own controlled copy, so nothing the node writes can alter another node's material or
 * the baseline a restart replays.
 *
 * The copy is verified on every attempt, including retries and restarts. A copy whose content no
 * longer matches the frozen digest is rejected rather than silently reused, and a trigger source
 * that was deleted upstream does not matter because the copy already exists.
 */
export async function stageTriggeredDocuments({ sessionDirectory, workflow, run, node }) {
  const documents = run.payload?.triggerDocuments;
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) return [];
  const nodeWorkspace = safeChild(sessionDirectory, `workspace/private/${workflow.id}/${run.id}/${node.id}`, "Triggered document workspace");
  const permitted = new Set(Array.isArray(node.metadata?.triggerInputs) ? node.metadata.triggerInputs : []);
  await mkdir(nodeWorkspace, { recursive: true });
  const staged = [];
  for (const [id, source] of Object.entries(documents)) {
    // Only what the node's own metadata authorizes; an unauthorized node must not be able to reach
    // the material at all, not merely be told not to read it.
    if (!permitted.has(id)) continue;
    if (!source || typeof source !== "object" || typeof source.path !== "string") throw new Error(`Triggered document ${id} is invalid.`);
    const frozen = source.frozenForRunId === run.id;
    const sourcePath = safeChild(sessionDirectory, source.path, `Triggered document ${id}`);
    const targetRelative = `trigger/${safeSegment(id)}`;
    if (frozen) {
      const runRoot = safeChild(sessionDirectory, `workspace/private/${workflow.id}/${run.id}`, `Triggered document ${id} run root`);
      const relation = relative(runRoot, sourcePath).replaceAll("\\", "/");
      if (!relation.startsWith("_trigger-inputs/")) throw new Error(`Frozen triggered document ${id} is outside its consumer run.`);
      // The frozen digest was recorded when the input was frozen; re-deriving it from the files
      // catches a baseline that was altered in place before this attempt ever read it.
      const frozenDigest = filesDigest(await inventoryEntry(sourcePath));
      const expected = typeof source.sha256 === "string" && source.sha256 ? source.sha256 : frozenDigest;
      if (expected !== frozenDigest) throw new Error(`Frozen triggered document ${id} no longer matches the digest recorded for this run.`);
      const files = await deliverTriggerDocument({ id, sourcePath, nodeWorkspace, targetRelative, expected });
      staged.push({
        id,
        workflowRunId: source.sourceArtifact?.workflowRunId || run.id,
        nodeId: source.sourceArtifact?.nodeId || "trigger",
        stagedPath: targetRelative,
        kind: source.kind,
        format: source.format || null,
        narrativeSource: source.narrativeSource || null,
        sourceReferences: source.sourceReferences || [],
        sha256: expected,
        files,
        frozenTriggerInput: true,
      });
      continue;
    }
    const stat = await lstat(sourcePath);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Triggered document ${id} is not a regular file or directory.`);
    const expected = filesDigest(await inventoryEntry(sourcePath));
    const files = await deliverTriggerDocument({ id, sourcePath, nodeWorkspace, targetRelative, expected });
    staged.push({
      id,
      nodeId: "trigger",
      stagedPath: targetRelative,
      kind: stat.isDirectory() ? "directory" : "file",
      format: source.format || null,
      narrativeSource: source.narrativeSource || null,
      sha256: expected,
      files,
    });
  }
  return staged;
}

/**
 * Place one verified copy at `trigger/<id>` in the node workspace.
 *
 * A copy left by an earlier attempt is reused only when its bytes still match; anything else is an
 * edited delivery, and quietly reading it would hand the node different material than the run froze.
 */
async function deliverTriggerDocument({ id, sourcePath, nodeWorkspace, targetRelative, expected }) {
  const target = safeChild(nodeWorkspace, targetRelative, `Triggered document ${id} delivery`);
  const existing = await lstat(target).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() || (!existing.isFile() && !existing.isDirectory())) throw new Error(`Triggered document ${id} delivery is not a regular file or directory.`);
    const delivered = await inventoryEntry(target);
    if (filesDigest(delivered) !== expected) throw new Error(`Triggered document ${id} delivery was modified after it was staged; restart the workflow run instead of reusing it.`);
    return delivered;
  }
  await rm(target, { recursive: true, force: true });
  await copyWorkspaceEntry(sourcePath, target, `triggered document ${id}`);
  return inventoryEntry(target);
}

export async function freezeTriggeredDocuments({ sessionDirectory, workflow, runId, triggerDocuments }) {
  if (!triggerDocuments || typeof triggerDocuments !== "object" || Array.isArray(triggerDocuments) || !Object.keys(triggerDocuments).length) return {};
  const runRoot = safeChild(sessionDirectory, `workspace/private/${workflow.id}/${runId}`, "Triggered input run root");
  const targetRoot = resolve(runRoot, "_trigger-inputs");
  const existing = await readFile(resolve(targetRoot, "SNAPSHOT.json"), "utf8").then(JSON.parse).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) return existing.triggerDocuments || {};
  await mkdir(runRoot, { recursive: true });
  await rm(targetRoot, { recursive: true, force: true });
  const temporary = resolve(runRoot, `_trigger-inputs.${process.pid}.${Date.now()}.tmp`);
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    const entries = [];
    const frozen = {};
    const allFiles = [];
    for (const [id, source] of Object.entries(triggerDocuments).sort(([left], [right]) => left.localeCompare(right))) {
      if (!source || typeof source !== "object" || typeof source.path !== "string") throw new Error(`Triggered document ${id} is invalid.`);
      const sourcePath = safeChild(sessionDirectory, source.path, `Triggered document ${id}`);
      const stat = await lstat(sourcePath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Triggered document ${id} is not a regular file or directory.`);
      const files = await inventoryEntry(sourcePath);
      allFiles.push(...files.map(file => ({ ...file, documentId: id })));
      enforceInventoryLimits(allFiles);
      const destinationName = safeSegment(id);
      const destination = resolve(temporary, destinationName);
      await copyWorkspaceEntry(sourcePath, destination, `frozen triggered document ${id}`);
      const combinedDigest = createHash("sha256").update(JSON.stringify(files.map(file => ({ path: file.path, sha256: file.sha256 })))).digest("hex");
      const sourceArtifact = source.sourceArtifact && typeof source.sourceArtifact === "object" ? structuredClone(source.sourceArtifact) : null;
      const targetRelative = `workspace/private/${workflow.id}/${runId}/_trigger-inputs/${destinationName}`;
      frozen[id] = {
        path: targetRelative,
        format: source.format || null,
        kind: stat.isDirectory() ? "directory" : "file",
        narrativeSource: source.narrativeSource || null,
        sourceReferences: Array.isArray(source.sourceReferences) ? structuredClone(source.sourceReferences) : [],
        sourceArtifact,
        sha256: combinedDigest,
        frozenForRunId: runId,
      };
      entries.push({ id, path: destinationName, kind: frozen[id].kind, format: frozen[id].format, sha256: combinedDigest, files, sourceArtifact, sourceReferences: frozen[id].sourceReferences, narrativeSource: frozen[id].narrativeSource });
    }
    const manifest = { schemaVersion: 1, kind: "workflow-trigger-input-snapshot", workflowId: workflow.id, runId, immutable: true, fileCount: allFiles.length, totalBytes: enforceInventoryLimits(allFiles), documents: entries, triggerDocuments: frozen };
    await writeFile(resolve(temporary, "SNAPSHOT.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(resolve(temporary, "DOCUMENTS.md"), ["# Frozen workflow trigger inputs", "", "These are the exact documents selected by the trigger contract for this consumer run.", "", ...entries.flatMap(entry => [`## ${entry.id}`, "", `- path: \`${entry.path}\``, `- kind: \`${entry.kind}\``, `- sha256: \`${entry.sha256}\``, ""])].join("\n"), "utf8");
    await rename(temporary, targetRoot);
    return frozen;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupFrozenTriggerInputs(sessionDirectory, workflowId, runId) {
  const runRoot = safeChild(sessionDirectory, `workspace/private/${workflowId}/${runId}`, "Triggered input run root");
  await rm(resolve(runRoot, "_trigger-inputs"), { recursive: true, force: true });
}
