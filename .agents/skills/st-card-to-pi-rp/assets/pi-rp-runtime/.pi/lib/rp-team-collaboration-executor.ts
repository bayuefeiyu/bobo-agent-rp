import { playNodePrompt, playPromptSources } from "./rp-author-prompts.mjs";
import { assembleInitialContext, currentTaskMessage, seededPiMessage } from "./rp-node-context.mjs";
import { moveModelTailToEnd } from "./rp-model-config.mjs";
import { assertCollaborationContextFits } from "./rp-team-shared-context.mjs";
import { assertCollaborationToolMessage, installCollaborationContextGuard } from "./rp-team-collaboration-tools.mjs";
import { tokenUsageFromMessages } from "./rp-token-usage.mjs";
import { agentSoftBudgetExtension, auxiliaryTaskScopePrompt } from "./rp-agent-soft-budget.mjs";
import { agentPromptRequirements } from "./rp-prompt-controls.mjs";
import { TeamCollaborationRuntime } from "./rp-team-collaboration-runtime.mjs";
import { createDocumentWorkspaceSnapshot, replaceDocumentWorkspaceSnapshot } from "./rp-workspace-snapshot.mjs";
import { renderTeamAuthorText } from "./rp-card-text.mjs";
import { canonicalWorkflowRef } from "./rp-workflows.mjs";
import { referenceStatus } from "./rp-reference-library.mjs";
import { installCallRecorder } from "./rp-call-records.mjs";

export async function executeCollaborationMember(task: any, active: any, resolveConfiguredModel: any) {
  const { node, agent } = task;
  const request = task.teamMember;
  const collaboration = request.collaboration;
  const { profile, model } = await resolveConfiguredModel(active, task.binding.modelId, task.model);
  if (!model) throw new Error("No model is configured for this collaboration member.");
  const names = new Set(request.member.tools.filter((name: string) => agent.tools?.includes(name)));
  const definitions = collaboration.tools.filter((tool: any) => tool.name.startsWith("rp_team_") || ["rp_deliver", "rp_task_next", "rp_node_complete"].includes(tool.name) || names.has(tool.name));
  const frozenAgentPrompt = collaboration.frozenAgentPrompt();
  const promptAgent = frozenAgentPrompt ? { ...agent, promptFile: null, prompt: "" } : agent;
  const sources = await playPromptSources(active, profile, promptAgent, node, request.workspace, definitions.map((tool: any) => tool.name), agentPromptRequirements(task.run.agentPromptControls, agent.id));
  sources.agent = await collaboration.freezeAgentPrompt(sources.agent);
  if (sources.tailMode === "every-call" && sources.tail.some((message: any) => message.role !== "user")) throw Object.assign(new Error("Every-call model tails must use the user role."), { code: "workflow_configuration_invalid" });
  const assembled = assembleInitialContext({ baseSystem: sources.baseSystem, prefix: sources.prefix, prefixGroups:sources.prefixGroups, agent: sources.agent, current: currentTaskMessage({ input: null, task: request.prompt, index: "工作目录为团队节点工作区；资料路径与共享记录见任务正文。" }), tail: sources.tailMode === "on-start" ? sources.tail : [],tailGroups:sources.tailMode==="on-start"?sources.tailGroups:[] });
  if (assembled.messages.at(-1)?.role !== "user") throw Object.assign(new Error("Collaboration activation must end its initial context with a user task."), { code: "workflow_configuration_invalid" });
  assertCollaborationContextFits(assembled.systemPrompt + assembled.messages.map((entry: any) => entry.content).join("\n"), model);
  const sdk: any = await import("@earendil-works/pi-coding-agent");
  let session: any;
  let terminated = false;
  let publicationError: any = null;
  let publications = Promise.resolve();
  const tools = definitions.map((definition: any) => ({ ...definition, async execute(id: string, args: any) {
    await publications;
    if (publicationError) throw publicationError;
    assertCollaborationToolMessage(session.messages);
    const result = await definition.execute(id, args);
    if (result.terminate) terminated = true;
    return result;
  } }));
  const loader = new sdk.DefaultResourceLoader({ cwd: request.workspace, agentDir: sdk.getAgentDir(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: [assembled.systemPrompt, task.workflow.kind !== "foreground" ? auxiliaryTaskScopePrompt : ""].filter(Boolean).join("\n\n"),
    extensionFactories: [...agentSoftBudgetExtension(node, task.workflow, task.isForegroundWaiting), ...(sources.tailMode === "every-call" && sources.tail.length ? [{ name: "rp-collaboration-tail", factory(pi: any) { pi.on("context", (event: any) => ({ messages: moveModelTailToEnd(event.messages, sources.tail.map((entry: any) => entry.content).join("\n\n")) })); } }] : [])] });
  await loader.reload();
  const sessionManager = sdk.SessionManager.inMemory(request.workspace);
  for (const message of assembled.messages.slice(0, -1)) sessionManager.appendMessage(seededPiMessage(message, model));
  const settingsManager = sdk.SettingsManager.create(request.workspace, sdk.getAgentDir());
  settingsManager.applyOverrides({ compaction: { enabled: false } });
  const created = await sdk.createAgentSession({ cwd: request.workspace, modelRuntime: active.context.modelRegistry.runtime, model, ...(profile?.thinking && profile.thinking !== "off" ? { thinkingLevel: profile.thinking } : {}), tools: tools.map((tool: any) => tool.name), customTools: tools, resourceLoader: loader, sessionManager, settingsManager });
  session = created.session;
  const contextGuard = installCollaborationContextGuard(session.agent, model, collaboration.beforeModel);
  const callRecorder = installCallRecorder(session, { sessionDirectory: active.sessionDirectory, run: task.run, node, binding: task.binding, agentId: agent.id, memberId: request.memberId || request.member?.id || request.role || null });
  collaboration.bindWorkflow(task.invokeWorkflow);
  const start = session.messages.length;
  const unsubscribe = session.subscribe((event: any) => {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const text = event.message.content?.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    if (text) publications = publications.then(() => collaboration.publish(text, { interrupted: ["error", "aborted"].includes(event.message.stopReason) })).catch((error: any) => { publicationError = error; });
  });
  const cancellation = setInterval(() => { if (task.isCancelled?.()) session.abort(); }, 100);
  try {
    let prompt = assembled.messages.at(-1)?.content;
    for (let attempt = 0; attempt <= collaboration.maxProtocolReminders; attempt++) {
      task.markModelDispatched?.();
      await session.prompt(prompt, { expandPromptTemplates: false, source: "extension" });
      await publications;
      if (publicationError) throw publicationError;
      if (contextGuard.error) throw contextGuard.error;
      if (task.isCancelled?.()) throw Object.assign(new Error("Collaboration cancelled."), { code: "workflow_cancelled" });
      const last = session.messages.at(-1);
      if (last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason)) throw new Error(last.errorMessage || "Collaboration model failed.");
      if (terminated) return { terminated: true, usage: tokenUsageFromMessages(session.messages.slice(start)) };
      prompt = "你仍持有发言权。继续当前工作；说完后单独调用 rp_team_handoff，全部任务和交付完成后按权限调用 rp_node_complete。";
    }
    throw Object.assign(new Error("Member did not explicitly hand off or complete."), { code: "workflow_recovery_required" });
  } catch (error: any) {
    await callRecorder.finish(error);
    error.usage = tokenUsageFromMessages(session.messages.slice(start));
    throw error;
  } finally { clearInterval(cancellation); unsubscribe(); await callRecorder.finish(); session.dispose(); }
}

