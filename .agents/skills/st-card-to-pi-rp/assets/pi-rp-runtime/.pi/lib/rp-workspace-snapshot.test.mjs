import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { cleanupFrozenTriggerInputs, createDocumentWorkspaceSnapshot, freezeTriggeredDocuments, stageTriggeredDocuments, workspaceDocumentFromArtifact } from "./rp-workspace-snapshot.mjs";

test("freezes only declared documents with hashes, limits, narrative inputs, and retry reuse", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rp-snapshot-"));
  try {
    await mkdir(resolve(root, "declared"));
    await mkdir(resolve(root, "declared", "nested"));
    await writeFile(resolve(root, "declared", "DOCUMENTS.md"), "# Entry\n\nRead [nested](nested/a.md).\n", "utf8");
    await writeFile(resolve(root, "declared", "nested", "a.md"), "alpha\n", "utf8");
    await writeFile(resolve(root, "secret.txt"), "must not be copied\n", "utf8");
    const first = await createDocumentWorkspaceSnapshot({
      nodeWorkspace: root,
      outputPath: "snapshot",
      documents: [{ id: "declared", path: "declared", entryPath: "declared/DOCUMENTS.md", readPolicy: "required", authority: "binding" }],
      currentInput: "玩家输入",
      narrative: "正文",
      turnContext: { recentCompleteTurns: 5 },
    });
    assert.equal(first.manifest.immutable, true);
    assert.equal(first.manifest.fileCount, 4);
    assert.equal(first.manifest.documents[0].kind, "directory");
    assert.equal(first.manifest.documents[0].entryPath, "documents/001-declared/DOCUMENTS.md");
    assert.equal(first.manifest.documents[0].files[0].sha256.length, 64);
    assert.equal(await readFile(resolve(root, "snapshot", "documents", "001-declared", "nested", "a.md"), "utf8"), "alpha\n");
    await assert.rejects(readFile(resolve(root, "snapshot", "secret.txt"), "utf8"));
    await writeFile(resolve(root, "declared", "nested", "a.md"), "changed\n", "utf8");
    const second = await createDocumentWorkspaceSnapshot({ nodeWorkspace: root, outputPath: "snapshot", documents: [], currentInput: "different", narrative: "different" });
    assert.equal(second.reused, true);
    assert.deepEqual(second.manifest, first.manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Web-triggered directory registration preserves its reading entry through snapshotting", async () => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-trigger-snapshot-"));
  try {
    const source = resolve(sessionDirectory, "sources", "turn-context");
    await mkdir(resolve(source, "nested"), { recursive: true });
    await writeFile(resolve(source, "DOCUMENTS.md"), "# Turn context\n\nRead [detail](nested/detail.md).\n", "utf8");
    await writeFile(resolve(source, "nested", "detail.md"), "selected detail\n", "utf8");
    await writeFile(resolve(sessionDirectory, "sources", "unselected.md"), "do not copy\n", "utf8");
    const workflow = { id: "foreground" };
    const run = { id: "run-1", payload: { triggerDocuments: { context: { path: "sources/turn-context", format: "document-set", kind: "directory" }, omitted: { path: "sources/unselected.md", format: "markdown", kind: "file" } } } };
    const node = { id: "writer", metadata: { triggerInputs: ["context"] } };
    const artifacts = await stageTriggeredDocuments({ sessionDirectory, workflow, run, node });
    assert.equal(artifacts.length, 1);
    const nodeWorkspace = resolve(sessionDirectory, "workspace", "private", "foreground", "run-1", "writer");
    const registered = artifacts.map(artifact => workspaceDocumentFromArtifact(artifact, { readPolicy: "required", authority: "binding" }));
    assert.equal(registered[0].path, "trigger/context");
    assert.equal(registered[0].entryPath, "trigger/context/DOCUMENTS.md");
    const snapshot = await createDocumentWorkspaceSnapshot({ nodeWorkspace, outputPath: "snapshot", documents: registered });
    assert.equal(snapshot.manifest.documents[0].kind, "directory");
    assert.equal(snapshot.manifest.documents[0].entryPath, "documents/001-trigger.context/DOCUMENTS.md");
    assert.equal(await readFile(resolve(snapshot.root, "documents", "001-trigger.context", "nested", "detail.md"), "utf8"), "selected detail\n");
    await assert.rejects(readFile(resolve(snapshot.root, "documents", "unselected.md"), "utf8"));
  } finally { await rm(sessionDirectory, { recursive: true, force: true }); }
});

