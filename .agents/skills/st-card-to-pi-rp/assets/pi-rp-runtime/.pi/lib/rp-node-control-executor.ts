
import { moduleFile } from "./rp-module-registry.mjs";
import * as promptControlsService from "./rp-prompt-controls.mjs";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";





import { playNodePrompt } from "./rp-author-prompts.mjs";
import { renderCardText, renderTeamAuthorText } from "./rp-card-text.mjs";

import { resolveCodeNodeRoute, resolveNodeQueryBudget } from "./rp-workflows.mjs";

import { narrativeOutputUnavailableError } from "./rp-model-failures.mjs";


import { parseTaskStages } from "./rp-task-stages.mjs";



import { resolveWorkflowIdentity, workflowDataReadAccess } from "./rp-node-data-access.ts";

import { copyDocumentSet, copyWorkspaceEntry, writeCollisionSafeFile } from "./rp-document-sets.mjs";


import { capabilityAllows } from "./rp-data-contracts.mjs";
import { createSessionDataStore } from "./rp-session-data-store.ts";
import { getDataRecord, queryAllData, queryData } from "./rp-data-query.mjs";

import { executeDataBatchOrThrow } from "./rp-data-changes.mjs";
import { readDataReceipt } from "./rp-data-transactions.mjs";

import { resolveCodeSubmissionBinding, resolveCodeSubmissionSourceReferences } from "./rp-data-node-runtime.mjs";
import { workflowNodeWorkspace } from "./rp-data-artifacts.mjs";

import { createRpRandomService } from "./rp-random.mjs";
import { normalizeNarrativeSource } from "./rp-narrative-source.mjs";




import { runTeamMeeting } from "./rp-team-runtime.mjs";
import { readDeclaredTeamDocuments } from "./rp-team-access.mjs";

