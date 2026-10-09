

import * as promptControlsService from "./rp-prompt-controls.mjs";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Type } from "typebox";

import { composeWorkflowNodeDynamicContext, moveModelTailToEnd } from "./rp-model-config.mjs";
import { assembleInitialContext, conciseWorkspaceIndex, currentTaskMessage, promptSourcePathAllowed, recentNarrativeMessages, seededPiMessage } from "./rp-node-context.mjs";
import { playPromptSources } from "./rp-author-prompts.mjs";
import { renderCardText } from "./rp-card-text.mjs";

import { assertDocumentWorkspaceAgentTools, canonicalWorkflowRef, resolveNodeQueryBudget } from "./rp-workflows.mjs";

import { noTextOutputError } from "./rp-model-failures.mjs";
import { createAgentDelivery, deliveryPrompt, runAgentDeliverySession } from "./rp-agent-delivery.mjs";
import { registerAgentDeliveryTools } from "./rp-agent-delivery-tools.mjs";
import { createTaskStageController, registerTaskStageTool } from "./rp-task-stages.mjs";
import { DATA_GET_PARAMETERS, DATA_GET_REQUIRED, DATA_QUERY_PARAMETERS, DATA_QUERY_REQUIRED } from "./rp-data-tool-schemas.mjs";

import { lastAgentExchange, messageText, playerProfileMessage } from "./rp-transcript-display.ts";
import { resolveWorkflowIdentity, workflowDataReadAccess } from "./rp-node-data-access.ts";


import { tokenUsageFromMessages } from "./rp-token-usage.mjs";
import { ensureWorkflowWorkspace, workflowWorkspacePaths } from "./rp-workspace.mjs";
import { capabilityAllows } from "./rp-data-contracts.mjs";
import { createSessionDataStore } from "./rp-session-data-store.ts";
import { getDataRecord, queryData } from "./rp-data-query.mjs";

import { executeDataBatch } from "./rp-data-changes.mjs";



import { workflowNodeWorkspace } from "./rp-data-artifacts.mjs";

import { createRpRandomService } from "./rp-random.mjs";
import { artifactSourceReference } from "./rp-narrative-source.mjs";

import { agentPromptRequirements } from "./rp-prompt-controls.mjs";
import { stageWorkflowCallInputs, stageWorkspaceHandoffs } from "./rp-workspace-handoff.mjs";
import { createDocumentWorkspaceSnapshot, replaceDocumentWorkspaceSnapshot, stageTriggeredDocuments, workspaceDocumentFromArtifact } from "./rp-workspace-snapshot.mjs";

import { readAuthorizedTeamMaterial } from "./rp-team-access.mjs";
import { checkpointTeamSessionAttempt, rollbackTeamSessionAttempt } from "./rp-team-session.mjs";
import { toolParameters, recentCompletedTurnContext } from "./rp-host-utils.ts";
import type { WebMessage, RecordEnvelope, ActiveBridge, RpRun } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