test("a consumer run freezes trigger inputs once and survives producer cleanup", async () => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-frozen-trigger-"));
  try {
    const source = resolve(sessionDirectory, "workspace", "private", "producer", "producer-run", "review", "turn-context");
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "DOCUMENTS.md"), "# Original turn\n", "utf8");
    const workflow = { id: "consumer" };
    const frozen = await freezeTriggeredDocuments({
      sessionDirectory,
      workflow,
      runId: "consumer-run",
      triggerDocuments: {
        context: {
          path: "workspace/private/producer/producer-run/review/turn-context",
          format: "document-set",
          kind: "directory",
          sourceArtifact: { workflowId: "producer", workflowRunId: "producer-run", nodeId: "review", id: "story-context", turn: 4 },
          sourceReferences: [{ kind: "message", id: "message-4", revision: 2 }],
        },
      },
    });
    await rm(resolve(sessionDirectory, "workspace", "private", "producer"), { recursive: true, force: true });
    const run = { id: "consumer-run", payload: { triggerDocuments: frozen } };
    const first = await stageTriggeredDocuments({ sessionDirectory, workflow, run, node: { id: "first", metadata: { triggerInputs: ["context"] } } });
    const second = await stageTriggeredDocuments({ sessionDirectory, workflow, run, node: { id: "second", metadata: { triggerInputs: ["context"] } } });
    // RC-05: the card authors `trigger/turn-context` on its call node, so every authorized consumer
    // has to see the frozen turn at that address in its own workspace. It used to be registered at
    // `../_trigger-inputs/context`, which no card address could name.
    assert.equal(first[0].stagedPath, "trigger/context");
    assert.equal(second[0].stagedPath, "trigger/context");
    assert.equal(first[0].frozenTriggerInput, true);
    assert.equal(first[0].sourceReferences[0].revision, 2);
    const nodeWorkspace = resolve(sessionDirectory, "workspace", "private", "consumer", "consumer-run", "first");
    // The node's delivered copy is at the authored address and still holds the frozen turn even
    // though the producer's workspace is gone.
    assert.equal(await readFile(resolve(nodeWorkspace, "trigger", "context", "DOCUMENTS.md"), "utf8"), "# Original turn\n");
    const document = workspaceDocumentFromArtifact(first[0], { readPolicy: "required", authority: "binding" });
    const snapshot = await createDocumentWorkspaceSnapshot({ nodeWorkspace, outputPath: "snapshot", documents: [document] });
    assert.equal(await readFile(resolve(snapshot.root, "documents", "001-review.context", "DOCUMENTS.md"), "utf8"), "# Original turn\n");
    await cleanupFrozenTriggerInputs(sessionDirectory, workflow.id, run.id);
    await assert.rejects(readFile(resolve(sessionDirectory, frozen.context.path, "DOCUMENTS.md"), "utf8"));
  } finally { await rm(sessionDirectory, { recursive: true, force: true }); }
});

test("a staged trigger delivery is re-verified and an edited copy is refused", async () => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-trigger-verify-"));
  try {
    const source = resolve(sessionDirectory, "workspace", "private", "producer", "producer-run", "review", "turn-context");
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "DOCUMENTS.md"), "# Original turn\n", "utf8");
    const workflow = { id: "consumer" };
    const frozen = await freezeTriggeredDocuments({
      sessionDirectory,
      workflow,
      runId: "consumer-run",
      triggerDocuments: { context: { path: "workspace/private/producer/producer-run/review/turn-context", format: "document-set", kind: "directory" } },
    });
    const run = { id: "consumer-run", payload: { triggerDocuments: frozen } };
    const node = { id: "review", metadata: { triggerInputs: ["context"] } };
    await stageTriggeredDocuments({ sessionDirectory, workflow, run, node });

    // A retry that finds the same bytes reuses them without recopying.
    const retry = await stageTriggeredDocuments({ sessionDirectory, workflow, run, node });
    assert.equal(retry[0].stagedPath, "trigger/context");
    assert.equal(retry[0].sha256, frozen.context.sha256);

    // A node that edits its own delivery must not have that edit silently reused as frozen input.
    const nodeWorkspace = resolve(sessionDirectory, "workspace", "private", "consumer", "consumer-run", "review");
    await writeFile(resolve(nodeWorkspace, "trigger", "context", "DOCUMENTS.md"), "# Rewritten by the node\n", "utf8");
    await assert.rejects(
      () => stageTriggeredDocuments({ sessionDirectory, workflow, run, node }),
      /delivery was modified after it was staged/,
    );

    // Nor may the frozen baseline itself be edited underneath a later attempt.
    await rm(resolve(nodeWorkspace, "trigger"), { recursive: true, force: true });
    await writeFile(resolve(sessionDirectory, frozen.context.path, "DOCUMENTS.md"), "# Tampered baseline\n", "utf8");
    await assert.rejects(
      () => stageTriggeredDocuments({ sessionDirectory, workflow, run, node }),
      /no longer matches the digest recorded for this run/,
    );
  } finally { await rm(sessionDirectory, { recursive: true, force: true }); }
});

test("a node only receives the trigger documents its own metadata authorizes", async () => {
  const sessionDirectory = await mkdtemp(resolve(tmpdir(), "rp-trigger-auth-"));
  try {
    const source = resolve(sessionDirectory, "sources", "turn-context");
    await mkdir(source, { recursive: true });
    await writeFile(resolve(source, "DOCUMENTS.md"), "# Turn\n", "utf8");
    const workflow = { id: "consumer" };
    const run = { id: "run-1", payload: { triggerDocuments: { context: { path: "sources/turn-context", format: "document-set", kind: "directory" } } } };
    const unauthorized = await stageTriggeredDocuments({ sessionDirectory, workflow, run, node: { id: "other", metadata: { triggerInputs: [] } } });
    assert.deepEqual(unauthorized, []);
    const unauthorizedWorkspace = resolve(sessionDirectory, "workspace", "private", "consumer", "run-1", "other");
    await assert.rejects(readFile(resolve(unauthorizedWorkspace, "trigger", "context", "DOCUMENTS.md"), "utf8"));
  } finally { await rm(sessionDirectory, { recursive: true, force: true }); }
});
