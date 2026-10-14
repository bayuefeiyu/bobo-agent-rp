import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeCollaborationTeam, validateCollaborationOutputs } from "./rp-team-collaboration-config.mjs";
import { CollaborationStateStore } from "./rp-team-collaboration-state.mjs";
import { collaborationContext, collaborationTranscript } from "./rp-team-shared-context.mjs";
import { collaborationMemberPath } from "./rp-team-member-access.mjs";
import { createAgentDelivery } from "./rp-agent-delivery.mjs";
import { createTaskStageController, parseTaskStages } from "./rp-task-stages.mjs";
import { recordTeamUsage } from "./rp-team-state.mjs";
import { emptyTokenUsage } from "./rp-token-usage.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const schema = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 };
const failure = (message, code = "workflow_recovery_required") => Object.assign(new Error(message), { code });
const response = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value });

export class TeamCollaborationRuntime {
  constructor({ workspace, node, runId, context = "", taskPrompt, invokeMember, invokeWorkflow, prepareCall = async (request, _runtime) => request, isCancelled = () => false }) {
    Object.assign(this, { workspace: resolve(workspace), node, runId, context, taskPrompt, invokeMember, invokeWorkflow, prepareCall, isCancelled });
    this.store = new CollaborationStateStore(this.workspace);
    this.inputPaths = [];
    this.callSignatures = [];
  }
  async run({ inputPaths = [] } = {}) {
    this.inputPaths = inputPaths;
    const config = normalizeCollaborationTeam(this.node.team);
    validateCollaborationOutputs(config, this.node);
    const prior = await readFile(this.store.path, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    const plan = prior?.taskPlan || parseTaskStages(this.taskPrompt);
    this.state = await this.store.load(config, { runId: this.runId, nodeId: this.node.id }, plan);
    this.config = this.state.config;
    this.state.usage ||= { ...emptyTokenUsage(), calls: this.state.activation, recordedCalls: 0, unrecordedCalls: this.state.activation };
    this.state.context ??= this.context;
    this.context = this.state.context;
    this.stages = createTaskStageController(plan, { restored: this.state.stageState });
    this.delivery = await createAgentDelivery({ workspace: this.workspace, node: this.node, agent: {}, inputPaths: [...inputPaths, "team"], restoredReceipts: this.state.deliveryReceipts, onReceipt: async receipt => { this.state.deliveryReceipts = this.delivery.receipts; await this.store.event("artifact-delivered", { result: receipt }); }, beforeComplete: async () => {
      this.stages.assertExhausted();
      const missing = (this.node.requiredCalls || []).filter(target => !this.state.calledTargets.includes(target));
      if (missing.length) throw failure(`Required calls have not succeeded: ${missing.join(", ")}.`, "required_call_missing");
    } });
    for (const document of this.state.dynamicDocuments) await this.delivery.protect(document.path);
    if (this.state.status === "completed") {
      await this.delivery.complete();
      return this.result();
    }
    this.state.status = "running";
    this.state.error = null;
    try {
      this.assertRunning();
      await this.recoverPending();
      while (this.state.status === "running") {
        this.assertRunning();
        if (this.state.activation >= this.config.limits.maxActivations) throw failure("Collaboration activation budget exhausted.");
        const member = this.config.members.find(entry => entry.id === this.state.activeMemberId);
        this.state.activation++;
        this.state.usage.unrecordedCalls++;
        this.state.epoch++;
        const epoch = this.state.epoch;
        await this.store.event("member-activated", { stage: this.stages.currentStage });
        await mkdir(resolve(this.workspace, "work", member.id), { recursive: true });
        await mkdir(resolve(this.store.root, "shared"), { recursive: true });
        await writeFile(resolve(this.store.root, "shared/TRANSCRIPT.md"), collaborationTranscript(this.state.events), "utf8");
        const request = {
          memberId: member.id, member, role: member.role, agentId: member.agentId, modelId: member.modelId,
          freezeKey: `${this.node.id}:member:${member.id}`, executionId: `activation-${this.state.activation}`, workspace: this.workspace,
          prompt: collaborationContext({ context: this.context, state: this.state, stages: this.stages, member }),
          collaboration: {
            tools: this.tools(member, epoch), maxProtocolReminders: this.config.limits.maxProtocolReminders,
            beforeModel: () => this.store.transact(async () => {
              this.assertActive(member, epoch);
              // Invalid tool schemas do not reach execute; bound those retries too.
              const budget = this.config.limits.maxToolCalls + this.config.limits.maxActivations * (this.config.limits.maxProtocolReminders + 1);
              if ((this.state.modelDispatches || 0) >= budget) throw failure("Collaboration model request budget exhausted.");
              this.state.modelDispatches = (this.state.modelDispatches || 0) + 1;
              this.state.usage.calls++;
              await this.store.save();
            }),
            bindWorkflow: adapter => { this.invokeWorkflow = adapter; },
            frozenAgentPrompt: () => Object.hasOwn(this.state.agentPrompts || {}, member.id) ? this.state.agentPrompts[member.id] : null,
            freezeAgentPrompt: async sources => {
              this.state.agentPrompts ||= {};
              if (!Object.hasOwn(this.state.agentPrompts, member.id)) this.state.agentPrompts[member.id] = sources;
              await this.store.save();
              return this.state.agentPrompts[member.id];
            },
            publish: (text, { interrupted = false } = {}) => this.store.transact(async () => {
              this.assertActive(member, epoch);
              if (text) await this.store.event("speech", { text, status: interrupted ? "interrupted" : "completed" });
            }),
            isCurrent: () => this.state.epoch === epoch && this.state.activeMemberId === member.id && this.state.status === "running" && !this.isCancelled(),
          },
        };
        try {
          const result = await this.invokeMember(request);
          if (this.blockedError) throw Object.assign(this.blockedError, { usage: result?.usage });
          recordTeamUsage(this.state, result?.usage, { attemptId: `${this.node.id}:${request.executionId}`, source: member.id });
          this.state.lastMemberFailure = null;
          await this.store.save();
          if (!result?.terminated && this.state.status === "running" && this.state.activeMemberId === member.id) throw failure("Member ended without an explicit handoff or completion.");
        } catch (error) {
          recordTeamUsage(this.state, error.usage, { attemptId: `${this.node.id}:${request.executionId}`, source: member.id });
          this.state.lastMemberFailure = { memberId: member.id, freezeKey: request.freezeKey, executionId: request.executionId, error: error.message };
          throw error;
        }
      }
      return this.result();
    } catch (error) {
      this.state.status = this.isCancelled() ? "cancelled" : "failed";
      this.state.error = error.message;
      await this.store.save();
      error.output = structuredClone(this.state);
      throw error;
    }
  }
  result() { return this.delivery.result().then(output => ({ output, usage: this.state.usage, dynamicDocuments: this.state.dynamicDocuments, state: this.state })); }
  assertRunning() { if (this.isCancelled()) throw failure("Collaboration cancelled.", "workflow_cancelled"); }
  assertActive(member, epoch) {
    this.assertRunning();
    if (this.state.status !== "running" || this.state.epoch !== epoch || this.state.activeMemberId !== member.id) throw failure("This member no longer holds the floor.");
  }
  path(member, requested, write = false, root = false) { return collaborationMemberPath({ workspace: this.workspace, node: this.node, config: this.config, memberId: member.id, inputPaths: this.inputPaths, dynamicDocuments: this.state.dynamicDocuments }, requested, write, root); }
  async recoverPending() {
    const pending = this.state.pendingOperation;
    if (!pending) return;
    if (pending.kind === "file") {
      const member = this.config.members.find(entry => entry.id === pending.memberId);
      const target = await this.path(member, pending.path, true);
      const currentHash = await this.fileHash(target.path);
      if (currentHash !== pending.beforeHash && currentHash !== hash(pending.content)) throw failure("Interrupted working document was changed; restore or review it before retrying.");
      await this.write(member, pending.id, pending.path, pending.content);
    } else if (pending.kind === "delivery") {
      const member = this.config.members.find(entry => entry.id === pending.memberId);
      const target = await this.path(member, pending.path, true);
      if (await this.workingDigest(target.path) !== pending.digest) throw failure("Interrupted delivery source was changed.");
      const result = await this.delivery.deliver({ output: pending.output, path: pending.path });
      this.state.operations[pending.id] = result;
      this.state.pendingOperation = null;
      await this.store.save();
    } else if (pending.kind === "workflow") {
      // The engine resumes the exact operation via its persisted operation identity.
      await this.finishWorkflow(pending);
    } else throw failure("An interrupted collaboration operation requires recovery.");
  }
  async workingDigest(path) {
    const entries = [];
    const visit = async (target, prefix) => {
      const { lstat } = await import("node:fs/promises");
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Working artifacts cannot contain links.");
      if (info.isDirectory()) for (const name of (await readdir(target)).sort()) await visit(resolve(target, name), `${prefix}/${name}`);
      else entries.push([prefix, hash(await readFile(target))]);
    };
    await visit(path, ""); return hash(JSON.stringify(entries));
  }
  async write(member, id, requested, content) {
    const target = await this.path(member, requested, true);
    if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("Working document exceeds the file limit.");
    this.state.pendingOperation = { kind: "file", id, memberId: member.id, path: target.relative, content, beforeHash: await this.fileHash(target.path) };
    await this.store.save();
    const temporary = resolve(this.store.root, "artifacts", `${randomUUID()}.tmp`);
    await mkdir(dirname(temporary), { recursive: true });
    await mkdir(dirname(target.path), { recursive: true });
    await writeFile(temporary, content, "utf8");
    this.assertRunning();
    await this.path(member, requested, true);
    await rename(temporary, target.path);
    const result = { ok: true, path: target.relative, sha256: hash(content) };
    this.state.operations[id] = result;
    this.state.pendingOperation = null;
    await this.store.event("file-written", { text: JSON.stringify({ ...result, content }) });
    return result;
  }
  async fileHash(path) {
    return readFile(path).then(hash).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  }
  async finishWorkflow(pending) {
    const result = await this.invokeWorkflow(pending.request, { agent: true, operationId: pending.id });
    this.assertRunning();
    if (!this.state.calledTargets.includes(pending.request.workflow)) this.state.calledTargets.push(pending.request.workflow);
    for (const [id, path] of Object.entries(result.outputs || {})) {
      await this.delivery.protect(path);
      if (!this.state.dynamicDocuments.some(document => document.path === path)) this.state.dynamicDocuments.push({ id: `call.${pending.request.workflow}.${id}`, path, readPolicy: "conditional", authority: "canonical", appliesAt: "planning-and-writing", perspective: "general", priority: 0, description: `Declared output ${id} from ${pending.request.workflow}; returned, not yet read.` });
    }
    this.state.operations[pending.id] = result;
    this.state.pendingOperation = null;
    await this.store.event("workflow-returned", { result, detail: { workflow: pending.request.workflow, operationId: pending.id } });
    return result;
  }
  tools(member, epoch) {
    const tool = (name, parameters, description, perform, terminal = false) => ({ name, label: name, description, executionMode: "sequential", parameters, execute: async (callId, args) => this.store.transact(async () => {
      this.assertActive(member, epoch);
      const id = `${this.node.id}:${this.state.activation}:${callId}`;
      if (this.state.operations[id]) return response(this.state.operations[id]);
      if (this.state.toolCalls >= this.config.limits.maxToolCalls) { this.blockedError = failure("Collaboration tool budget exhausted."); return { ...response({ error: this.blockedError.message }), terminate: true }; }
      this.state.toolCalls++;
      await this.store.event("tool-requested", { detail: { name, arguments: args, operationId: id } });
      try {
        const result = await perform(id, args);
        this.state.operations[id] = result;
        if (name === "rp_files") await this.store.event("tool-returned", { result, detail: { name } });
        await this.store.save();
        return { ...response(result), ...(terminal ? { terminate: true } : {}) };
      } catch (error) {
        if (!["workflow_child_waiting", "workflow_recovery_required"].includes(error.code)) this.state.pendingOperation = null;
        await this.store.event("tool-failed", { text: `${name}: ${error.message}`, detail: { name, operationId: id, ...(args.workflow ? { workflow: args.workflow } : {}) } });
        if (error.code === "workflow_child_waiting" || error.code === "workflow_recovery_required") { this.blockedError = error; return { ...response({ error: error.message }), terminate: true }; }
        throw error;
      }
    }) });
    const tools = [];
    if (member.tools.includes("read")) tools.push(tool("read", schema({ path: string, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 5000 } }, ["path"]), "Read an authorized UTF-8 document. Paths are relative to the team node workspace. Actual returned content is shared.", async (_id, args) => {
      const target = await this.path(member, args.path);
      const text = await readFile(target.path, "utf8");
      const lines = text.split("\n");
      const offset = args.offset || 1;
      const selected = lines.slice(offset - 1, offset - 1 + (args.limit || 1000)).join("\n");
      if (Buffer.byteLength(selected) > 300000) throw new Error("Read a narrower document range.");
      const result = { path: target.relative, sha256: hash(text), offset, totalLines: lines.length, truncated: offset > 1 || offset - 1 + (args.limit || 1000) < lines.length, content: selected };
      await this.store.event("document-read", { text: JSON.stringify(result) });
      return result;
    }));
    if (member.tools.includes("write")) tools.push(tool("write", schema({ path: string, content: { type: "string" } }), `Write a UTF-8 document in work/${member.id}/ or your owned output.`, (id, args) => this.write(member, id, args.path, args.content)));
    if (member.tools.includes("edit")) tools.push(tool("edit", schema({ path: string, oldText: string, newText: { type: "string" } }), "Replace one unique exact text occurrence in your own document.", async (id, args) => {
      const target = await this.path(member, args.path, true);
      const text = await readFile(target.path, "utf8");
      if (text.split(args.oldText).length !== 2) throw new Error("oldText must match exactly once.");
      return this.write(member, id, args.path, text.replace(args.oldText, args.newText));
    }));
    if (member.tools.includes("rp_files")) tools.push(tool("rp_files", schema({ action: { enum: ["list", "count"] }, path: { type: "string" }, recursive: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 500 } }, ["action"]), "List authorized workspace paths or count a text document.", async (_id, args) => {
      if (args.action === "count") { const target = await this.path(member, args.path); const text = await readFile(target.path, "utf8"); return { path: target.relative, characters: [...text].length, lines: text.split("\n").length }; }
      const target = await this.path(member, args.path || ".", false, true);
      const files = [];
      const visit = async (absolute, relative) => { for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (files.length >= (args.limit || 100)) return;
        const path = [relative, entry.name].filter(Boolean).join("/");
        try { await this.path(member, path); } catch { continue; }
        files.push({ path, kind: entry.isDirectory() ? "directory" : "file" });
        if (entry.isDirectory() && args.recursive) await visit(resolve(absolute, entry.name), path);
      } };
      await visit(target.path, target.relative); return { files };
    }));
    if (member.tools.includes("rp_call") && this.node.workflowCalls?.length) tools.push(tool("rp_call", schema({ workflow: { enum: this.node.workflowCalls.map(binding => binding.target) }, text: { type: "string" }, textFile: string, arguments: { type: "object" }, documents: { type: "object", additionalProperties: string }, outputPaths: { type: "object", additionalProperties: string } }, ["workflow", "outputPaths"]), `Call an authorized workflow and wait for its documents. Signatures: ${JSON.stringify(this.callSignatures || this.node.workflowCalls)}.`, async (id, args) => {
      const binding = this.node.workflowCalls.find(binding => binding.target === args.workflow);
      if (!binding) throw new Error("This workflow is not authorized.");
      const priorCalls = this.state.events.filter(event => event.type === "workflow-started" && event.detail?.workflow === args.workflow).length;
      if (binding.maxCalls && priorCalls >= binding.maxCalls) throw new Error(`Workflow call limit exceeded for ${args.workflow}.`);
      if (args.textFile) await this.path(member, args.textFile);
      for (const path of Object.values(args.documents || {})) await this.path(member, path);
      for (const path of Object.values(args.outputPaths || {})) {
        const target = await this.delivery.assertCallOutputPath(path);
        const normalized = target.relative.toLowerCase();
        if (normalized === "work" || normalized.startsWith("work/") && !normalized.startsWith(`work/${member.id.toLowerCase()}/`)) throw new Error("Call outputs cannot overwrite another member's work.");
      }
      const request = await this.prepareCall(structuredClone(args), this);
      if (request.textFile) {
        if (request.text !== undefined) throw new Error("text and textFile are mutually exclusive.");
        const target = await this.path(member, request.textFile);
        request.text = await readFile(target.path, "utf8");
        delete request.textFile;
      }
      this.state.pendingOperation = { kind: "workflow", id, memberId: member.id, request };
      await this.store.event("workflow-started", { detail: { ...request, operationId: id } });
      return this.finishWorkflow(this.state.pendingOperation);
    }));
    tools.push(tool("rp_team_handoff", schema({ to: string }, []), "After your substantive speech, call this tool alone to hand the floor to another member. No automatic rotation.", async (_id, args) => {
      const to = args.to || (this.config.members.length === 2 ? this.config.members.find(entry => entry.id !== member.id).id : null);
      if (!to || to === member.id || !this.config.members.some(entry => entry.id === to)) throw new Error("Choose another valid member; to is required in larger teams.");
      this.state.activeMemberId = to;
      await this.store.event("handoff", { memberId: member.id, result: { to } });
      return { handedOff: true, to };
    }, true));
    if (member.id === this.config.stageOwnerId) tools.push(tool("rp_task_next", schema({}), "After summarizing the current stage, call alone. You keep the floor for the next stage.", async id => {
      const result = await this.stages.advance(id);
      this.state.stageState = this.stages.snapshot();
      await this.store.event("stage-advanced", { result, text: this.stages.currentText });
      return { ...result, currentTask: this.stages.currentText };
    }));
    if (Object.values(this.config.outputOwners).includes(member.id)) tools.push(tool("rp_deliver", schema({ output: { enum: Object.entries(this.config.outputOwners).filter(([, owner]) => owner === member.id).map(([id]) => id) }, path: string }), "Deliver an owned working document. This does not end the team node.", async (_id, args) => {
      if (this.config.outputOwners[args.output] !== member.id) throw new Error("You do not own this output.");
      const target = await this.path(member, args.path, true);
      this.state.pendingOperation = { kind: "delivery", id: _id, memberId: member.id, ...args, digest: await this.workingDigest(target.path) };
      await this.store.save();
      const result = await this.delivery.deliver(args);
      this.state.pendingOperation = null;
      return result;
    }));
    if (member.id === this.config.completionMemberId) tools.push(tool("rp_node_complete", schema({}), "Call alone after all stages, required calls and deliveries are complete. Ends the whole team.", async () => {
      const result = await this.delivery.complete();
      this.state.status = "completed";
      await this.store.event("node-completed", { result });
      return result;
    }, true));
    return tools;
  }
}