import { createControlNodeExecutor } from "./rp-node-control-executor.ts";

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
export function createRpNodeExecutor({ scope, turn, appendMessage, updateMetadata, buildDynamicProcessorContext, rememberDataReceipt, promptControlsService, resolveConfiguredModel }: Dependencies) {
const executeControlNode = createControlNodeExecutor({ scope, turn, appendMessage, updateMetadata, buildDynamicProcessorContext, rememberDataReceipt, promptControlsService });
return async function executeWorkflowNode(task: any) {
    if (!scope.requireCurrent()?.recordId || !scope.requireChat().sessionDirectory) throw new Error("The workflow has no active RP chat.");
    const { workflow, run, node, agent, binding } = task;
    const dataReadBatchIds = task.dataReadBatchIds || run.nodes?.[node.id]?.dataReadBatchIds || run.inheritedDataReadBatchIds || [];
    assertDocumentWorkspaceAgentTools(node, agent);
    const usesWorkspace = !task.teamMember && ["agent", "team", "code", "call"].includes(node.type);
    const callInputs = usesWorkspace ? await stageWorkflowCallInputs({ sessionDirectory: scope.requireChat().sessionDirectory, workflow, run, node }) : [];
    const triggeredDocuments = usesWorkspace ? await stageTriggeredDocuments({ sessionDirectory: scope.requireChat().sessionDirectory, workflow, run, node }) : [];
    const upstreamHandoffs = usesWorkspace ? [...triggeredDocuments, ...await stageWorkspaceHandoffs({ sessionDirectory: scope.requireChat().sessionDirectory, workflow, run, node })] : [];
    if (upstreamHandoffs.length) await scope.requireCurrent().workflowEngine.addSourceReferences(run.id, upstreamHandoffs.map(artifactSourceReference));
    if (node.type !== "agent") return executeControlNode(task, { callInputs, upstreamHandoffs, dataReadBatchIds });

    const { profile, model } = await resolveConfiguredModel(scope.requireCurrent(), binding.modelId, task.teamMember ? task.model : null);
    if (!model) throw new Error("No model is available for this workflow node.");
    const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(scope.requireChat().sessionDirectory, workflow.id, run.id, workflow.kind));
    const nodeWorkspace = node.metadata?.teamMemberWorkspace
      ? resolve(node.metadata.teamMemberWorkspace)
      : workflowNodeWorkspace(scope.requireChat().sessionDirectory, workflow.id, run.id, node.id);
    await mkdir(nodeWorkspace, { recursive: true });
    const upstreamIds = node.context.fromNodes.length ? node.context.fromNodes : node.dependsOn;
    const upstream = node.context.mode === "fixed"
      ? []
      : upstreamIds.map((id: string) => ({
          id,
          output: run.nodes[id]?.output,
          narrativeSource: run.nodes[id]?.narrativeSource,
          ...(node.context.mode === "inherit" ? { inheritedContext: run.nodes[id]?.context } : {}),
        })).filter((item: any) => item.output !== null || item.inheritedContext);
    const upstreamArtifactContent = [];
    for (const artifact of upstreamHandoffs) {
      if (artifact.kind === "directory") {
        upstreamArtifactContent.push({ id: artifact.id, nodeId: artifact.nodeId, format: artifact.format, kind: artifact.kind, narrativeSource: artifact.narrativeSource, path: artifact.stagedPath });
        continue;
      }
      const content = await readFile(resolve(nodeWorkspace, artifact.stagedPath), "utf8");
      upstreamArtifactContent.push({ id: artifact.id, nodeId: artifact.nodeId, format: artifact.format, kind: artifact.kind, narrativeSource: artifact.narrativeSource, path: artifact.stagedPath, content: content.slice(0, 50000), truncated: content.length > 50000 });
    }
    const handoffMirrorRoots = [...new Set(upstreamHandoffs.map((artifact: any) => `handoff/${artifact.nodeId}/`))];
    const workspaceDocuments: Array<Record<string, any>> = [];
    const dynamicCallOutputs: Array<Record<string, any>> = [];
    let documentSnapshotSequence = 0;
    if (node.metadata?.documentWorkspace === true) {
      const stagedTargets = new Set<string>();
      const nodeOutputInputs = new Set<string>(Array.isArray(node.metadata?.nodeOutputInputs) ? node.metadata.nodeOutputInputs : []);
      for (const dependencyId of upstreamIds) {
        if (!nodeOutputInputs.has(dependencyId)) continue;
        const dependencyOutput = run.nodes[dependencyId]?.output;
        if (dependencyOutput === undefined || dependencyOutput === null) continue;
        if (dependencyOutput?.workflow && dependencyOutput?.outputs && typeof dependencyOutput.outputs === "object") continue;
        const markdown = typeof dependencyOutput === "string";
        const targetRelative = `materials/${dependencyId}/node-output.${markdown ? "md" : "json"}`;
        const targetPath = resolve(nodeWorkspace, targetRelative);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, markdown ? `${dependencyOutput.trim()}\n` : `${JSON.stringify(dependencyOutput, null, 2)}\n`, "utf8");
        stagedTargets.add(targetRelative);
        const declared = workflow.nodes.find((candidate: any) => candidate.id === dependencyId)?.metadata?.documentIndex?.["node-output"] || {};
        workspaceDocuments.push({
          id: `${dependencyId}.node-output`,
          path: targetRelative,
          readPolicy: declared.readPolicy || "conditional",
          authority: declared.authority || "advisory",
          appliesAt: declared.appliesAt || "task",
          perspective: declared.perspective || "general",
          priority: Number.isFinite(declared.priority) ? declared.priority : 0,
          description: declared.description || `Node output from ${dependencyId}`,
        });
      }
      for (const artifact of upstreamHandoffs) {
        const targetRelative = artifact.stagedPath;
        stagedTargets.add(targetRelative);
        const declared = workflow.nodes.find((candidate: any) => candidate.id === artifact.nodeId)?.metadata?.documentIndex?.[artifact.id] || {};
        workspaceDocuments.push(workspaceDocumentFromArtifact(artifact, declared));
      }
      const index = [
        "# Node workspace document index",
        "",
        "The node author supplied the documents below. Read and apply them according to their metadata and your task prompt.",
        "",
        ...(handoffMirrorRoots.length ? [
          "## Inherited workspace mirrors",
          "",
          "Each root below is a strict allowlisted mirror of part of an upstream node workspace. Unless an output was deliberately renamed with `as`, paths inside an inherited knowledge map remain relative to that mirror root. Do not resolve those paths from this node workspace root.",
          "",
          ...handoffMirrorRoots.map(root => `- \`${root}\``),
          "",
        ] : []),
        ...workspaceDocuments.flatMap(document => [
          `## ${document.id}`,
          "",
          `- path: \`${document.path}\``,
          ...(document.entryPath && document.entryPath !== document.path ? [`- entry: \`${document.entryPath}\``] : []),
          ...(document.kind ? [`- kind: \`${document.kind}\``] : []),
          `- readPolicy: \`${document.readPolicy}\``,
          `- authority: \`${document.authority}\``,
          `- appliesAt: \`${document.appliesAt}\``,
          `- perspective: \`${document.perspective}\``,
          `- priority: \`${document.priority}\``,
          `- description: ${document.description}`,
          "",
        ]),
      ].join("\n");
      await writeFile(resolve(nodeWorkspace, "WORKSPACE-DOCUMENTS.md"), index, "utf8");
    }
    let customContext = "";
    if (node.context.mode === "custom") {
      if (!node.context.processor) throw new Error(`Custom context node ${node.id} must name a processor.`);
      const processorPath = resolve(scope.requireCurrent().cardDirectory, "runtime", "workflow-context", `${node.context.processor}.mjs`);
      const loaded: any = await import(`${pathToFileURL(processorPath).href}?run=${Date.now()}-${randomUUID()}`);
      const buildContext = loaded.buildContext || loaded.default;
      if (typeof buildContext !== "function") throw new Error(`${processorPath} must export buildContext().`);
      const result = await buildContext(Object.freeze({
        card: Object.freeze({ id: scope.requireCurrent().cardId, name: scope.requireCurrent().cardName }),
        player: Object.freeze({ name: scope.requireCurrent().playerName, description: scope.requireCurrent().playerDescription }),
        openingId: scope.requireCurrent().openingId,
        turn: run.turn,
        payload: structuredClone(run.payload),
        messages: structuredClone(scope.requireCurrent().messages.filter(message => message.binding.turn <= (run.visibleThroughTurn ?? run.turn ?? scope.requireCurrent()!.turn))),
        upstream: structuredClone(upstream),
      }));
      if (typeof result !== "string") throw new Error(`Workflow context processor ${node.context.processor} must return a string.`);
      customContext = result;
    }
    const legacyDynamicContext = composeWorkflowNodeDynamicContext({
      workflowKind: workflow.kind,
      turn: run.turn,
      recentCompleteTurns: workflow.turnContext?.recentCompleteTurns,
      recentContext: workflow.kind === "foreground" && node.metadata?.documentWorkspace !== true && node.metadata?.initialContext?.recentNarrative !== true && Number.isSafeInteger(run.turn) ? recentCompletedTurnContext(scope.requireCurrent(), run.turn, workflow.turnContext.recentCompleteTurns) : "",
      callContext: run.callContext,
      documentWorkspace: node.metadata?.documentWorkspace === true,
      handoffMirrorRoots,
      customContext,
    });
    const legacyUpstreamArtifacts = node.metadata?.documentWorkspace === true
      ? ""
      : upstream.length || upstreamArtifactContent.length ? `Upstream node outputs and declared artifacts:\n${JSON.stringify({ outputs: upstream, artifacts: upstreamArtifactContent }, null, 2)}` : "";
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const dataStore = createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules });
    let teamControl: any = null;
    // One recorder per node attempt: `requiredCalls` is checked against the calls this turn really
    // made, so a retrieval the workflow declared mandatory cannot silently degrade into a narrative
    // written from memory.
    const requiredCalls: string[] = Array.isArray(node.requiredCalls) ? node.requiredCalls : [];
    const calledTargets = new Set<string>();
    const failedTargets = new Map<string, string>();
    let workerSession: any = null;
    let delivery: any = null;
    let stageController: any = null;
    const nodeToolFactory = {
      name: "rp-node-tools",
      hidden: true,
      factory(workerPi: any) {
        if (delivery) {
          registerAgentDeliveryTools(workerPi, delivery, { currentMessages: () => workerSession?.messages || [] }, Type);
          registerTaskStageTool(workerPi, stageController, {
            currentMessages: () => workerSession?.messages || [],
            enqueueStage: (message: string) => {
              if (!workerSession) throw new Error("The Agent session is not ready for the next task stage.");
              return workerSession.sendUserMessage(message, { deliverAs: "steer", expandPromptTemplates: false });
            },
          }, Type);
        }
        if (node.metadata?.teamMember === true) {
          const teamRoot = resolve(node.metadata.teamSharedRoot);
          const teamNodeRoot = dirname(teamRoot);
          const memberRoot = resolve(nodeWorkspace);
          workerPi.registerTool({
            name: "rp_team_read",
            label: "Read team material",
            description: "Read one explicitly named meeting input, published transcript, delivered assistant report, or member-local artifact. Paths beginning shared/ resolve from the team root; delivered task paths must appear in shared/DELIVERIES.json; member/ resolves from your private member workspace.",
            parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false }),
            async execute(_id: string, parameters: any) {
              const result = await readAuthorizedTeamMaterial({ path: parameters.path, teamRoot, teamNodeRoot, memberRoot, deliveryId: task.teamMember?.deliveryId || null });
              return { content: [{ type: "text", text: result.content }], details: { path: result.path, characters: result.characters } };
            },
          });
          if ((task.teamMember?.role || task.teamMember?.member?.role) === "leader" && ["discussion"].includes(task.teamMember?.phase)) {
            workerPi.registerTool({
              name: "rp_team_control",
              label: "Control team discussion",
              description: "After completing this round's substantive speech, choose whether the meeting should continue, wait only for already requested assistance, or close discussion and drain all requests before final summing statements.",
              parameters: Type.Object({
                action: Type.Union([Type.Literal("continue"), Type.Literal("wait"), Type.Literal("close")]),
                reason: Type.String({ minLength: 1, maxLength: 1000 }),
              }, { additionalProperties: false }),
              async execute(_id: string, parameters: any) {
                teamControl = structuredClone(parameters);
                return { content: [{ type: "text", text: `Discussion control recorded: ${parameters.action}.` }], details: teamControl };
              },
            });
          }
        }
        if (agent?.tools?.includes("rp_roll")) {
        const random = createRpRandomService({
          sessionDirectory: scope.requireChat().sessionDirectory,
          workflowId: workflow.id,
          workflowRunId: run.id,
          nodeId: node.id,
          caller: { kind: "agent", id: agent.id },
        });
        workerPi.registerTool({
          name: "rp_roll",
          label: "Roll dice",
          description: "Roll one or more groups of fair dice. A key identifies one logical roll in this workflow node; retrying the same key and parameters replays the original result.",
          parameters: Type.Object({
            key: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
            dice: Type.Array(Type.Object({
              count: Type.Integer({ minimum: 1, maximum: 100 }),
              sides: Type.Integer({ minimum: 2, maximum: 1000000 }),
            }, { additionalProperties: false }), { minItems: 1, maxItems: 10 }),
            modifier: Type.Optional(Type.Integer({ minimum: -1000000000, maximum: 1000000000 })),
            reason: Type.Optional(Type.String({ maxLength: 500 })),
          }, { additionalProperties: false }),
          async execute(_id: string, parameters: any) {
            const result = await random.roll(parameters);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          },
        });
        }
        if (node.workflowCalls?.length) {
        const callSignatures = node.workflowCalls.map((callBinding: any) => {
          const [moduleId] = callBinding.target.split("/");
          const target = scope.requireCurrent().featureModules.find(module => module.id === moduleId)?.workflows.find(candidate => canonicalWorkflowRef(candidate) === callBinding.target);
          if (!target) return null;
          return {
            workflow: callBinding.target,
            inputs: target?.interface?.inputs || {},
            exports: target?.interface?.exports || {},
            fixedArguments: callBinding.fixedArguments || {},
            allowedArguments: callBinding.allowedArguments,
            automaticDocumentSnapshotInput: callBinding.documentSnapshotInput || null,
          };
        }).filter(Boolean);
        const allowedWorkflowIds = callSignatures.map((signature: any) => signature.workflow);
        if (allowedWorkflowIds.length) {
        workerPi.registerTool({
          name: "rp_call",
          label: "Call module workflow",
          description: `Invoke one exposed module workflow and wait for its output documents. Mechanical call signatures: ${JSON.stringify(callSignatures)}.`,
          parameters: Type.Object({
            workflow: Type.Union(allowedWorkflowIds.map((reference: string) => Type.Literal(reference))),
            text: Type.Optional(Type.String({ description: "Inline text input. Mutually exclusive with textFile." })),
            textFile: Type.Optional(Type.String({ description: "Caller-workspace relative path to a UTF-8 file. Its full content becomes the text input. Mutually exclusive with text." })),
            arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
            documents: Type.Optional(Type.Record(Type.String(), Type.String())),
            outputPaths: Type.Record(Type.String(), Type.String()),
          }),
          async execute(_id: string, parameters: any) {
            const request = structuredClone(parameters);
            const callBinding = node.workflowCalls.find((item: any) => item.target === request.workflow);
            try {
              if (delivery) for (const path of Object.values(request.outputPaths || {})) await delivery.assertCallOutputPath(path);
              if (callBinding?.documentSnapshotInput) {
                request.documents ||= {};
                if (request.documents[callBinding.documentSnapshotInput]) throw new Error(`Document input ${callBinding.documentSnapshotInput} is supplied automatically and cannot be overridden.`);
                const snapshotPath = `.call-snapshots/${String(++documentSnapshotSequence).padStart(3, "0")}-${request.workflow.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
                await createDocumentWorkspaceSnapshot({
                  nodeWorkspace,
                  outputPath: snapshotPath,
                  documents: workspaceDocuments,
                  dynamicOutputs: dynamicCallOutputs,
                  currentInput: typeof run.payload?.currentInput === "string" ? run.payload.currentInput : "",
                  narrative: "",
                  turnContext: workflow.turnContext,
                });
                request.documents[callBinding.documentSnapshotInput] = snapshotPath;
              }
              const result = await task.invokeWorkflow(request, { agent: true });
              // Only a call that actually returned counts as satisfying the declaration; the tool
              // result the model sees still carries the failure, but the node must not be treated as
              // having retrieved the material.
              calledTargets.add(request.workflow);
              for (const [id, path] of Object.entries(result.outputs || {})) {
                if (typeof path !== "string") continue;
                if (delivery) await delivery.protect(path);
                dynamicCallOutputs.push({ id: `call.${request.workflow}.${id}`, path, readPolicy: "conditional", authority: "canonical", appliesAt: "planning-and-writing", perspective: "general", priority: 0, description: `Declared output ${id} from ${request.workflow}.` });
              }
              return { content: [{ type: "text", text: JSON.stringify(result.outputs, null, 2) }], details: result };
            } catch (error) {
              failedTargets.set(request.workflow, error instanceof Error ? error.message : String(error));
              throw error;
            }
          },
        });
        }
        }
        if (node.moduleAccess?.length && agent?.tools?.includes("rp_data_query")) {
        workerPi.registerTool({
          name: "rp_data_query",
          label: "Query RP data",
          description: "Query authorized indexed RP data with a named return view.",
          parameters: toolParameters(DATA_QUERY_PARAMETERS, DATA_QUERY_REQUIRED),
          async execute(_id: string, parameters: any) {
            const access = node.moduleAccess?.find((item: any) => item.moduleId === parameters.moduleId && item.collectionId === parameters.collectionId);
            if (!access) throw new Error(`This node has no access to ${parameters.moduleId}/${parameters.collectionId}.`);
            const budget = resolveNodeQueryBudget(access, run.payload);
            const result = await queryData(dataStore, parameters, { capabilities: access.capabilities, views: access.views, runtimeLimit: budget.maxRecords, runtimeCharacters: budget.maxCharacters, nodeLimit: budget.maxRecords, nodeCharacters: budget.maxCharacters, ...workflowDataReadAccess(run, dataStore, dataReadBatchIds) });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          },
        });
        }
        if (node.moduleAccess?.length && agent?.tools?.includes("rp_data_get")) {
        workerPi.registerTool({
          name: "rp_data_get",
          label: "Read one RP record",
          description: "Read one exact authorized RP record through a named view.",
          parameters: toolParameters(DATA_GET_PARAMETERS, DATA_GET_REQUIRED),
          async execute(_id: string, parameters: any) {
            const access = node.moduleAccess?.find((item: any) => item.moduleId === parameters.moduleId && item.collectionId === parameters.collectionId);
            if (!access) throw new Error(`This node has no access to ${parameters.moduleId}/${parameters.collectionId}.`);
            const result = await getDataRecord(dataStore, parameters, { capabilities: access.capabilities, views: access.views, ...workflowDataReadAccess(run, dataStore, dataReadBatchIds) });
            return { content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "Record not found." }], details: result };
          },
        });
        }
        if (node.moduleAccess?.length && agent?.tools?.includes("rp_data_resolve")) {
        workerPi.registerTool({
          name: "rp_data_resolve",
          label: "Resolve RP data identity",
          description: "Resolve one registered ID, display name, or alias within this node's authorized collections.",
          parameters: Type.Object({ value: Type.String() }),
          async execute(_id: string, parameters: any) {
            const matches = (await resolveWorkflowIdentity(run, dataStore, parameters.value, dataReadBatchIds)).filter((entry: any) => {
              const access = node.moduleAccess?.find((item: any) => item.moduleId === entry.moduleId && item.collectionId === entry.collectionId);
              return access && capabilityAllows(dataStore.module(entry.moduleId).contract, access.capabilities, { collectionId: entry.collectionId, action: "query" });
            });
            return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }], details: matches };
          },
        });
        }
        if (node.moduleAccess?.length && agent?.tools?.includes("rp_data_submit")) {
        workerPi.registerTool({
          name: "rp_data_submit",
          label: "Submit RP data output",
          description: "Submit one declared unified-change-batch output before node end.",
          parameters: Type.Object({ output: Type.String() }),
          async execute(_id: string, parameters: any) {
            const output = node.outputs?.[parameters.output];
            if (!output || output.format !== "unified-change-batch") throw new Error(`Node output ${parameters.output} is not a declared unified change batch.`);
            const batch = JSON.parse(await readFile(resolve(nodeWorkspace, output.path), "utf8"));
            const receipt = rememberDataReceipt(run, node.id, await executeDataBatch(dataStore, batch, { access: node.moduleAccess, allowBestEffort: node.dataCommit?.allowBestEffort === true, context: { initiatorKind: node.type === "code" ? "code" : "agent", initiatorId: agent?.id || node.id, workflowId: workflow.id, workflowRunId: run.id, nodeId: node.id, binding: { turn: run.turn || 0, messageId: turn.current?.assistantMessageId || null }, sourceReferences: run.sourceReferences || [] } }));
            return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };
          },
        });
        }
      },
    };
    const permittedBuiltins = new Set(["read", "write", "edit", "bash"]);
    const permittedDataTools = new Set(["rp_data_query", "rp_data_get", "rp_data_resolve", "rp_data_submit"]);
    const permittedRuntimeTools = new Set(["rp_roll"]);
    const tools = node.metadata?.teamMember === true
      ? ["rp_team_read", ...(task.teamMember?.member?.role === "leader" && task.teamMember?.phase === "discussion" ? ["rp_team_control"] : [])]
      : [...new Set(["read", "write", "edit", "rp_files", "rp_deliver", "rp_task_next", "rp_node_complete", ...(agent?.tools || []).filter((name: string) => permittedBuiltins.has(name) || permittedRuntimeTools.has(name) || (node.moduleAccess?.length && permittedDataTools.has(name)))])];
    const hasResolvedWorkflowCall = node.workflowCalls?.some((binding: any) => {
      const [moduleId] = binding.target.split("/");
      return scope.requireCurrent().featureModules.find(module => module.id === moduleId)?.workflows.some(candidate => canonicalWorkflowRef(candidate) === binding.target);
    });
    if (hasResolvedWorkflowCall) tools.push("rp_call");
    // A required call that the Agent cannot even attempt is a card-authoring error. Failing before
    // the model runs keeps it out of the "the model forgot" bucket, where another attempt would look
    // like the remedy.
    if (requiredCalls.length && !tools.includes("rp_call")) {
      throw Object.assign(
        new Error(`Node ${node.id} requires ${requiredCalls.join(", ")} but its Agent is not authorized for rp_call.`),
        { code: "workflow_configuration_invalid" },
      );
    }
    const unresolvableRequired = requiredCalls.filter(target => !node.workflowCalls.some((binding: any) => binding.target === target && scope.requireCurrent().featureModules.some(module => module.workflows.some(candidate => canonicalWorkflowRef(candidate) === target))));
    if (unresolvableRequired.length) {
      throw Object.assign(
        new Error(`Node ${node.id} requires ${unresolvableRequired.join(", ")}, which this card cannot resolve.`),
        { code: "workflow_configuration_invalid" },
      );
    }
    const requirements = agentPromptRequirements(run.agentPromptControls, agent?.id || binding.agentId);
    const promptSources = await playPromptSources(scope.requireCurrent(), profile, agent, node, nodeWorkspace, tools, requirements);
    if (node.metadata?.teamMember === true && promptSources.taskStages.staged) {
      throw Object.assign(new Error(`Team member ${node.id} does not support staged task prompts.`), { code: "workflow_configuration_invalid" });
    }
    stageController = createTaskStageController(promptSources.taskStages);
    delivery = node.metadata?.teamMember === true ? null : await createAgentDelivery({
      workspace: nodeWorkspace, node, agent,
      inputPaths: [...workspaceDocuments.map(document => document.path), ...upstreamHandoffs.map((artifact: any) => artifact.stagedPath)],
      beforeComplete: async () => {
        stageController.assertExhausted();
        const missing = requiredCalls.filter(target => !calledTargets.has(target));
        if (missing.length) throw Object.assign(new Error(`Required workflow calls have not succeeded: ${missing.join(", ")}.`), { code: "required_call_missing" });
      },
    });
    const contextSelection = node.metadata?.initialContext || {};
    const cardMessages = contextSelection.cardFoundation === true && scope.requireCurrent().stableCardContext.trim()
      ? [{ role: contextSelection.cardFoundationRole || promptSources.roles.cardFoundationRole || "user", content: `以下为本世界设定的概述和基本信息，涉及具体细节时应查看对应资料。\n\n${renderCardText(scope.requireCurrent().stableCardContext, scope.requireCurrent().playerName, "fixed_context")}` }]
      : [];
    const playerMessages = contextSelection.playerProfile === true
      ? [{ role: contextSelection.playerProfileRole || promptSources.roles.playerProfileRole || "user", content: playerProfileMessage(scope.requireCurrent().playerName, scope.requireCurrent().playerDescription) }]
      : [];
    const historyMessages = contextSelection.recentNarrative === true && Number.isSafeInteger(run.turn)
      ? recentNarrativeMessages(scope.requireCurrent().messages, run.turn, workflow.turnContext?.recentCompleteTurns || 5, "【前情截断】更早的对话未直接提供；需要时按当前任务允许的方式查询。")
      : [];
    const input = contextSelection.currentInput === true
      ? (typeof run.payload?.currentInput === "string" ? run.payload.currentInput : typeof run.textInput === "string" ? run.textInput : "")
      : null;
    const additional = [
      run.callContext ? "模块调用输入见 `CALL-INPUTS.md`。" : "",
      customContext,
      node.metadata?.documentWorkspace === true ? "" : [legacyDynamicContext, legacyUpstreamArtifacts].filter(Boolean).join("\n\n"),
    ].filter(Boolean).join("\n\n");
    const current = currentTaskMessage({ input, task: promptSources.nodeText, index: conciseWorkspaceIndex(workspaceDocuments, node.metadata?.documentWorkspace === true), additional });
    const tailAtStart = promptSources.tailMode === "on-start" ? promptSources.tail : [];
    const assembled = assembleInitialContext({
      baseSystem: promptSources.baseSystem,
      prefix: promptSources.prefix,
      agent: promptSources.agent,
      card: cardMessages,
      player: playerMessages,
      history: historyMessages,
      current,
      tail: tailAtStart,
    });
    if (assembled.messages.at(-1)?.role !== "user") throw new Error(`Node ${node.id} ends in an assistant message; assistant prefill is not verified for this Pi/model path.`);
    const finalUserMessage = assembled.messages.at(-1).content;
    const seededMessages = assembled.messages.slice(0, -1);
    const everyCallTail = promptSources.tailMode === "every-call" ? promptSources.tail : [];
    if (everyCallTail.some((message: any) => message.role !== "user")) throw new Error(`Node ${node.id} has an every-call tail that cannot be represented by this Pi request path.`);
    const loader = new sdk.DefaultResourceLoader({
      cwd: nodeWorkspace,
      agentDir: sdk.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: [assembled.systemPrompt, delivery ? deliveryPrompt(delivery.contract) : ""].filter(Boolean).join("\n\n"),
      extensionFactories: [nodeToolFactory, {
        name: "rp-workspace-file-boundary",
        hidden: true,
        factory(workerPi: any) {
          workerPi.on("tool_call", async (event: any) => {
            if (!["read", "write", "edit"].includes(event.toolName)) return;
            if (await promptSourcePathAllowed(nodeWorkspace, event.input?.path, [resolve(scope.requireCurrent().context.cwd, "prompts"), resolve(scope.requireCurrent().cardDirectory, "prompts"), ...scope.requireCurrent().featureModules.map(module => module.moduleDirectory), resolve(nodeWorkspace, ".rp-delivery")])) return;
            return { block: true, reason: "Prompt source files are not available to this Agent node." };
          });
        },
      }, ...(everyCallTail.length ? [{
        name: "rp-model-tail",
        hidden: true,
        factory(workerPi: any) {
          workerPi.on("context", (event: any) => ({
            messages: moveModelTailToEnd(event.messages, everyCallTail.map((message: any) => message.content).join("\n\n")),
          }));
        },
      }] : [])],
    });
    await loader.reload();
    const teamSessionDirectory = node.metadata?.teamMember === true ? resolve(nodeWorkspace, ".session") : null;
    if (teamSessionDirectory) await mkdir(teamSessionDirectory, { recursive: true });
    const teamSessionPointer = teamSessionDirectory ? resolve(teamSessionDirectory, "CURRENT.txt") : null;
    const previousTeamSession = teamSessionPointer ? await readFile(teamSessionPointer, "utf8").then((value: string) => value.trim()).catch((error: any) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }) : null;
    const sessionManager = previousTeamSession
      ? sdk.SessionManager.open(previousTeamSession, teamSessionDirectory)
      : teamSessionDirectory ? sdk.SessionManager.create(nodeWorkspace, teamSessionDirectory) : sdk.SessionManager.inMemory(nodeWorkspace);
    if (!previousTeamSession) {
      for (const message of seededMessages) sessionManager.appendMessage(seededPiMessage(message, model));
    }
    const settingsManager = sdk.SettingsManager.create(nodeWorkspace, sdk.getAgentDir());
    settingsManager.applyOverrides({ compaction: { enabled: false } });
    const { session } = await sdk.createAgentSession({
      cwd: nodeWorkspace,
      modelRuntime: (scope.requireCurrent().context.modelRegistry as any).runtime,
      model,
      ...(profile?.thinking && profile.thinking !== "off" ? { thinkingLevel: profile.thinking } : {}),
      ...(tools.length ? { tools } : { noTools: "all" }),
      resourceLoader: loader,
      sessionManager,
      settingsManager,
    });
    workerSession = session;
    const usageMessageStart = session.messages.length;
    const teamSessionCheckpoint = teamSessionDirectory ? checkpointTeamSessionAttempt(sessionManager) : null;
    try {
      const userPrompt = finalUserMessage;
      // From here on a failure may be the model's, so the runtime must stop calling it deterministic.
      task.markModelDispatched?.();
      if (delivery) await runAgentDeliverySession({ session, prompt: userPrompt, delivery, stageController });
      else await session.prompt(userPrompt, { expandPromptTemplates: false, source: "extension" });
      if (teamSessionPointer) {
        const persistedSession = session.sessionFile || session.sessionManager?.getSessionFile?.() || null;
        if (persistedSession) await writeFile(teamSessionPointer, `${persistedSession}\n`, "utf8");
      }
      const assistant = [...session.messages].reverse().find((message: any) => message.role === "assistant");
      const content = messageText(assistant);
      if (!delivery && !content) throw noTextOutputError({ message: assistant, label: `Workflow agent ${agent?.id || node.id}` });
      // A workflow that declared a call as required has already decided that continuing without it
      // is worse than failing the turn. Whether a missing retrieval is a degradation or a hard stop
      // is the card's decision, so the runtime enforces the declaration rather than guessing.
      if (requiredCalls.length) {
        const missing = requiredCalls.filter(target => !calledTargets.has(target));
        if (missing.length) {
          const failure = failedTargets.get(missing[0]);
          throw Object.assign(
            new Error(`Node ${node.id} requires ${missing.join(", ")} but the Agent did not obtain ${missing.length === 1 ? "it" : "them"}${failure ? ` (${missing[0]} failed: ${failure})` : ""}.`),
            { code: "required_call_missing" },
          );
        }
      }
      if (node.metadata?.teamMember === true && typeof task.teamMember?.validateOutput === "function") {
        try { task.teamMember.validateOutput(content); }
        catch (error) {
          const rejected = error instanceof Error ? error : new Error(String(error));
          (rejected as any).rejectedContent = content;
          throw rejected;
        }
      }
      const output: any = delivery ? await delivery.result() : content;
      const snapshotDeclaration = node.metadata?.documentWorkspaceSnapshot;
      if (snapshotDeclaration) {
        const definition = node.outputs?.[snapshotDeclaration.output];
        if (!definition || definition.format !== "document-workspace-snapshot" || definition.kind !== "directory") throw new Error(`Node ${node.id} documentWorkspaceSnapshot must reference a declared directory output with format document-workspace-snapshot.`);
        await replaceDocumentWorkspaceSnapshot({
          nodeWorkspace,
          outputPath: definition.path,
          documents: workspaceDocuments,
          dynamicOutputs: dynamicCallOutputs,
          currentInput: typeof run.payload?.currentInput === "string" ? run.payload.currentInput : "",
          narrative: typeof output === "string" ? output : "",
          turnContext: workflow.turnContext,
        });
      }
      return {
        output,
        ...(node.metadata?.teamMember === true ? { content, control: teamControl } : {}),
        assistantMessageId: turn.current?.assistantMessageId || null,
        usage: tokenUsageFromMessages(session.messages.slice(usageMessageStart)),
        processRecord: delivery ? { ...lastAgentExchange(session.messages), deliveries: delivery.receipts, artifact: { role: "artifact", content: typeof output === "string" ? output : JSON.stringify(output, null, 2) }, ...(promptSources.taskStages.staged ? { taskStages: { sourceHash: promptSources.taskStages.sourceHash, events: stageController.events } } : {}) } : lastAgentExchange(session.messages),
        context: {
          mode: node.context.mode,
          nodePrompt: promptSources.fullNodeText || null,
          customContext: customContext || null,
        },
      };
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      if (delivery?.completed) (wrapped as any).code = "agent_delivery_finalize_failed";
      (wrapped as any).usage = tokenUsageFromMessages(session.messages.slice(usageMessageStart));
      if (teamSessionCheckpoint) {
        try {
          rollbackTeamSessionAttempt(sessionManager, teamSessionCheckpoint, {
            executionId: task.teamMember?.executionId || null,
            attemptId: task.teamMember?.attemptId || null,
            error: wrapped.message,
          });
          const persistedSession = session.sessionFile || session.sessionManager?.getSessionFile?.() || null;
          if (persistedSession && teamSessionPointer) await writeFile(teamSessionPointer, `${persistedSession}\n`, "utf8");
        } catch (rollbackError) {
          const rollbackFailure = new Error(`${wrapped.message} Team session rollback failed: ${(rollbackError as Error).message}`, { cause: wrapped });
          (rollbackFailure as any).code = "team_session_rollback_failed";
          (rollbackFailure as any).usage = (wrapped as any).usage;
          throw rollbackFailure;
        }
      }
      throw wrapped;
    } finally {
      session.dispose();
    }
  };
}
