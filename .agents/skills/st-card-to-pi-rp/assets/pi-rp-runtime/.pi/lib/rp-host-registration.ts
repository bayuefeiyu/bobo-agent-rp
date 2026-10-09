

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { selectRecords } from "./rp-records.mjs";

import { resolveNodeQueryBudget } from "./rp-workflows.mjs";

import { DATA_GET_PARAMETERS, DATA_GET_REQUIRED, DATA_QUERY_PARAMETERS, DATA_QUERY_REQUIRED } from "./rp-data-tool-schemas.mjs";

import { nodeDataAccess, requireCurrentAgentTool, resolveWorkflowIdentity, workflowDataReadAccess } from "./rp-node-data-access.ts";

import { bridgeBusy, unfinishedWorkflowRunCount } from "./rp-turn-state.ts";

import { capabilityAllows } from "./rp-data-contracts.mjs";

import { getDataRecord, queryData } from "./rp-data-query.mjs";

import { createDataBatchDraft, executeDataBatch, updateDataBatchDraft } from "./rp-data-changes.mjs";

import { workflowNodeWorkspace } from "./rp-data-artifacts.mjs";

import { messageSourceReference } from "./rp-narrative-source.mjs";

import { toolParameters, authoritativeTranscript, resolveCardDirectory } from "./rp-host-utils.ts";
import type { RecordEnvelope, ActiveBridge, RpRun, RpDataStore } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  startBridge: (cardArgument: string, context: ExtensionContext) => Promise<any>;
  currentDataNode: () => { entry: any; node: any; store: RpDataStore; };
  scope: HostSessionScope<ActiveBridge>;
  rememberDataReceipt: (run: any, nodeId: string, receipt: any) => any;
  turn: { current: RpRun | null };
  writeContextReceipt: (target: ActiveBridge, run: RpRun) => Promise<void>;
  boundCardId: string | null;
  isolatedRuntime: boolean;
  stopBridge: () => Promise<void>;
};
export function createHostRegistration({ startBridge, currentDataNode, scope, rememberDataReceipt, turn, writeContextReceipt, boundCardId, isolatedRuntime, stopBridge }: Dependencies) {
return (pi: ExtensionAPI) => {
pi.registerTool({
    name: "start_rp_web",
    label: "Start RP Web",
    description: "Open a converted card's own Web UI and bind it to the current Pi session.",
    parameters: Type.Object({ card: Type.String({ description: "Card ID or path below cards/" }) }),
    async execute(_toolCallId, parameters, _signal, _onUpdate, context) {
      const url = await startBridge(parameters.card, context);
      return { content: [{ type: "text", text: `Card Web UI is bound to this Pi session at ${url}` }] };
    },
  });
pi.registerTool({
    name: "rp_data_query",
    label: "Query RP data",
    description: "Query one module collection through declared indexes/content search and return only an authorized named view under the node's query budget.",
    parameters: toolParameters(DATA_QUERY_PARAMETERS, DATA_QUERY_REQUIRED),
    async execute(_toolCallId, parameters) {
      return scope.run(async () => {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_query", async (agentId: string) => scope.requireCurrent()!.configStore.getAgent(agentId));
      const access = nodeDataAccess(node, String(parameters.moduleId), String(parameters.collectionId));
      const budget = resolveNodeQueryBudget(access, entry.run.payload);
      const result = await queryData(store, parameters, {
        capabilities: access.capabilities,
        views: access.views,
        runtimeLimit: budget.maxRecords,
        runtimeCharacters: budget.maxCharacters,
        nodeLimit: budget.maxRecords,
        nodeCharacters: budget.maxCharacters,
        ...workflowDataReadAccess(entry.run, store, entry.run.nodes[node.id]?.dataReadBatchIds || entry.run.inheritedDataReadBatchIds || []),
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };

      });
    },
  });
pi.registerTool({
    name: "rp_data_get",
    label: "Read one RP data record",
    description: "Read one exact RP data record through an authorized named view.",
    parameters: toolParameters(DATA_GET_PARAMETERS, DATA_GET_REQUIRED),
    async execute(_toolCallId, parameters) {
      return scope.run(async () => {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_get", async (agentId: string) => scope.requireCurrent()!.configStore.getAgent(agentId));
      const access = nodeDataAccess(node, String(parameters.moduleId), String(parameters.collectionId));
      const result = await getDataRecord(store, parameters, { capabilities: access.capabilities, views: access.views, ...workflowDataReadAccess(entry.run, store, entry.run.nodes[node.id]?.dataReadBatchIds || entry.run.inheritedDataReadBatchIds || []) });
      return { content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "Record not found." }], details: result };

      });
    },
  });
pi.registerTool({
    name: "rp_data_resolve",
    label: "Resolve RP data identity",
    description: "Resolve one registered ID, display name, or alias within the current node's authorized collections.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, parameters) {
      return scope.run(async () => {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_resolve", async (agentId: string) => scope.requireCurrent()!.configStore.getAgent(agentId));
      const matches = (await resolveWorkflowIdentity(entry.run, store, parameters.value, entry.run.nodes[node.id]?.dataReadBatchIds || entry.run.inheritedDataReadBatchIds || [])).filter((entry: any) => {
        const access = node.moduleAccess?.find((item: any) => item.moduleId === entry.moduleId && item.collectionId === entry.collectionId);
        return access && capabilityAllows(store.module(entry.moduleId).contract, access.capabilities, { collectionId: entry.collectionId, action: "query" });
      });
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }], details: matches };

      });
    },
  });
