import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AssistanceTaskManager } from "./rp-assistance-tasks.mjs";
import { normalizeTeamDefinition, teamAbilityCatalog, validateTeamBudgets } from "./rp-team-config.mjs";
import { consumeTeamBudget, recordTeamUsage, reserveTeamBudget, TeamStateStore } from "./rp-team-state.mjs";

function plainJson(text, label) {
  const normalized = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(normalized); }
  catch { throw new Error(`${label} must return valid JSON.`); }
}

function reportText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.content === "string") return result.content;
  if (typeof result?.output === "string") return result.output;
  return JSON.stringify(result?.output ?? result ?? null, null, 2);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonDocument(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeRelative(path, label) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) throw new Error(`${label} must be a safe relative path.`);
  return path.replaceAll("\\", "/");
}

function assistantCatalogText(team) {
  const catalog = teamAbilityCatalog(team);
  if (!catalog.length) return "No optional assistants are available in this meeting.";
  return catalog.map(item => [
    `- ${item.id}: ${item.title}`,
    item.purpose ? `  Purpose: ${item.purpose}` : "",
    item.limitations ? `  Limitations: ${item.limitations}` : "",
    item.requestExample ? `  Natural-language example: ${item.requestExample}` : "",
  ].filter(Boolean).join("\n")).join("\n");
}

function controlFrom(result) {
  if (result?.control && ["continue", "wait", "close"].includes(result.control.action)) return result.control;
  return null;
}