import { recentCompletedTurnContext } from "./rp-host-utils.ts";
import type { WebMessage, RecordEnvelope, ActiveBridge, RpRun } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  scope: HostSessionScope<ActiveBridge>;
  turn: { current: RpRun | null };
  appendMessage: (message: WebMessage) => Promise<RecordEnvelope | undefined>;
  updateMetadata: () => Promise<void>;
  buildDynamicProcessorContext: (target: ActiveBridge, run: RpRun) => Promise<string>;
  rememberDataReceipt: (run: any, nodeId: string, receipt: any) => any;
  promptControlsService: typeof promptControlsService;
  resolveConfiguredModel: (target: ActiveBridge, modelId: string, frozenOverride?: any) => Promise<{ profile: any; model: any; }>;
};
export function createControlNodeExecutor({ scope, turn, appendMessage, updateMetadata, buildDynamicProcessorContext, rememberDataReceipt, promptControlsService }: Omit<Dependencies, "resolveConfiguredModel">) {
return async function executeControlNode(task: any, prepared: { callInputs: any[]; upstreamHandoffs: any[]; dataReadBatchIds: string[] }) {
    const { workflow, run, node } = task;
    const { callInputs, upstreamHandoffs, dataReadBatchIds } = prepared;
    if (node.type === "team") {
      const nodeWorkspace = workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, node.id);
      for (const ability of [...(node.team.assistants || []), ...(node.team.baseRetrieval ? [node.team.baseRetrieval] : [])]) {
        if (ability.enabled && ability.kind === "tool" && ability.adapter !== "declared-document-read-v1") {
          throw new Error(`Unsupported team tool adapter: ${ability.adapter}`);
        }
      }
      await mkdir(resolve(nodeWorkspace, "team", "shared"), { recursive: true });
      const inputs = [
        ...callInputs.map((input: any) => ({ id: input.id, producerNode: "$caller", kind: input.kind, format: "call-input", path: input.path, narrativeSource: null })),
        ...upstreamHandoffs.map((artifact: any) => ({
          id: artifact.id,
          producerNode: artifact.nodeId,
          kind: artifact.kind,
          format: artifact.format,
          path: artifact.stagedPath,
          narrativeSource: artifact.narrativeSource,
        })),
      ];
      await writeFile(resolve(nodeWorkspace, "team", "shared", "INPUTS.json"), `${JSON.stringify(inputs, null, 2)}\n`, "utf8");
      const teamNodePrompt = await playNodePrompt(scope.requireCurrent(), node);
      if (parseTaskStages(teamNodePrompt, node.promptFile || `team node ${node.id} prompt`).staged) {
        throw Object.assign(new Error(`Team node ${node.id} does not support staged task prompts.`), { code: "workflow_configuration_invalid" });
      }
      const meetingContext = [
        `Card: ${scope.requireCurrent().cardName} (${scope.requireCurrent().cardId})`,
        `Workflow: ${workflow.id}; run: ${run.id}; turn: ${run.turn ?? "unknown"}`,
        "The full authorized input catalog is at shared/INPUTS.json. Paths in that catalog are relative to the team node workspace; use the team read tool to inspect them.",
        typeof run.payload?.currentInput === "string" && run.payload.currentInput.trim() ? `Current input:\n${run.payload.currentInput.trim()}` : "",
        teamNodePrompt,
      ].filter(Boolean).join("\n\n");
      const invokeTeamTool = async (request: any) => {
        if (request?.adapter !== "declared-document-read-v1") throw new Error(`Unsupported team tool adapter: ${request?.adapter || "missing"}`);
        const documents = await readDeclaredTeamDocuments({ documents: request.documents, nodeWorkspace, maxCharacters: request.arguments?.maxCharacters });
        return { output: { adapter: request.adapter, request: String(request.text || ""), documents }, usage: null };
      };
      const teamConfig = renderTeamAuthorText(node.team, scope.requireCurrent().playerName, `team ${node.id}`);
      const deliverables = await runTeamMeeting({
        config: teamConfig,
        workspace: nodeWorkspace,
        runId: run.id,
        nodeId: node.id,
        context: meetingContext,
        invokeMember: (request: any) => task.invokeAgent(request),
        startWorkflow: (request: any, options: any) => task.invokeWorkflow(request, { ...options, parallel: true }),
        invokeTool: invokeTeamTool,
        isCancelled: task.isCancelled,
      });
      const teamState = await readFile(resolve(nodeWorkspace, "team", "state.json"), "utf8").then(JSON.parse);
      return {
        output: { deliverables },
        usage: teamState.usage,
        usageComplete: (teamState.usage?.unrecordedCalls || 0) === 0,
        context: { mode: "team", members: node.team.members.map((member: any) => ({ id: member.id, role: member.role, agentId: member.agentId, modelId: member.modelId })) },
      };
    }
    if (node.type === "turn-finalize") {
      if (!turn.current || turn.current.workflowRunId !== run.id) throw new Error("Turn finalization is not bound to the current RP turn.");
      const sourceNode = workflow.nodes.find((candidate: any) => candidate.id === node.narrative.fromNode);
      const sourceOutput = sourceNode?.outputs?.[node.narrative.output];
      if (!sourceNode || !sourceOutput) throw new Error("Turn finalization narrative source is unavailable.");
      // The narrative output only exists once its node completed. Reading a path that was never
      // produced yields a bare ENOENT that hides the real failure, so name the source node and its
      // state instead — the turn is released with the original cause still visible.
      const sourceState = run.nodes?.[sourceNode.id];
      if (sourceState && sourceState.status !== "completed") {
        throw narrativeOutputUnavailableError({ nodeId: node.id, sourceNodeId: sourceNode.id, outputId: node.narrative.output, sourceState });
      }
      const sourcePath = resolve(workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, sourceNode.id), sourceOutput.path);
      const content = (await readFile(sourcePath, "utf8").catch((error: any) => {
        if (error?.code !== "ENOENT") throw error;
        throw narrativeOutputUnavailableError({ nodeId: node.id, sourceNodeId: sourceNode.id, outputId: node.narrative.output, sourceState });
      })).trim();
      if (!content) throw new Error("The selected narrative output is empty.");
      const narrativeSource = normalizeNarrativeSource(run.nodes[sourceNode.id]?.narrativeSource, { producerKind: "agent", layer: "story" });
      const existing = scope.requireCurrent().messages.find(message => message.binding.turn === run.turn && message.data.role === "assistant");
      if (existing && existing.data.content !== content) throw new Error("This turn already has a different persisted narrative.");
      const assistantRecord = existing || await appendMessage({
          sequence: scope.requireCurrent().messages.length,
          turn: run.turn,
          role: "assistant",
          kind: "message",
          content,
          createdAt: new Date().toISOString(),
          narrativeSource,
        });
      if (!assistantRecord) throw new Error("The narrative message could not be persisted.");
      turn.current.assistantContent = content;
      turn.current.assistantMessageId = assistantRecord.id;
      turn.current.agentSettled = true;
      await updateMetadata();
      return { output: { committed: true, turn: run.turn, assistantMessageId: assistantRecord.id }, assistantMessageId: assistantRecord.id };
    }
    if (node.type === "gate") return { route: run.payload?.route || node.metadata?.defaultRoute || null };
    if (node.type === "join") return { output: Object.fromEntries(node.dependsOn.map((id: string) => [id, run.nodes[id]?.output])) };
    if (node.type === "call") {
      const documents = { ...node.documents };
      const argumentsForCall = structuredClone(node.arguments || {});
      for (const [target, source] of Object.entries(node.metadata?.argumentSources || {}) as any[]) {
        if (source === "$") argumentsForCall[target] = structuredClone(run.payload || {});
        else if (typeof source === "string" && Object.hasOwn(run.payload || {}, source)) argumentsForCall[target] = structuredClone(run.payload[source]);
      }
      if (Number.isSafeInteger(node.metadata?.includeRecentTurns) && node.metadata.includeRecentTurns > 0 && Number.isSafeInteger(run.turn)) {
        const nodeWorkspace = workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, node.id);
        await mkdir(nodeWorkspace, { recursive: true });
        await writeFile(resolve(nodeWorkspace, "recent-turns.md"), `# Recent complete turns\n\n${recentCompletedTurnContext(scope.requireCurrent(), run.turn, node.metadata.includeRecentTurns)}\n`, "utf8");
        documents["recent-turns"] = "recent-turns.md";
      }
      return { output: await task.invokeWorkflow({
        workflow: node.target,
        ...(node.metadata?.textFile !== undefined
          ? { textFile: node.metadata.textFile, ...(node.metadata.text !== undefined ? { text: node.metadata.text } : {}) }
          : { text: typeof node.metadata?.text === "string" ? node.metadata.text : run.payload?.currentInput || "" }),
        arguments: argumentsForCall,
        documents,
        outputPaths: node.outputPaths,
      }) };
    }
    if (node.type === "workflow-return") {
      const outputPaths = run.outputPaths || {};
      const parentWorkflowId = run.callContext?.parentWorkflowId;
      const parentRunId = run.callContext?.parentRunId;
      const parentNodeId = run.callContext?.parentNodeId;
      if (!parentWorkflowId || !parentRunId || !parentNodeId) throw new Error("Module workflow return is missing its parent call context.");
      const parentWorkspace = workflowNodeWorkspace(scope.requireChat().sessionDirectory, parentWorkflowId, parentRunId, parentNodeId);
      const outputs: Record<string, string> = {};
      for (const [exportId, source] of Object.entries(node.exports) as any[]) {
        const requested = outputPaths[exportId];
        if (typeof requested !== "string" || !requested) throw new Error(`Caller did not provide outputPaths.${exportId}.`);
        const destination = resolve(parentWorkspace, requested);
        const destinationRelative = relative(parentWorkspace, destination);
        if (!destinationRelative || destinationRelative.startsWith("..") || destinationRelative.includes(`..${sep}`)) throw new Error(`Output path for ${exportId} escapes the caller workspace.`);
        // A retried child run re-exports into the same caller path. Replace the previous delivery
        // instead of colliding with it: the caller asked this invocation for this export, the bytes
        // are the completed run's own output, and refusing the retry would strand the parent on a
        // path only the abandoned attempt ever wrote.
        await rm(destination, { recursive: true, force: true });
        const sourceNode = workflow.nodes.find((candidate: any) => candidate.id === source.fromNode);
        const outputDefinition = source.output ? sourceNode?.outputs?.[source.output] : null;
        if (outputDefinition?.format === "document-set") {
          await copyDocumentSet(
            resolve(workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, sourceNode.id), outputDefinition.path),
            destination,
            `${workflow.id}/${exportId}`,
          );
          outputs[exportId] = destinationRelative.replaceAll("\\", "/");
          continue;
        }
        if (outputDefinition?.kind === "directory") {
          await copyWorkspaceEntry(
            resolve(workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, sourceNode.id), outputDefinition.path),
            destination,
            `${workflow.id}/${exportId}`,
          );
          outputs[exportId] = destinationRelative.replaceAll("\\", "/");
          continue;
        }
        const content = outputDefinition
          ? await readFile(resolve(workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, sourceNode.id), outputDefinition.path), "utf8")
          : typeof run.nodes[source.fromNode]?.output === "string"
            ? run.nodes[source.fromNode].output
            : `${JSON.stringify(run.nodes[source.fromNode]?.output ?? null, null, 2)}\n`;
        await writeCollisionSafeFile(destination, String(content), `${exportId}: ${destinationRelative}`);
        outputs[exportId] = destinationRelative.replaceAll("\\", "/");
      }
      return { output: { outputs } };
    }
    if (node.type === "code") {
      if (node.metadata?.builtin === "prepare-document-workspace") {
        const nodeWorkspace = workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, node.id);
        await mkdir(nodeWorkspace, { recursive: true });
        const path = resolve(nodeWorkspace, "workspace-overview.md");
        await writeFile(path, [
          "# Node document workspace overview",
          "",
          `- workflow: \`${workflow.id}\``,
          `- run: \`${run.id}\``,
          `- turn: \`${run.turn ?? "unknown"}\``,
          "- purpose: collect explicitly prepared upstream documents before a downstream Agent starts",
          "",
          "Additional module call nodes may be inserted after this node. Their returned documents are staged into any downstream Agent whose document workspace is enabled and listed in WORKSPACE-DOCUMENTS.md.",
          "",
        ].join("\n"), "utf8");
        const preparedContext = turn.current && turn.current.workflowRunId === run.id ? await buildDynamicProcessorContext(scope.requireCurrent(), turn.current) : "";
        await writeFile(resolve(nodeWorkspace, "upstream-context.md"), preparedContext.trim()
          ? `${preparedContext.trim()}\n`
          : "# Prepared upstream context\n\nNo configured upstream context processor produced content for this turn.\n", "utf8");
        if (node.outputs?.["recent-turns"]) {
          const recentTurns = Number.isSafeInteger(workflow.turnContext?.recentCompleteTurns) ? workflow.turnContext.recentCompleteTurns : 5;
          await writeFile(resolve(nodeWorkspace, node.outputs["recent-turns"].path), [
            "# Recent complete turns",
            "",
            "This file is the frozen recent-chat input selected once for this foreground run. Later snapshots reuse this registered document.",
            "",
            recentCompletedTurnContext(scope.requireCurrent(), run.turn, recentTurns) || "No earlier complete turns are in the configured window.",
            "",
          ].join("\n"), "utf8");
        }
        return { output: { prepared: true, upstreamContext: Boolean(preparedContext.trim()) } };
      }
      if (!node.metadata?.entryFile) return { output: { acknowledged: true } };
      const entryOwner = scope.requireCurrent().featureModules.find(item => item.id === workflow.ownerModuleId);
      if (!entryOwner) throw new Error(`Workflow owner module ${workflow.ownerModuleId} is not loaded.`);
      const entryPath = await moduleFile(entryOwner.moduleDirectory, node.metadata.entryFile);
      if (relative(entryOwner.moduleDirectory, entryPath).startsWith("..")) {
        throw Object.assign(new Error(`Code node ${node.id} entryFile escapes the card directory.`), { code: "workflow_entry_invalid" });
      }
      let loaded: any;
      try {
        loaded = await import(`${pathToFileURL(entryPath).href}?run=${Date.now()}-${randomUUID()}`);
      } catch (error) {
        // A card whose script is missing or unloadable is a packaging fault, not a model fault.
        throw Object.assign(new Error(`Code node ${node.id} could not load ${node.metadata.entryFile}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }), { code: "workflow_entry_invalid" });
      }
      const execute = loaded.execute || loaded.default;
      if (typeof execute !== "function") {
        throw Object.assign(new Error(`${entryPath} must export execute().`), { code: "workflow_entry_invalid" });
      }
      const nodeWorkspace = workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, node.id);
      await mkdir(nodeWorkspace, { recursive: true });
      const store = createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules });
      const accessFor = (moduleId: string, collectionId: string) => {
        const access = node.moduleAccess?.find((item: any) => item.moduleId === moduleId && item.collectionId === collectionId);
        if (!access) throw new Error(`Code node ${node.id} has no access to ${moduleId}/${collectionId}.`);
        return access;
      };
      const data = Object.freeze({
        receipt: (batchId: string) => readDataReceipt(scope.requireChat().sessionDirectory, batchId),
        query: (request: any) => {
          const access = accessFor(request.moduleId, request.collectionId);
          const budget = resolveNodeQueryBudget(access, run.payload);
          return queryData(store, request, { capabilities: access.capabilities, views: access.views, runtimeLimit: budget.maxRecords, runtimeCharacters: budget.maxCharacters, nodeLimit: budget.maxRecords, nodeCharacters: budget.maxCharacters, ...workflowDataReadAccess(run, store, dataReadBatchIds) });
        },
        queryAll: (request: any, page: any = {}) => {
          const access = accessFor(request.moduleId, request.collectionId);
          const budget = resolveNodeQueryBudget(access, run.payload);
          return queryAllData(store, request, { capabilities: access.capabilities, views: access.views, runtimeLimit: budget.maxRecords, runtimeCharacters: budget.maxCharacters, nodeLimit: budget.maxRecords, nodeCharacters: budget.maxCharacters, ...workflowDataReadAccess(run, store, dataReadBatchIds) }, page);
        },
        get: (request: any) => {
          const access = accessFor(request.moduleId, request.collectionId);
          return getDataRecord(store, request, { capabilities: access.capabilities, views: access.views, ...workflowDataReadAccess(run, store, dataReadBatchIds) });
        },
        // `getCurrent` reads exactly like `get`: the same frozen view and the same inherited batches.
        // It used to omit the boundary entirely, so any code node could read a record committed after
        // its own run started — the one documented exception ("an exact record in an already-granted
        // collection, such as an operation lease or an expected-revision check") was never enforced,
        // and a card could use it to look past its own frozen inputs.
        getCurrent: (request: any) => {
          const access = accessFor(request.moduleId, request.collectionId);
          return getDataRecord(store, request, { capabilities: access.capabilities, views: access.views, ...workflowDataReadAccess(run, store, dataReadBatchIds) });
        },
        resolve: async (value: string) => (await resolveWorkflowIdentity(run, store, value, dataReadBatchIds)).filter((entry: any) => {
          const access = node.moduleAccess?.find((item: any) => item.moduleId === entry.moduleId && item.collectionId === entry.collectionId);
          return access && capabilityAllows(store.module(entry.moduleId).contract, access.capabilities, { collectionId: entry.collectionId, action: "query" });
        }),
        submit: async (batch: any, options: any = {}) => rememberDataReceipt(run, node.id, await executeDataBatchOrThrow(store, batch, {
          access: node.moduleAccess,
          allowBestEffort: node.dataCommit?.allowBestEffort === true,
          context: {
            initiatorKind: "code",
            initiatorId: node.id,
            workflowId: workflow.id,
            workflowRunId: run.id,
            nodeId: node.id,
            binding: resolveCodeSubmissionBinding(options.binding, {
              messages: scope.requireCurrent().messages,
              visibleThroughTurn: run.visibleThroughTurn ?? run.turn,
              fallback: { turn: run.turn || 0, messageId: node.metadata?.unboundData === true ? null : turn.current?.assistantMessageId || null },
            }),
            sourceReferences: resolveCodeSubmissionSourceReferences(options.sourceMessageIds, {
              messages: scope.requireCurrent().messages,
              visibleThroughTurn: run.visibleThroughTurn ?? run.turn,
              fallback: run.sourceReferences || [],
              expectedRevisions: options.sourceMessageRevisions ?? null,
            }),
          },
        })),
      });
      const services: Record<string, any> = {
        comfy: scope.requireCurrent().comfyUi,
        promptControls: promptControlsService,
        cardText: Object.freeze({ render: (value: string, source: string) => renderCardText(value, scope.requireCurrent()!.playerName, source) }),
      };
      if (node.runtimeServices?.includes("random")) {
        services.random = createRpRandomService({
          sessionDirectory: scope.requireChat().sessionDirectory,
          workflowId: workflow.id,
          workflowRunId: run.id,
          nodeId: node.id,
          caller: { kind: "code", id: node.id },
        });
      }
      const output = await execute(Object.freeze({
        run: structuredClone(run),
        node: structuredClone(node),
        workflow: structuredClone(workflow),
        card: { id: scope.requireCurrent().cardId, name: scope.requireCurrent().cardName },
        featureModules: scope.requireCurrent().featureModules.map(item => item.id),
        module: workflow.ownerModuleId ? (() => {
          const owner = scope.requireCurrent().featureModules.find(item => item.id === workflow.ownerModuleId);
          if (!owner) throw new Error(`Workflow owner module ${workflow.ownerModuleId} is not loaded.`);
          return Object.freeze({ id: owner.id, moduleKind: owner.moduleKind, directory: owner.moduleDirectory, resourceCatalog: structuredClone(owner.resourceCatalog) });
        })() : null,
        conversation: {
          messages: structuredClone(scope.requireCurrent().messages.filter(message => message.binding.turn <= (run.visibleThroughTurn ?? run.turn ?? scope.requireCurrent()!.turn))),
          player: { name: scope.requireCurrent().playerName, description: scope.requireCurrent().playerDescription },
          fixedContext: renderCardText(scope.requireCurrent().stableCardContext, scope.requireCurrent().playerName, "fixed_context"),
          primaryCharacters: "",
        },
        workspace: nodeWorkspace,
        data,
        calls: Object.freeze({ invoke: (request: any) => task.invokeWorkflow(request) }),
        services: Object.freeze(services),
      }));
      return { output, route: resolveCodeNodeRoute(node, output), assistantMessageId: turn.current?.assistantMessageId || null };
    }

    throw new Error(`Unsupported workflow control node: ${node.type}`);
};
}