export async function executeCollaborationNode(task: any, active: any, prepared: any) {
  const { node, run, workflow } = task;
  const { nodeWorkspace, workspaceDocuments, context } = prepared;
  const prompt = await playNodePrompt(active, node);
  const referenceAvailability = active.featureModules.some((module: any) => module.externalResource) ? await referenceStatus() : { ready: false, semanticReady: false };
  const referenceCallReady = (target: string) => target === "creative-reference-library/search-passages" ? referenceAvailability.semanticReady === true : referenceAvailability.ready === true;
  const callSignatures = node.workflowCalls.flatMap((binding: any) => {
    const target = active.featureModules.flatMap((module: any) => module.workflows).find((candidate: any) => canonicalWorkflowRef(candidate) === binding.target);
    if (!target || binding.target.startsWith("creative-reference-library/") && !referenceCallReady(binding.target)) return [];
    return [{ ...binding, inputs: target.interface?.inputs, exports: target.interface?.exports }];
  });
  const missingCalls = (node.requiredCalls || []).filter((target: string) => !callSignatures.some((binding: any) => binding.target === target));
  if (missingCalls.length) throw new Error(`Required collaboration workflows are unavailable: ${missingCalls.join(", ")}.`);
  const runtimeNode = { ...node, workflowCalls: node.workflowCalls.filter((binding: any) => callSignatures.some((signature: any) => signature.target === binding.target)), team: renderTeamAuthorText(node.team, active.playerName, `team ${node.id}`) };
  const runtime = new TeamCollaborationRuntime({ workspace: nodeWorkspace, node: runtimeNode, runId: run.id, context, taskPrompt: prompt, invokeMember: task.invokeAgent, invokeWorkflow: task.invokeWorkflow, isCancelled: task.isCancelled,
    prepareCall: async (request: any, current: any) => {
      const binding = node.workflowCalls.find((entry: any) => entry.target === request.workflow);
      if (binding?.documentSnapshotInput) {
        request.documents ||= {};
        if (request.documents[binding.documentSnapshotInput]) throw new Error("Automatic document snapshot cannot be overridden.");
        const path = `.call-snapshots/team-${current.state.toolCalls}`;
        await createDocumentWorkspaceSnapshot({ nodeWorkspace, outputPath: path, documents: workspaceDocuments, dynamicOutputs: current.state.dynamicDocuments, currentInput: run.payload?.currentInput || "", narrative: "", turnContext: workflow.turnContext });
        request.documents[binding.documentSnapshotInput] = path;
      }
      return request;
    } });
  runtime.callSignatures = callSignatures;
  const result = await runtime.run({ inputPaths: workspaceDocuments.map((document: any) => document.path) });
  if (node.metadata?.documentWorkspaceSnapshot) {
    const output = node.outputs[node.metadata.documentWorkspaceSnapshot.output];
    await replaceDocumentWorkspaceSnapshot({ nodeWorkspace, outputPath: output.path, documents: workspaceDocuments, dynamicOutputs: result.dynamicDocuments, currentInput: run.payload?.currentInput || "", narrative: typeof result.output === "string" ? result.output : "", turnContext: workflow.turnContext });
  }
  return { output: result.output, usage: result.usage, usageComplete: !result.usage?.unrecordedCalls, assistantMessageId: prepared.assistantMessageId, context: { mode: "team", protocol: "collaboration" }, processRecord: { artifact: { role: "artifact", content: typeof result.output === "string" ? result.output : JSON.stringify(result.output) }, deliveries: result.state.deliveryReceipts, taskStages: result.state.stageState } };
}
