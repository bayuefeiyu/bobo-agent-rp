import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { readAuthorizedTeamMaterial, readDeclaredTeamDocuments } from "./rp-team-access.mjs";

test("team reads expose only declared inputs, published material, deliveries, and member-local files", async () => {
  const nodeRoot = await mkdtemp(resolve(tmpdir(), "pi-rp-team-access-"));
  const teamRoot = resolve(nodeRoot, "team");
  const memberRoot = resolve(teamRoot, "members", "leader");
  try {
    await mkdir(resolve(teamRoot, "shared"), { recursive: true });
    await mkdir(resolve(teamRoot, "tasks", "task-1"), { recursive: true });
    await mkdir(resolve(teamRoot, "tasks", "private"), { recursive: true });
    await mkdir(resolve(nodeRoot, "inputs"), { recursive: true });
    await mkdir(memberRoot, { recursive: true });
    await writeFile(resolve(teamRoot, "shared", "TRANSCRIPT.md"), "published transcript", "utf8");
    await writeFile(resolve(teamRoot, "tasks", "task-1", "report.md"), "delivered report", "utf8");
    await writeFile(resolve(teamRoot, "tasks", "private", "secret.md"), "not delivered", "utf8");
    await writeFile(resolve(nodeRoot, "inputs", "story.md"), "declared story", "utf8");
    await writeFile(resolve(memberRoot, "notes.md"), "private member note", "utf8");
    await writeFile(resolve(teamRoot, "shared", "INPUTS.json"), JSON.stringify([{ path: "inputs/story.md", kind: "file" }]), "utf8");
    await writeFile(resolve(teamRoot, "shared", "DELIVERIES.json"), JSON.stringify([{ path: "tasks/task-1/report.md", kind: "file" }]), "utf8");

    assert.equal((await readAuthorizedTeamMaterial({ path: "shared/TRANSCRIPT.md", teamRoot, teamNodeRoot: nodeRoot, memberRoot })).content, "published transcript");
    assert.equal((await readAuthorizedTeamMaterial({ path: "inputs/story.md", teamRoot, teamNodeRoot: nodeRoot, memberRoot })).content, "declared story");
    assert.equal((await readAuthorizedTeamMaterial({ path: "tasks/task-1/report.md", teamRoot, teamNodeRoot: nodeRoot, memberRoot })).content, "delivered report");
    assert.equal((await readAuthorizedTeamMaterial({ path: "member/notes.md", teamRoot, teamNodeRoot: nodeRoot, memberRoot })).content, "private member note");
    await assert.rejects(readAuthorizedTeamMaterial({ path: "tasks/private/secret.md", teamRoot, teamNodeRoot: nodeRoot, memberRoot }), /outside the meeting areas/);
    await assert.rejects(readAuthorizedTeamMaterial({ path: "../secret.md", teamRoot, teamNodeRoot: nodeRoot, memberRoot }), /safe relative path/);
  } finally {
    await rm(nodeRoot, { recursive: true, force: true });
  }
});

test("declared-document tool reads only explicit paths and applies a total limit", async () => {
  const nodeRoot = await mkdtemp(resolve(tmpdir(), "pi-rp-team-tool-"));
  try {
    await writeFile(resolve(nodeRoot, "one.md"), "12345", "utf8");
    await writeFile(resolve(nodeRoot, "two.md"), "67890", "utf8");
    const result = await readDeclaredTeamDocuments({ documents: { one: "one.md", two: "two.md" }, nodeWorkspace: nodeRoot, maxCharacters: 1000 });
    assert.deepEqual(result.map(item => item.content), ["12345", "67890"]);
    await assert.rejects(readDeclaredTeamDocuments({ documents: { bad: "../bad.md" }, nodeWorkspace: nodeRoot }), /safe relative path/);
  } finally {
    await rm(nodeRoot, { recursive: true, force: true });
  }
});