pi.registerTool({
    name: "rp_data_change",
    label: "Update an RP data draft",
    description: "Add, replace, or cancel idempotent operations in one explicitly declared node output change draft. This does not commit authoritative data.",
    parameters: Type.Object({
      output: Type.String(),
      commitPolicy: Type.Optional(Type.Union([Type.Literal("atomic"), Type.Literal("grouped"), Type.Literal("best-effort")])),
      changes: Type.Array(Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("cancel")]), operationId: Type.String(), operation: Type.Optional(Type.Any()) }), { minItems: 1, maxItems: 100 }),
    }),
    async execute(_toolCallId, parameters) {
      return scope.run(async () => {
      const { entry, node } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_change", async (agentId: string) => scope.requireCurrent()!.configStore.getAgent(agentId));
      const output = node.outputs?.[parameters.output];
      if (!output || output.format !== "unified-change-batch") throw new Error(`Node output ${parameters.output} is not a declared unified change batch.`);
      const root = workflowNodeWorkspace(scope.requireCurrent()!.sessionDirectory!, entry.workflow.id, entry.run.id, node.id);
      const path = resolve(root, output.path);
      await mkdir(resolve(path, ".."), { recursive: true });
      const current = await readFile(path, "utf8").then(JSON.parse).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return createDataBatchDraft({ batchId: `${entry.run.id}-${node.id}-${parameters.output}`, commitPolicy: parameters.commitPolicy || "atomic" });
      });
      const next = updateDataBatchDraft(current, parameters.changes);
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return { content: [{ type: "text", text: `Data draft ${parameters.output} now contains ${next.operations.length} operation(s).` }], details: { output: parameters.output, batchId: next.batchId, operationCount: next.operations.length } };

      });
    },
  });
pi.registerTool({
    name: "rp_data_submit",
    label: "Submit an RP data draft",
    description: "Validate and submit one explicitly declared node output change draft now. Node-end handling will recognize the receipt and not duplicate it.",
    parameters: Type.Object({ output: Type.String() }),
    async execute(_toolCallId, parameters) {
      return scope.run(async () => {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_submit", async (agentId: string) => scope.requireCurrent()!.configStore.getAgent(agentId));
      const output = node.outputs?.[parameters.output];
      if (!output || output.format !== "unified-change-batch") throw new Error(`Node output ${parameters.output} is not a declared unified change batch.`);
      const path = resolve(workflowNodeWorkspace(scope.requireCurrent()!.sessionDirectory!, entry.workflow.id, entry.run.id, node.id), output.path);
      const batch = JSON.parse(await readFile(path, "utf8"));
      const receipt = rememberDataReceipt(entry.run, node.id, await executeDataBatch(store, batch, {
        access: node.moduleAccess,
        allowBestEffort: node.dataCommit?.allowBestEffort === true,
        context: { initiatorKind: "agent", initiatorId: node.agentId || node.id, workflowId: entry.workflow.id, workflowRunId: entry.run.id, nodeId: node.id, binding: { turn: entry.run.turn || 0, messageId: turn.current?.assistantMessageId || null }, sourceReferences: entry.run.sourceReferences || [] },
      }));
      return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };

      });
    },
  });
