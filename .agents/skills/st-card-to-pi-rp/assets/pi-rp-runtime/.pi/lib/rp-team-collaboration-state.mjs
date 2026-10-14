import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { collaborationTranscript } from "./rp-team-shared-context.mjs";
import { emptyTokenUsage } from "./rp-token-usage.mjs";

export async function atomicCollaborationJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporary, path);
}

export class CollaborationStateStore {
  constructor(workspace) { this.root = resolve(workspace, "team"); this.path = resolve(this.root, "state.json"); this.queue = Promise.resolve(); }
  async load(config, identity, taskPlan) {
    await mkdir(this.root, { recursive: true });
    const prior = await readFile(this.path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (prior) {
      if (prior.protocol !== "collaboration" || prior.runId !== identity.runId || prior.nodeId !== identity.nodeId || prior.taskPlan.sourceHash !== taskPlan.sourceHash) throw Object.assign(new Error("Collaboration state does not match its frozen run/task."), { code: "workflow_recovery_required" });
      this.state = prior;
    } else {
      this.state = { schemaVersion: 1, protocol: "collaboration", ...identity, config, taskPlan, status: "running", activeMemberId: config.initialMemberId, activation: 0, epoch: 0, toolCalls: 0, events: [], operations: {}, calledTargets: [], dynamicDocuments: [], stageState: null, deliveryReceipts: [], pendingOperation: null, lastMemberFailure: null, usage: { ...emptyTokenUsage(), calls: 0, recordedCalls: 0, unrecordedCalls: 0 } };
      await this.save();
      await atomicCollaborationJson(resolve(this.root, "config.json"), config);
    }
    return this.state;
  }
  transact(operation) {
    const promise = this.queue.then(operation);
    this.queue = promise.catch(() => {});
    return promise;
  }
  async save() { await atomicCollaborationJson(this.path, this.state); }
  async event(type, detail = {}) {
    const event = { seq: this.state.events.length + 1, type, at: new Date().toISOString(), memberId: this.state.activeMemberId, activation: this.state.activation, ...detail };
    this.state.events.push(event);
    await this.save();
    await mkdir(resolve(this.root, "shared"), { recursive: true });
    await writeFile(resolve(this.root, "shared", "TRANSCRIPT.md"), collaborationTranscript(this.state.events), "utf8");
    await writeFile(resolve(this.root, "events.jsonl"), this.state.events.map(entry => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    return event;
  }
}
