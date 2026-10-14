import { randomUUID } from "node:crypto";
import { createExecutionService, executionDataStore } from "./rp-executions.mjs";
import { createSessionDataStore } from "./rp-session-data-store.ts";
import { createConversationService } from "./rp-conversation.mjs";
import { recordsToWebMessages } from "./rp-turn-state.ts";
import { httpError } from "./rp-host-utils.ts";
import type { ActiveBridge, RecordEnvelope, RpRun } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  scope: HostSessionScope<ActiveBridge>;
  turn: { current: RpRun | null };
  snapshot: () => any;
  reload: () => Promise<void>;
};

export function createAttemptsWebBridge({ scope, turn, snapshot, reload }: Dependencies) {
  const storeFor = () => createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules, playerName: scope.requireCurrent().playerName });
  const messageFor = async (id: string) => {
    const active = scope.requireCurrent();
    const store = executionDataStore(storeFor(), id);
    const messages = await createConversationService({ store, provider: active.transcriptProvider }).load() as RecordEnvelope[];
    const entry = (await createExecutionService(storeFor()).list()).executions[id];
    if (!entry || entry.id !== entry.attemptId) throw httpError(404, "Narrative attempt was not found.");
    return { entry, message: messages.find(message => message.binding.turn === entry.turn && message.data.role === "assistant") };
  };
  const idle = () => {
    const active = scope.requireCurrent();
    if (active.pending || !active.context.isIdle()) throw httpError(409, "Wait for the current narrative execution.");
    return active;
  };
  const list = async () => {
    const active = scope.requireCurrent();
    if (!active.sessionDirectory) return { revision: 0, turn: active.turn, attempts: [] as any[] };
    const saved = await createExecutionService(storeFor()).list();
    const attempts = Object.values(saved.executions).filter((entry: any) => entry.id === entry.attemptId).map((entry: any) => {
      return { id: entry.id, turn: entry.turn, status: entry.status, selected: entry.selected === true, createdAt: entry.createdAt,
        hasNarrative: Boolean(entry.narrativeDocument),
        canAdopt: entry.turn === active.turn && entry.status === "completed" && Boolean(entry.narrativeDocument),
        canRegenerate: entry.turn === active.turn && entry.policy.enabled !== false && ["completed", "failed", "cancelled", "skipped"].includes(entry.status),
        revisionSource: entry.narrativeDocument?.revisionSource || null,
      };
    });
    return { revision: saved.revision, turn: active.turn, attempts };
  };
  const getState = async (executionId: string | null = scope.executionId) => {
    const active = scope.requireCurrent();
    const state = snapshot();
    const attempts = await list();
    let messages = state.messages;
    if (executionId) {
      const { entry, message } = await messageFor(executionId);
      if (message) {
        const replacement = recordsToWebMessages([message])[0];
        const original = messages.find((item: any) => item.turn === entry.turn && item.role === "assistant");
        replacement.sequence = original?.sequence ?? replacement.sequence;
        messages = original ? messages.map((item: any) => item.turn === entry.turn && item.role === "assistant" ? { ...replacement, attemptId: entry.id } : item) : [...messages, { ...replacement, attemptId: entry.id }].sort((a: any, b: any) => a.sequence - b.sequence);
      }
    }
    return { ...state, messages, narrativeAttempts: attempts, displayExecutionId: executionId, currentTurn: active.turn };
  };
  return {
    getState,
    listNarrativeAttempts: list,
    regenerateNarrative: async (value: any = {}) => {
      const active = scope.requireCurrent();
      const replay = value.executionId && active.sessionDirectory ? (await createExecutionService(storeFor()).list()).executions[value.executionId] : null;
      if (replay) {
        const input = active.messages.find(message => message.binding.turn === active.turn && message.data.role === "user");
        if (!replay.candidate || replay.id !== replay.attemptId || replay.turn !== active.turn || replay.invocation.payload?.currentInput !== input?.data.content) throw httpError(409, "Execution ID was reused with a different request.");
        return getState();
      }
      idle();
      if (active.workflowEngine.blockingTurnRuns().length) throw httpError(409, "Finish or cancel the blocking background work first.");
      const saved = await createExecutionService(storeFor()).list();
      const previous = Object.values(saved.executions).filter((entry: any) => entry.id === entry.attemptId && entry.turn === active.turn).sort((a: any, b: any) => Number(b.selected) - Number(a.selected) || b.createdAt.localeCompare(a.createdAt))[0] as any;
      if (!previous || active.turn === 0) throw httpError(409, "The current turn has no workflow narrative to regenerate.");
      const input = active.messages.find(message => message.binding.turn === active.turn && message.data.role === "user");
      if (!input) throw httpError(409, "The current player input was not found.");
      const executionId = value.executionId || `workflow-${randomUUID()}`;
      // Request replay returns the existing execution without occupying another foreground turn.
      active.pending = true;
      active.lastTurnFailure = null;
      turn.current = {
        cardId: active.cardId, recordId: active.recordId!, submittedText: input.data.content, submittedSequence: input.sequence,
        assistantContent: "", automaticSelections: {}, agentQueries: [], agentSources: [], processorSelections: [], contextContent: null,
        phase: "narrative", assistantMessageId: null, workflowRunId: executionId, workflowNarrativeNodeId: null,
        resolveNarrative: null, rejectNarrative: null, baseModel: active.context.model,
      };
      try {
        const run = active.workflowEngine.snapshot().find((run: any) => run.id === previous.id);
        if (!run) throw httpError(409, "The original workflow execution is unavailable.");
        const workflow = await active.configStore.getModuleWorkflow(run.ownerModuleId, run.workflowId);
        turn.current.workflowNarrativeNodeId = workflow.nodes.find((node: any) => node.type === "turn-finalize")?.narrative?.fromNode || null;
        await active.workflowEngine.reexecute(previous.id, { id: executionId, currentTurn: active.turn, candidate: true, narrativeAttemptId: executionId, payload: { ...run.payload, currentInput: input.data.content, userSequence: input.sequence } });
      } catch (error) {
        active.pending = false;
        turn.current = null;
        throw error;
      }
      return getState();
    },
    adoptNarrativeAttempt: async (id: string, value: any = {}) => {
      const active = idle();
      const { entry, message } = await messageFor(id);
      if (!message || entry.turn !== active.turn) throw httpError(409, "Only a complete current-turn narrative may be adopted.");
      const pending = active.workflowEngine.blockingTurnRuns().filter((run: any) => active.workflowEngine.snapshot().find((item: any) => item.id === run.runId)?.narrativeAttemptId === id);
      if (pending.length) throw httpError(409, "This attempt still has required background work.");
      await createExecutionService(storeFor()).adopt(id, { expectedRevision: value.expectedRevision });
      await reload();
      // Stop inactive attempts from expanding. External jobs may finish, but their data context
      // stays attached to the original execution and never becomes the selected result.
      for (const run of active.workflowEngine.snapshot()) {
        if (run.turn === active.turn && run.narrativeAttemptId && run.narrativeAttemptId !== id && !["completed", "failed", "cancelled", "skipped"].includes(run.status)) await active.workflowEngine.cancel(run.id, "narrative_attempt_not_selected");
      }
      return getState(null);
    },
    reviseNarrativeAttempt: async (id: string, value: any) => {
      const active = idle();
      const { entry, message } = await messageFor(id);
      if (!message || entry.status !== "completed") throw httpError(409, "This attempt cannot be edited yet.");
      const store = executionDataStore(storeFor(), id, { allowRevision: true });
      await createConversationService({ store, provider: active.transcriptProvider }).revise(message.id, value.content, { expectedRevision: value.expectedRevision, operationId: value.operationId });
      if (entry.selected) {
        await createExecutionService(storeFor()).adopt(id, { allowPast: true });
        await reload();
      }
      return getState();
    },
    getNarrativeAttemptHistory: async (id: string, options: any = {}) => {
      const { message } = await messageFor(id);
      if (!message) throw httpError(404, "This attempt has no narrative document.");
      return createConversationService({ store: executionDataStore(storeFor(), id, { readOnly: true }), provider: scope.requireCurrent().transcriptProvider }).history(message.id, options);
    },
  };
}