pi.registerTool({
    name: "rp_message_query",
    label: "Query RP message history",
    description: "Select exact prior Web RP messages when the card's message policy enables Agent selection.",
    parameters: Type.Object({
      decision: Type.Union([Type.Literal("select"), Type.Literal("success_empty"), Type.Literal("not_triggered")]),
      selector: Type.Optional(Type.Object({
        type: Type.Union([Type.Literal("all"), Type.Literal("latest"), Type.Literal("ids"), Type.Literal("range"), Type.Literal("around")]),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        ids: Type.Optional(Type.Array(Type.String())),
        fromSequence: Type.Optional(Type.Integer({ minimum: 0 })),
        toSequence: Type.Optional(Type.Integer({ minimum: 0 })),
        id: Type.Optional(Type.String()),
        before: Type.Optional(Type.Integer({ minimum: 0 })),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
      })),
    }),
    async execute(_toolCallId, parameters) {
      return scope.run(async () => {
      if (!scope.requireCurrent()?.pending || !turn.current || scope.requireCurrent().cardId !== turn.current.cardId || scope.requireCurrent().recordId !== turn.current.recordId) throw new Error("rp_message_query requires an active Web RP narrative turn.");
      const source = "messages";
      const policy = scope.requireCurrent().messagePolicy;
      if (policy.agent.mode === "disabled") throw new Error("Agent message retrieval is disabled for this card.");
      if (turn.current.agentQueries.some(query => query.source === source)) throw new Error("rp_message_query already resolved message history for this turn.");
      const records = scope.requireCurrent().messages.filter(record => record.sequence < turn.current!.submittedSequence);
      const fallback = () => selectRecords(records, policy.code.selector).records as RecordEnvelope[];
      let selected: RecordEnvelope[] = [];
      let status = "success";
      let error = "";
      try {
        if (parameters.decision === "not_triggered") {
          selected = policy.agent.onNotTriggered === "code" ? fallback() : [];
          status = policy.agent.onNotTriggered === "code" ? "not-triggered-code-fallback" : "not-triggered-empty";
        } else if (parameters.decision === "success_empty") {
          status = "success-empty";
        } else {
          if (!parameters.selector) throw new Error("decision=select requires selector.");
          const result = selectRecords(records, parameters.selector, policy.agent.maxRecords);
          if (result.missing.length) throw new Error(`Requested message IDs were not found: ${result.missing.join(", ")}`);
          if (!result.records.length) throw new Error("The selector returned no messages; use success_empty when intentional.");
          selected = result.records as RecordEnvelope[];
        }
      } catch (queryError) {
        selected = fallback();
        status = "failed-code-fallback";
        error = (queryError as Error).message;
      }
      if (policy.agent.mode === "append") {
        const automatic = new Set(turn.current.automaticSelections[source] || []);
        selected = selected.filter(record => !automatic.has(record.id));
      }
      const receipt = { source, mode: policy.agent.mode, decision: parameters.decision, selector: parameters.selector || null, status, error: error || null, selectedRecordIds: selected.map(record => record.id), queriedAt: new Date().toISOString() };
      turn.current.agentQueries.push(receipt);
      if (turn.current.workflowRunId) await scope.requireCurrent().workflowEngine.addSourceReferences(turn.current.workflowRunId, selected.map(messageSourceReference));
      await writeContextReceipt(scope.requireCurrent(), turn.current);
      return { content: [{ type: "text", text: [`RP message query: ${status}`, error ? `Reason: ${error}` : "", authoritativeTranscript(scope.requireCurrent(), selected)].filter(Boolean).join("\n\n") }], details: receipt };

      });
    },
  });
pi.registerCommand("rp-web", {
    description: "Open a card Web UI bound to this Pi session",
    handler: async (argumentsText, context) => {
      if (!argumentsText.trim()) {
        context.ui.notify("Usage: /rp-web <card-id>", "warning");
        return;
      }
      await startBridge(argumentsText, context);
    },
  });
pi.registerCommand("rp-web-reset", {
    description: "Start a fresh Pi session and reopen a card's Web chat selector",
    handler: async (argumentsText, context) => {
      const cardId = argumentsText.trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cardId)) {
        context.ui.notify("Usage: /rp-web-reset <card-id>", "warning");
        return;
      }
      if (boundCardId && cardId !== boundCardId) throw new Error("Return to the card selector to open another card.");
      resolveCardDirectory(context.cwd, cardId);
      await context.waitForIdle();
      const result = await context.newSession({
        withSession: async replacementContext => {
          await replacementContext.sendUserMessage(`/rp-web ${cardId}`, { expandPromptTemplates: true });
        },
      });
      if (result.cancelled) context.ui.notify("Web RP chat selection was cancelled.", "warning");
    },
  });
if (isolatedRuntime) pi.registerCommand("rp-web-shutdown", {
    description: "Close this card's Web bridge and Pi process",
    handler: async (_argumentsText, context) => {
      if (scope.requireCurrent() && (bridgeBusy(scope.requireCurrent()) || unfinishedWorkflowRunCount(scope.requireCurrent()) > 0)) throw new Error("The card is still processing work.");
      await stopBridge();
      context.shutdown();
    },
  });
pi.on("session_before_switch", stopBridge);
pi.on("session_shutdown", stopBridge);
};
}