function stableReferenceId(item) {
  if (typeof item?.referenceId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item.referenceId)) return item.referenceId;
  const seed = `${String(item?.title || "reference").trim()}\n${String(item?.summary || "").trim()}`;
  return `reference-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function normalizeReferenceUpdates(items, label = "Reference updates") {
  if (!Array.isArray(items)) throw new Error(`${label} must be an array.`);
  const normalized = items.map((raw, index) => {
    const item = plainObject(raw, `${label}[${index}]`);
    requiredText(item.title, `${label}[${index}].title`);
    requiredText(item.summary, `${label}[${index}].summary`);
    if (!["created", "updated"].includes(item.change)) throw new Error(`${label}[${index}].change must be created or updated.`);
    return { ...item, referenceId: stableReferenceId(item) };
  });
  if (new Set(normalized.map(item => item.referenceId)).size !== normalized.length) throw new Error("Reference updates must use unique referenceId values.");
  return normalized;
}

function validateStructuredReport(text, label, { normalizeReferences = false } = {}) {
  const parsed = plainObject(plainJson(text, label), label);
  plainObject(parsed.report, `${label} report`);
  if (!Array.isArray(parsed.referenceUpdates)) throw new Error(`${label} referenceUpdates must be an array.`);
  return {
    ...parsed,
    referenceUpdates: normalizeReferences ? normalizeReferenceUpdates(parsed.referenceUpdates, `${label} referenceUpdates`) : parsed.referenceUpdates,
  };
}

function validateCoordination(text) {
  const parsed = plainObject(plainJson(text, "Secretary coordination"), "Secretary coordination");
  if (!Array.isArray(parsed.requests)) throw new Error("Secretary coordination requests must be an array.");
  const requestIds = new Set();
  const requests = parsed.requests.map((raw, index) => {
    const request = plainObject(raw, `Secretary coordination requests[${index}]`);
    const requestId = requiredText(request.requestId, `Secretary coordination requests[${index}].requestId`);
    if (requestIds.has(requestId)) throw new Error(`Secretary coordination requestId is duplicated: ${requestId}.`);
    requestIds.add(requestId);
    requiredText(request.abilityId, `Secretary coordination requests[${index}].abilityId`);
    requiredText(request.text, `Secretary coordination requests[${index}].text`);
    if (!["dispatch", "covered", "reject"].includes(request.disposition)) throw new Error(`Secretary coordination requests[${index}].disposition is invalid.`);
    if (typeof request.reason !== "string") throw new Error(`Secretary coordination requests[${index}].reason must be a string.`);
    return { ...request, requestId };
  });
  return { ...parsed, requests };
}

function validateReferenceDocuments(text, expectedIds) {
  const parsed = plainJson(text, "Secretary reference documents");
  if (!Array.isArray(parsed)) throw new Error("Reference-writing output must be an array.");
  const seen = new Set();
  const references = parsed.map((raw, index) => {
    const item = plainObject(raw, `Reference-writing output[${index}]`);
    const referenceId = requiredText(item.referenceId, `Reference-writing output[${index}].referenceId`);
    if (seen.has(referenceId)) throw new Error(`Reference-writing output duplicates referenceId ${referenceId}.`);
    seen.add(referenceId);
    requiredText(item.title, `Reference-writing output[${index}].title`);
    requiredText(item.summary, `Reference-writing output[${index}].summary`);
    requiredText(item.content, `Reference-writing output[${index}].content`);
    if (!["created", "updated"].includes(item.change)) throw new Error(`Reference-writing output[${index}].change must be created or updated.`);
    if (!Array.isArray(item.sources) || item.sources.some((source, sourceIndex) => {
      try {
        plainObject(source, `Reference-writing output[${index}].sources[${sourceIndex}]`);
        requiredText(source.label, `Reference-writing output[${index}].sources[${sourceIndex}].label`);
        requiredText(source.reference, `Reference-writing output[${index}].sources[${sourceIndex}].reference`);
        return false;
      } catch {
        return true;
      }
    })) throw new Error(`Reference-writing output[${index}].sources must contain {label,reference} objects.`);
    return item;
  });
  if (references.length !== expectedIds.size || references.some(item => !expectedIds.has(item.referenceId))) throw new Error("Reference-writing output does not match the approved reference list.");
  return references;
}

export class TeamMeetingRuntime {
  constructor({ config, workspace, runId, nodeId, invokeMember, startWorkflow, invokeTool = async () => { throw new Error("No team tool adapter is registered."); }, isCancelled = () => false, context = "" }) {
    this.config = normalizeTeamDefinition(config);
    validateTeamBudgets(this.config);
    this.workspace = resolve(workspace);
    this.store = new TeamStateStore(resolve(this.workspace, "team"));
    this.runId = runId;
    this.nodeId = nodeId;
    this.invokeMemberAdapter = invokeMember;
    this.startWorkflow = startWorkflow;
    this.invokeTool = invokeTool;
    this.isCancelled = isCancelled;
    this.context = context;
    this.coordination = Promise.resolve();
    this.coordinationError = null;
  }

  async run() {
    const frozenConfig = await readFile(resolve(this.workspace, "team/config.json"), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (frozenConfig) {
      this.config = normalizeTeamDefinition(frozenConfig);
      validateTeamBudgets(this.config);
    }
    const state = await this.store.ensure(this.config, { runId: this.runId, nodeId: this.nodeId });
    if (state.completionRecovery?.status === "blocked") {
      throw Object.assign(new Error(state.completionRecovery.reason), { code: "workflow_recovery_required", output: structuredClone(state) });
    }
    if (state.status === "completed") return this.#resumeCompleted(state);
    const confirmedPublications = Object.values(state.tasks || {}).filter(task => task.status === "publishing" && task.publication?.status === "confirmed");
    if (confirmedPublications.length) {
      for (const task of confirmedPublications) task.status = "succeeded";
      await this.store.event(state, "assistance-publications-recovered", { taskIds: confirmedPublications.map(task => task.taskId) });
    }
    const uncertainTasks = Object.values(state.tasks || {}).filter(task => ["running", "queued", "publishing"].includes(task.status));
    if (state.status === "awaiting-recovery" && uncertainTasks.length) {
      for (const task of uncertainTasks) {
        const nextAttempt = (task.attempt || 1) + 1;
        const retryReservationId = `${task.taskId}#attempt-${nextAttempt}`;
        reserveTeamBudget(state, "retries", retryReservationId);
        consumeTeamBudget(state, retryReservationId);
        task.attempt = nextAttempt;
        task.status = "queued";
        task.error = null;
        delete task.publication;
        delete task.startedAt;
        delete task.completedAt;
        if (!state.pendingTaskIds.includes(task.taskId)) state.pendingTaskIds.push(task.taskId);
      }
      state.status = "running";
      state.error = null;
      await this.store.event(state, "meeting-recovery-resumed", { requeuedTaskIds: uncertainTasks.map(task => task.taskId) });
    } else if (uncertainTasks.length) {
      state.status = "awaiting-recovery";
      state.error = "interrupted_assistance_task";
      await this.store.event(state, "meeting-recovery-required", { reason: state.error });
      throw Object.assign(new Error("The meeting has an assistance task whose completion cannot be proven after restart."), { code: "workflow_recovery_required", output: state });
    }
    await this.#writeFrozenConfig();
    const abilities = [...this.config.assistants, ...(this.config.baseRetrieval ? [this.config.baseRetrieval] : [])];
    const tasks = new AssistanceTaskManager({
      state,
      store: this.store,
      abilities,
      startWorkflow: this.startWorkflow,
      invokeAgent: request => this.#assistantAgent(request, state),
      invokeTool: this.invokeTool,
      onUsage: (usage, metadata) => recordTeamUsage(state, usage, {
        attemptId: metadata?.attemptId || null,
        status: metadata?.status || null,
        outcome: metadata?.outcome || null,
        source: metadata ? `assistance:${metadata.ability.id}` : "assistance",
      }),
      onRetry: async ({ task, nextAttempt }) => {
        const retryReservationId = `${task.taskId}#attempt-${nextAttempt}`;
        reserveTeamBudget(state, "retries", retryReservationId);
        consumeTeamBudget(state, retryReservationId);
        await this.store.event(state, "assistance-retry-reserved", { taskId: task.taskId, attempt: nextAttempt, reservationId: retryReservationId });
      },
      isCancelled: this.isCancelled,
      concurrency: this.config.agenda.assistantConcurrency,
    });
    for (const batch of Object.values(state.coordinationBatches || {}).filter(item => item.status !== "completed").sort((left, right) => left.startSpeechSeq - right.startSpeechSeq)) {
      batch.status = "queued";
      this.#scheduleCoordination(state, tasks, structuredClone(batch));
    }
    try {
      if (state.phase === "initial-analysis") await this.#initialAnalysis(state);
      if (state.phase === "base-retrieval") await this.#baseRetrieval(state, tasks);
      if (state.phase === "proposal") await this.#proposal(state);
      if (state.phase === "discussion") await this.#discussion(state, tasks);
      if (state.phase === "drain") await this.#drain(state, tasks);
      if (state.phase === "closing") await this.#closing(state);
      if (state.phase === "draft") await this.#draft(state);
      if (state.phase === "review") await this.#review(state);
      if (state.phase === "revision") await this.#revision(state);
      if (state.phase === "reference-writing") await this.#references(state);
      if (state.phase === "ready") await this.#ready(state);
      return structuredClone(state.deliverables);
    } catch (error) {
      if (error?.code !== "workflow_recovery_required") {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        await this.store.event(state, "meeting-failed", { phase: state.phase, error: state.error });
      }
      throw error;
    }
  }

  async #writeFrozenConfig() {
    const path = resolve(this.workspace, "team/config.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
  }

  #completionManifest(state, deliverables, createdAt) {
    const reportContent = jsonDocument(state.final.report);
    const referencesContent = jsonDocument(state.final.referenceUpdates);
    return {
      schemaVersion: 1,
      runId: state.runId || this.runId,
      nodeId: state.nodeId || this.nodeId,
      createdAt,
      basisHash: sha256(JSON.stringify(state.final)),
      artifacts: {
        report: {
          path: deliverables.report,
          kind: "file",
          mediaType: "application/json",
          hash: sha256(reportContent),
          bytes: Buffer.byteLength(reportContent),
          sourceExecutionId: "secretary-revision",
        },
        references: {
          path: deliverables.references,
          kind: "file",
          mediaType: "application/json",
          hash: sha256(referencesContent),
          bytes: Buffer.byteLength(referencesContent),
          sourceExecutionId: state.final.referenceUpdates.length ? "secretary-references" : "secretary-revision",
        },
      },
    };
  }

  async #resumeCompleted(state) {
    const completion = state.completion;
    if (!completion?.manifest || !completion?.artifact?.relativePath || !state.final) {
      return this.#blockCompletion(state, "Completed meeting has no verifiable completion manifest or approved final basis.");
    }
    const expected = this.#completionManifest(state, state.deliverables, completion.manifest.createdAt);
    if (JSON.stringify(expected) !== JSON.stringify(completion.manifest)) {
      return this.#blockCompletion(state, "Completed meeting manifest conflicts with its approved final basis.");
    }

    const manifestContent = jsonDocument(completion.manifest);
    const rebuilds = [];
    try {
      await this.#restoreDeliverable(expected.artifacts.report, jsonDocument(state.final.report), rebuilds);
      await this.#restoreDeliverable(expected.artifacts.references, jsonDocument(state.final.referenceUpdates), rebuilds);
      const storedManifest = await this.store.readArtifact(completion.artifact.relativePath, completion.artifact.hash).catch(() => null);
      if (storedManifest !== manifestContent) {
        completion.artifact = await this.store.artifact(completion.artifact.relativePath, manifestContent);
        rebuilds.push({ path: completion.artifact.relativePath, reason: "completion-manifest-missing-or-changed" });
      }
    } catch (error) {
      return this.#blockCompletion(state, `Completed meeting deliverables could not be verified or restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (rebuilds.length) await this.store.event(state, "meeting-deliverables-restored", { artifacts: rebuilds, completionManifestHash: sha256(manifestContent) });
    return structuredClone(state.deliverables);
  }

  async #restoreDeliverable(evidence, content, rebuilds) {
    const path = safeRelative(evidence.path, "completed team deliverable path");
    if (evidence.hash !== sha256(content) || evidence.bytes !== Buffer.byteLength(content) || evidence.kind !== "file" || evidence.mediaType !== "application/json") {
      throw Object.assign(new Error(`Completed team deliverable evidence conflicts with approved content: ${path}.`), { code: "team_deliverable_manifest_conflict", path });
    }
    const absolute = resolve(this.workspace, path);
    const current = await readFile(absolute, "utf8").catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (current === content) return;
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    const verified = await readFile(absolute, "utf8");
    if (sha256(verified) !== evidence.hash || Buffer.byteLength(verified) !== evidence.bytes) {
      throw Object.assign(new Error(`Unable to restore completed team deliverable: ${path}.`), { code: "team_deliverable_restore_failed", path });
    }
    rebuilds.push({ path, reason: current === null ? "missing" : "content-changed" });
  }

  async #blockCompletion(state, reason) {
    state.status = "awaiting-recovery";
    state.error = reason;
    state.completionRecovery = { status: "blocked", reason, detectedAt: new Date().toISOString() };
    await this.store.event(state, "meeting-completion-recovery-required", { reason });
    throw Object.assign(new Error(reason), { code: "workflow_recovery_required", output: structuredClone(state) });
  }

  async #setPhase(state, phase) {
    state.phase = phase;
    await this.store.event(state, "phase-changed", { phase });
  }

  async #member(state, member, { executionId, pool, phase, round = null, prompt, deliveryId = null, speech = true, validate = null }) {
    const prior = state.executions?.[executionId];
    if (prior?.artifact?.relativePath) {
      try {
        return { content: await this.store.readArtifact(prior.artifact.relativePath, prior.artifact.hash), reused: true };
      } catch (error) {
        state.status = "awaiting-recovery";
        state.error = error instanceof Error ? error.message : String(error);
        await this.store.event(state, "meeting-recovery-required", { reason: state.error, executionId, artifact: prior.artifact.relativePath });
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: "workflow_recovery_required", output: structuredClone(state) });
      }
    }
    state.executionFailures ||= {};
    const attempt = (state.executionFailures[executionId] || 0) + 1;
    const chargedPool = attempt === 1 ? pool : "retries";
    const reservationId = `${executionId}#attempt-${attempt}`;
    reserveTeamBudget(state, chargedPool, reservationId);
    await this.store.event(state, "member-call-reserved", { executionId, attempt, memberId: member.id, pool: chargedPool, phase, round });
    let candidateContent = null;
    let candidateUsage = null;
    try {
      const memberPrompt = [
        `Team role: ${member.role}.`,
        member.focus ? `Primary focus (you may still comment on every relevant aspect):\n${member.focus}` : "",
        member.prompt ? `Member-specific instructions:\n${member.prompt}` : "",
        prompt,
      ].filter(Boolean).join("\n\n");
      const effectiveDeliveryId = deliveryId || state.latestDeliveryId || null;
      const result = await this.invokeMemberAdapter({
        executionId,
        attemptId: reservationId,
        memberId: member.id,
        freezeKey: `member:${member.id}`,
        agentId: member.agentId,
        modelId: member.modelId,
        role: member.role,
        focus: member.focus,
        memberPrompt: member.prompt,
        member,
        phase,
        round,
        deliveryId: effectiveDeliveryId,
        validateOutput: typeof validate === "function" ? validate : null,
        prompt: memberPrompt,
        workspace: resolve(this.workspace, `team/members/${member.id}`),
        sharedRoot: resolve(this.workspace, "team"),
      });
      const content = reportText(result);
      candidateContent = content;
      candidateUsage = result?.usage || null;
      const validated = typeof validate === "function" ? validate(content) : null;
      consumeTeamBudget(state, reservationId, result?.usage);
      if (speech) await this.store.publishSpeech(state, { executionId, memberId: member.id, phase, round, content, deliveryId });
      else {
        const artifact = await this.store.artifact(`drafts/${executionId}.md`, content);
        state.executions ||= {};
        state.executions[executionId] = { kind: "formal", memberId: member.id, phase, round, artifact };
        await this.store.event(state, "formal-output-published", { executionId, memberId: member.id, phase, round, artifact });
      }
      if (state.lastMemberFailure?.executionId === executionId) state.lastMemberFailure = null;
      await this.store.save(state);
      return { ...result, content, validated };
    } catch (error) {
      if (candidateContent === null && typeof error?.rejectedContent === "string") candidateContent = error.rejectedContent;
      if (candidateContent !== null && typeof validate === "function") {
        const rejected = await this.store.artifact(`diagnostics/rejected/${executionId}-attempt-${attempt}.md`, candidateContent);
        await this.store.event(state, "member-output-rejected", { executionId, attempt, memberId: member.id, phase, round, error: error instanceof Error ? error.message : String(error), artifact: rejected });
      }
      if (candidateUsage && error && typeof error === "object" && !error.usage) error.usage = candidateUsage;
      consumeTeamBudget(state, reservationId, error?.usage || candidateUsage || null);
      state.executionFailures[executionId] = attempt;
      state.lastMemberFailure = { executionId, memberId: member.id, freezeKey: `member:${member.id}`, phase, round, error: error instanceof Error ? error.message : String(error) };
      await this.store.event(state, "member-call-failed", { executionId, attempt, memberId: member.id, pool: chargedPool, phase, round, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async #assistantAgent(request, state) {
    const ability = this.config.assistants.find(item => item.id === request.abilityId && item.kind === "agent");
    if (!ability) throw new Error(`Unknown Agent assistant ability: ${request.abilityId}`);
    const member = { id: `assistant-${ability.id}`, role: "assistant", agentId: request.agentId, modelId: request.modelId, prompt: ability.prompt || "", focus: "" };
    const result = await this.invokeMemberAdapter({
      executionId: request.executionId,
      attemptId: request.attemptId || `${request.executionId}#attempt-1`,
      memberId: member.id,
      freezeKey: `assistant:${ability.id}`,
      agentId: member.agentId,
      modelId: member.modelId,
      role: member.role,
      focus: member.focus,
      memberPrompt: member.prompt,
      member,
      phase: "assistance",
      round: null,
      prompt: request.prompt,
      workspace: resolve(this.workspace, `team/tasks/${request.executionId}/member`),
      sharedRoot: resolve(this.workspace, "team"),
    });
    const content = reportText(result);
    await this.store.artifact(`tasks/${request.executionId}/agent-output.md`, `${content.trim()}\n`);
    return { ...result, content };
  }

  #sharedBrief(state, extra = "") {
    const delivered = (state.deliveredTaskIds || []).map(id => {
      const task = state.tasks?.[id];
      return task ? `- ${id} (${task.abilityId}, ${task.status}): ${JSON.stringify(task.result ?? task.error)}` : "";
    }).filter(Boolean).join("\n");
    return [
      this.context,
      "The complete published meeting transcript is available at shared/TRANSCRIPT.md. Read it whenever the task refers to earlier speeches; do not rely on a summary in place of the transcript.",
      `Available optional assistants:\n${assistantCatalogText(this.config)}`,
      delivered ? `Assistant reports delivered before this speech:\n${delivered}` : "No supplemental assistant report has been delivered yet.",
      `Keep an ordinary meeting speech near or below ${this.config.agenda.speechCharacterTarget} characters unless the issue genuinely requires more. This is a soft target, not permission to omit necessary reasoning.`,
      extra,
    ].filter(Boolean).join("\n\n");
  }

  async #initialAnalysis(state) {
    const leader = await this.#member(state, this.config.leader, {
      executionId: "initial-leader",
      pool: "preparation",
      phase: "initial-analysis",
      prompt: `${this.#sharedBrief(state)}\n\nAnalyze the supplied task and context from a high-level planning perspective. Identify uncertainties worth retrieving. Do not write the final plan yet. Requests for help may be expressed naturally.`,
    });
    for (const expert of this.config.experts) {
      await this.#member(state, expert, {
        executionId: `initial-${expert.id}`,
        pool: "preparation",
        phase: "initial-analysis",
        prompt: `${this.#sharedBrief(state, `Leader opening analysis:\n${leader.content}`)}\n\nAdd an independent critique and retrieval needs from your focus, while retaining the right to comment on all aspects.`,
      });
    }
    await this.#setPhase(state, "base-retrieval");
  }

  async #baseRetrieval(state, tasks) {
    if (this.config.baseRetrieval) {
      const secretary = await this.#member(state, this.config.secretary, {
        executionId: "base-retrieval-brief",
        pool: "preparation",
        phase: "base-retrieval",
        speech: false,
        prompt: `${this.#sharedBrief(state)}\n\nRead all initial-analysis speeches. Produce a deduplicated natural-language retrieval request for the required base retrieval. Return only the request text; do not answer it yourself.`,
      });
      reserveTeamBudget(state, "base-assistance", "base-assistance-task");
      consumeTeamBudget(state, "base-assistance-task");
      const { taskId } = await tasks.start({ abilityId: this.config.baseRetrieval.id, requestId: "base-retrieval", text: secretary.content, required: true });
      const [task] = await tasks.wait([taskId]);
      if (task.status !== "succeeded") {
        state.status = "awaiting-recovery";
        state.error = `Required base retrieval failed: ${task.error || task.status}`;
        await this.store.event(state, "meeting-recovery-required", { reason: state.error, taskId });
        throw Object.assign(new Error(state.error), { code: "workflow_recovery_required", output: structuredClone(state) });
      }
      state.deliveredTaskIds.push(taskId);
      state.latestDeliveryId = "base-retrieval-delivery";
      await this.store.registerDeliverySnapshot(state.latestDeliveryId, state.deliveredTaskIds);
      await this.store.event(state, "base-retrieval-delivered", { taskId });
    }
    await this.#setPhase(state, "proposal");
  }

  async #proposal(state) {
    await this.#member(state, this.config.leader, {
      executionId: "leader-proposal",
      pool: "preparation",
      phase: "proposal",
      prompt: `${this.#sharedBrief(state)}\n\nUsing the opening analysis, expert additions, and required retrieval, propose an initial integrated plan. Keep uncertain points explicit. This is a discussion proposal, not the formal report.`,
    });
    await this.#setPhase(state, "discussion");
  }

  async #discussion(state, tasks) {
    while (!state.closeRequested && (state.discussionRound || state.round < this.config.agenda.maxRounds)) {
      this.#throwCoordinationError();
      if (!state.discussionRound) {
        const callsNeeded = this.config.experts.length + 1;
        const discussionBudget = state.budgets.discussion;
        if (discussionBudget.limit - discussionBudget.used - discussionBudget.reserved < callsNeeded) {
          state.closeRequested = true;
          state.requestCutoffSpeechSeq = state.speechSeq;
          await this.store.event(state, "discussion-close-requested", { round: state.round, forced: true, reason: "discussion-budget-exhausted", requestCutoffSpeechSeq: state.requestCutoffSpeechSeq });
          break;
        }
        state.round += 1;
        const completed = Object.values(state.tasks || {}).filter(task => ["succeeded", "failed", "timed-out", "cancelled"].includes(task.status) && !state.deliveredTaskIds.includes(task.taskId));
        state.deliveredTaskIds.push(...completed.map(task => task.taskId));
        state.discussionRound = { round: state.round, deliveryId: `round-${state.round}-start`, deliveredTaskIds: completed.map(task => task.taskId) };
        state.latestDeliveryId = state.discussionRound.deliveryId;
        await this.store.registerDeliverySnapshot(state.latestDeliveryId, state.deliveredTaskIds);
        await this.store.event(state, "round-started", structuredClone(state.discussionRound));
      }
      const activeRound = state.discussionRound;
      const deliveryId = activeRound.deliveryId;
      for (const expert of this.config.experts) {
        await this.#member(state, expert, {
          executionId: `discussion-${activeRound.round}-${expert.id}`,
          pool: "discussion",
          phase: "discussion",
          round: activeRound.round,
          deliveryId,
          prompt: `${this.#sharedBrief(state)}\n\nDiscussion round ${activeRound.round}. Read the published speeches. Challenge, extend, or refine the emerging plan. You may naturally ask an available assistant for bounded information.`,
        });
        this.#throwCoordinationError();
      }
      const leader = await this.#member(state, this.config.leader, {
        executionId: `discussion-${activeRound.round}-leader`,
        pool: "discussion",
        phase: "discussion",
        round: activeRound.round,
        deliveryId,
        prompt: `${this.#sharedBrief(state)}\n\nClose discussion round ${activeRound.round}: respond to the experts, refine the plan, and decide whether to continue, wait for already requested assistance, or close. Use the team control mechanism. Do not close merely because the normal round target was reached if more discussion would materially help.`,
      });
      this.#throwCoordinationError();
      const roundSpeechCutoff = state.speechSeq;
      const batch = await this.#enqueueCoordination(state, activeRound.round, roundSpeechCutoff);
      this.#scheduleCoordination(state, tasks, batch);
      state.discussionRound = null;
      await this.store.save(state);
      const control = controlFrom(leader);
      if (control?.action === "close" || state.round >= this.config.agenda.maxRounds) {
        state.closeRequested = true;
        state.requestCutoffSpeechSeq = state.speechSeq;
        await this.store.event(state, "discussion-close-requested", { round: state.round, forced: !control || state.round >= this.config.agenda.maxRounds, requestCutoffSpeechSeq: state.requestCutoffSpeechSeq });
      } else if (control?.action === "wait") {
        await this.coordination;
        this.#throwCoordinationError();
        await tasks.wait();
      } else if (!control && state.round >= this.config.agenda.normalRounds) {
        state.closeRequested = true;
        state.requestCutoffSpeechSeq = state.speechSeq;
        await this.store.event(state, "discussion-close-requested", { round: state.round, forced: false, reason: "minimal-team-normal-rounds", requestCutoffSpeechSeq: state.requestCutoffSpeechSeq });
      }
    }
    await this.#setPhase(state, "drain");
  }

  async #enqueueCoordination(state, round, speechCutoff) {
    state.coordinationBatches ||= {};
    const startSpeechSeq = (state.coordinationQueuedThrough || state.coordinationCursor || 0) + 1;
    const batchId = `coordination-${String(startSpeechSeq).padStart(4, "0")}-${String(speechCutoff).padStart(4, "0")}`;
    if (state.coordinationBatches[batchId]) return structuredClone(state.coordinationBatches[batchId]);
    const batch = { batchId, round, startSpeechSeq, speechCutoff, status: "queued" };
    state.coordinationBatches[batchId] = batch;
    state.coordinationQueuedThrough = speechCutoff;
    await this.store.event(state, "coordination-batch-queued", batch);
    return structuredClone(batch);
  }

  #scheduleCoordination(state, tasks, batch) {
    this.coordination = this.coordination
      .then(() => this.#coordinateRequests(state, tasks, batch))
      .catch(async error => {
        this.coordinationError ||= error;
        const storedBatch = state.coordinationBatches?.[batch.batchId];
        if (storedBatch) storedBatch.status = "failed";
        try {
          await this.store.event(state, "coordination-batch-failed", { batchId: batch.batchId, error: error instanceof Error ? error.message : String(error) });
        } catch (saveError) {
          this.coordinationError ||= saveError;
        }
      });
  }

  #throwCoordinationError() {
    if (this.coordinationError) throw this.coordinationError;
  }

  async #coordinateRequests(state, tasks, batch) {
    const { batchId, round, startSpeechSeq, speechCutoff } = batch;
    const storedBatch = state.coordinationBatches?.[batchId];
    if (storedBatch?.status === "completed") return;
    if (storedBatch) storedBatch.status = "running";
    await this.store.event(state, "coordination-batch-started", { batchId, round, startSpeechSeq, speechCutoff });
    const result = await this.#member(state, this.config.secretary, {
      executionId: batchId,
      pool: "coordination",
      phase: "discussion",
      round,
      speech: false,
      validate: validateCoordination,
      prompt: `${this.#sharedBrief(state)}\n\nReview only published discussion speeches ${startSpeechSeq} through ${speechCutoff}; do not process later speeches even if they already exist in the transcript. Extract genuine natural-language requests for available assistants, deduplicate them, and decide disposition. Return JSON: {"requests":[{"requestId":"stable-id","abilityId":"available-id","text":"bounded retrieval request","disposition":"dispatch|covered|reject","reason":"..."}]}. Do not add research ideas nobody requested.`,
    });
    const parsed = result.validated;
    for (const request of parsed.requests) {
      const requestId = String(request.requestId || `request-${++state.requestSeq}`);
      if (request.disposition !== "dispatch") {
        await this.store.event(state, "assistance-request-resolved", { round, requestId, disposition: request.disposition || "reject", reason: request.reason || "" });
        continue;
      }
      const ability = this.config.assistants.find(item => item.id === request.abilityId && item.enabled);
      if (!ability) {
        await this.store.event(state, "assistance-request-resolved", { round, requestId, disposition: "reject", reason: "unavailable ability" });
        continue;
      }
      try {
        reserveTeamBudget(state, ability.budgetPool, `assistance-${requestId}`);
        consumeTeamBudget(state, `assistance-${requestId}`);
        await tasks.start({ abilityId: ability.id, requestId, text: String(request.text || "") });
      } catch (error) {
        await this.store.event(state, "assistance-request-resolved", { round, requestId, disposition: "reject", reason: error instanceof Error ? error.message : String(error) });
      }
    }
    state.coordinationCursor = Math.max(state.coordinationCursor, speechCutoff);
    if (storedBatch) storedBatch.status = "completed";
    await this.store.save(state);
  }

  async #drain(state, tasks) {
    await this.coordination;
    this.#throwCoordinationError();
    if (state.coordinationCursor < state.requestCutoffSpeechSeq) {
      const batch = await this.#enqueueCoordination(state, "drain", state.requestCutoffSpeechSeq);
      await this.#coordinateRequests(state, tasks, batch);
    }
    const completed = await tasks.drain();
    for (const task of completed) if (!state.deliveredTaskIds.includes(task.taskId)) state.deliveredTaskIds.push(task.taskId);
    state.latestDeliveryId = "closing-delivery";
    await this.store.registerDeliverySnapshot(state.latestDeliveryId, state.deliveredTaskIds);
    await this.store.event(state, "assistance-drained", { taskIds: completed.map(task => task.taskId), cutoffSpeechSeq: state.requestCutoffSpeechSeq });
    await this.#setPhase(state, "closing");
  }

  async #closing(state) {
    for (const expert of this.config.experts) {
      await this.#member(state, expert, {
        executionId: `closing-${expert.id}`,
        pool: "closing",
        phase: "closing",
        prompt: `${this.#sharedBrief(state)}\n\nGive your final summing statement. No new assistant requests are allowed. Reconcile the discussion and delivered reports; mark unresolved uncertainty honestly.`,
      });
    }
    await this.#member(state, this.config.leader, {
      executionId: "closing-leader",
      pool: "closing",
      phase: "closing",
      prompt: `${this.#sharedBrief(state)}\n\nGive the leader's final synthesis and decisions for the secretary. No new assistant requests are allowed. Preserve justified disagreement or uncertainty where appropriate.`,
    });
    await this.#setPhase(state, "draft");
  }

  async #draft(state) {
    const draft = await this.#member(state, this.config.secretary, {
      executionId: "secretary-draft",
      pool: "draft",
      phase: "draft",
      speech: false,
      validate: text => validateStructuredReport(text, "Secretary draft", { normalizeReferences: true }),
      prompt: `${this.#sharedBrief(state)}\n\nRead the full meeting and final synthesis. Draft the formal planning report. Return JSON with keys report and referenceUpdates. report must follow the report contract supplied in the meeting materials. referenceUpdates is an array of {referenceId,title,summary,change,content,sources}; use [] when no knowledge expansion is worth retaining.`,
    });
    state.draft = draft.validated;
    await this.store.save(state);
    await this.#setPhase(state, "review");
  }

  async #review(state) {
    const expertReviews = await Promise.all(this.config.experts.map(expert => this.#member(state, expert, {
      executionId: `review-${expert.id}`,
      pool: "review",
      phase: "review",
      speech: false,
      prompt: `${this.#sharedBrief(state, `Draft:\n${JSON.stringify(state.draft)}`)}\n\nThis is the one content-review round. Identify concrete corrections, omissions, overclaims, and internal contradictions. Do not request new investigation.`,
    })));
    const leaderReview = await this.#member(state, this.config.leader, {
      executionId: "review-leader",
      pool: "review",
      phase: "review",
      speech: false,
      prompt: `${this.#sharedBrief(state, `Draft:\n${JSON.stringify(state.draft)}\n\nExpert reviews:\n${expertReviews.map(item => item.content).join("\n\n")}`)}\n\nAdjudicate the single review round. Give the secretary one definitive revision brief. Do not reopen research or discussion.`,
    });
    state.review = { experts: expertReviews.map(item => item.content), leader: leaderReview.content };
    await this.store.save(state);
    await this.#setPhase(state, "revision");
  }

  async #revision(state) {
    const revision = await this.#member(state, this.config.secretary, {
      executionId: "secretary-revision",
      pool: "revision",
      phase: "revision",
      speech: false,
      validate: text => validateStructuredReport(text, "Secretary revision", { normalizeReferences: true }),
      prompt: `${this.#sharedBrief(state, `Draft:\n${JSON.stringify(state.draft)}\n\nLeader review decision:\n${state.review.leader}`)}\n\nProduce the final revised JSON with keys report and referenceUpdates. Apply the leader's adjudication and make only technical repairs beyond it.`,
    });
    state.final = revision.validated;
    state.final.report.referenceUpdates = state.final.referenceUpdates.map(({ referenceId, title, summary, change }) => ({ referenceId, title, summary, change }));
    await this.store.save(state);
    await this.#setPhase(state, "reference-writing");
  }

  async #references(state) {
    if (state.final.referenceUpdates.length) {
      const expected = new Set(state.final.referenceUpdates.map(item => item.referenceId));
      const result = await this.#member(state, this.config.secretary, {
        executionId: "secretary-references",
        pool: "references",
        phase: "reference-writing",
        speech: false,
        validate: text => validateReferenceDocuments(text, expected),
        prompt: `${this.#sharedBrief(state, `Approved reference list and seed content:\n${JSON.stringify(state.final.referenceUpdates)}`)}\n\nWrite only the approved reference documents. Return JSON array of {referenceId,title,summary,content,sources,change}; sources must be an array of {label,reference} objects and may be empty. Do not introduce new major themes or alter the director plan. Aim for no more than ${this.config.agenda.referenceDocumentCharacterTarget} characters per document and ${this.config.agenda.referenceTotalCharacterTarget} characters in total; these are soft clarity targets, not minimum quotas.`,
      });
      state.final.referenceUpdates = result.validated;
    }
    await this.store.save(state);
    await this.#setPhase(state, "ready");
  }

  async #ready(state) {
    const reportPath = safeRelative(this.config.deliverables.report, "team report path");
    const referencesPath = safeRelative(this.config.deliverables.references, "team references path");
    const reportContent = jsonDocument(state.final.report);
    const referencesContent = jsonDocument(state.final.referenceUpdates);
    const reportAbsolute = resolve(this.workspace, reportPath);
    await mkdir(dirname(reportAbsolute), { recursive: true });
    await writeFile(reportAbsolute, reportContent, "utf8");
    const referencesAbsolute = resolve(this.workspace, referencesPath);
    await mkdir(dirname(referencesAbsolute), { recursive: true });
    await writeFile(referencesAbsolute, referencesContent, "utf8");
    state.deliverables = { report: reportPath, references: referencesPath };
    const manifest = this.#completionManifest(state, state.deliverables, new Date().toISOString());
    const artifact = await this.store.artifact("completion-manifest.json", jsonDocument(manifest));
    state.completion = { manifest, artifact };
    state.status = "completed";
    state.phase = "ready";
    await this.store.event(state, "meeting-completed", { deliverables: state.deliverables, completion: state.completion, usage: state.usage });
  }
}

export async function runTeamMeeting(options) {
  return new TeamMeetingRuntime(options).run();
}
