import { createImageWebBridge } from "./rp-image-web-bridge.ts";
import { loadCardComponents, validateModuleRegistry } from "./rp-module-registry.mjs";
import * as promptControlsService from "./rp-prompt-controls.mjs";

import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createRecordEnvelope, formatCatalog, parseRecordLines, selectRecords, toRecordLines } from "./rp-records.mjs";
import { runContextProcessor } from "./rp-context-processors.mjs";

import { defaultCommonSettings, mergeCommonSettings, normalizeCommonSettings } from "./rp-common-settings.mjs";
import { createRpConfigStore } from "./rp-config-store.mjs";
import { createConfigProfileStore } from "./rp-config-profiles.mjs";
import { RpWorkflowEngine } from "./rp-workflow-engine.mjs";
import { withTerminalForegroundRelease } from "./rp-workflow-host.mjs";

import { renderCardText } from "./rp-card-text.mjs";
import { materializeAuthorSkill } from "./rp-card-text-files.mjs";
import { canonicalWorkflowRef, resolveNodeQueryBudget, workflowTriggerMatches } from "./rp-workflows.mjs";

import { describeTurnFailureReason } from "./rp-model-failures.mjs";

import { readCardContextFile, readContextProcessors, readFeatureModules, readMessageRetrievalPolicy, readMessageRetrievalSkill } from "./rp-card-content.ts";

import { currentDataNode as resolveCurrentDataNode, workflowDataReadAccess } from "./rp-node-data-access.ts";
import { readSourceRecords, refreshSourceCatalog, sourcePolicy } from "./rp-transcript-source.ts";

import { latestCompletedTurn, webSnapshot as buildWebSnapshot } from "./rp-turn-state.ts";

import { appendWorkflowRunRecord, ensureWorkflowWorkspace, workflowWorkspacePaths, writeWorkflowProcessRecord } from "./rp-workspace.mjs";

import { createSessionDataStore } from "./rp-session-data-store.ts";
import { getDataRecord, queryData } from "./rp-data-query.mjs";
import { createDataReadView, deleteDataReadView } from "./rp-data-read-view.mjs";
import { createDataReadViewRegistry } from "./rp-data-read-view-lifecycle.mjs";

import { finalizeNodeData } from "./rp-data-node-runtime.mjs";
import { cleanupArtifacts, workflowNodeWorkspace } from "./rp-data-artifacts.mjs";
import { createComfyUiService } from "./rp-comfyui.mjs";

import { messageSourceReference } from "./rp-narrative-source.mjs";

import { snapshotAgentPromptControls } from "./rp-prompt-controls.mjs";
import { readWorkflowCallTextFile } from "./rp-workspace-handoff.mjs";
import { cleanupFrozenTriggerInputs, freezeTriggeredDocuments } from "./rp-workspace-snapshot.mjs";

import { imageExecutionGuard, normalizeModuleDisplaySettings, authoritativeTranscript, resolveActiveWorkflowId, readOrCreateJson, httpError, applyModuleProfile, resolveCardDirectory, resolveSessionDirectory, openBrowser, openLocalDocument } from "./rp-host-utils.ts";
import type { WebMessage, RecordEnvelope, ActiveBridge, RpRun, FeatureModule, CommonSettings, CardSettings } from "./rp-host-types.ts";

import { createConfigWebBridge } from "./rp-web-config-bridge.ts";
import { createWorkflowsWebBridge } from "./rp-web-workflows-bridge.ts";
import { createModulesWebBridge } from "./rp-web-modules-bridge.ts";
import { createChatWebBridge } from "./rp-web-chat-bridge.ts";
import { createHostSessionScope } from "./rp-host-session-scope.ts";
import { createRpNodeExecutor } from "./rp-node-executor.ts";
import { createHostRegistration } from "./rp-host-registration.ts";
import { bindWebBridge } from "./rp-web-bridge.ts";

export function createRpHostSession(pi: ExtensionAPI) {
const boundCardId = process.env.BOBO_RP_CARD_ID || null;

const isolatedRuntime = Boolean(boundCardId);

const scope = createHostSessionScope<ActiveBridge>();

const turn: { current: RpRun | null } = { current: null };

function webSnapshot(extra: Record<string, unknown> = {}) {
    return buildWebSnapshot(scope.current, isolatedRuntime, extra);
  }

function releaseRpTurn(reason: "completed" | "failed", detail: string | null) {
    if (!scope.current || !turn.current) return;
    if (reason === "failed") {
      if (!scope.current.context.isIdle()) {
        try { scope.current.context.abort(); }
        catch (error) { console.warn(`Failed to abort the terminal foreground context: ${error instanceof Error ? error.message : String(error)}`); }
      }
      scope.current.lastTurnFailure = { turn: scope.current.turn, detail, at: new Date().toISOString(), recordId: scope.current.recordId };
    }
    scope.current.pending = false;
    turn.current = null;
  }

function releaseCompletedRpTurn(runId: string) {
    if (!scope.current || !turn.current || turn.current.workflowRunId !== runId || !turn.current.agentSettled || !turn.current.workflowCompleted) return;
    releaseRpTurn("completed", null);
  }

function describeTurnFailure(run: any, narrativePublished: boolean): string {
    return describeTurnFailureReason(run, narrativePublished);
  }

async function ensureFeatureModuleRecords(target: ActiveBridge) {
    if (!target.recordId || !target.sessionDirectory) return;
    const profile = await target.configProfiles.getActive();
    await createSessionDataStore({
      sessionDirectory: target.sessionDirectory,
      featureModules: target.featureModules,
      initialOverrides: profile?.moduleOverrides || {},
      playerName: target.playerName,
    }).initialize();
    const skillsRoot = resolve(target.sessionDirectory, "workspace", "author-skills");
    for (const module of target.featureModules) {
      const destination = resolve(skillsRoot, module.id);
      if (!module.skillPath.startsWith(`${destination}${sep}`)) {
        module.skillPath = await materializeAuthorSkill(module.skillPath, destination, target.playerName);
      }
    }
    if (target.messageSkillPath) {
      const destination = resolve(skillsRoot, "message-retrieval");
      if (!target.messageSkillPath.startsWith(`${destination}${sep}`)) {
        target.messageSkillPath = await materializeAuthorSkill(target.messageSkillPath, destination, target.playerName);
      }
    }
  }

async function ensureActiveRecord() {
    if (!scope.current) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
    if (!scope.current.recordId || !scope.current.sessionDirectory) {
      await mkdir(scope.current.candidateSessionDirectory, { recursive: true });
      scope.updateChat(scope.current.candidateRecordId, scope.current.candidateSessionDirectory);
    }
    await ensureFeatureModuleRecords(scope.current);
  }

async function appendMessage(message: WebMessage) {
    if (!scope.current) return;
    await ensureActiveRecord();
    const id = `message-${randomUUID()}`;
    const record = createRecordEnvelope({
      id,
      source: "messages",
      sequence: message.sequence,
      createdAt: message.createdAt,
      binding: { messageId: id, turn: message.turn },
      metadata: { recordType: message.kind, entityIds: [], tags: [message.role], narrativeSource: message.narrativeSource },
      data: { role: message.role, kind: message.kind, content: message.content },
    }) as RecordEnvelope;
    scope.current.messages.push(record);
    await appendFile(resolve(scope.current.sessionDirectory!, "messages.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

async function rewriteMessages() {
    if (!scope.current?.sessionDirectory) return;
    const messagesPath = resolve(scope.current.sessionDirectory, "messages.jsonl");
    const temporaryPath = resolve(scope.current.sessionDirectory, `.messages-${Date.now()}-${process.pid}.tmp`);
    await writeFile(temporaryPath, toRecordLines(scope.current.messages), "utf8");
    await rename(temporaryPath, messagesPath);
  }

async function pruneModuleRecords(target: ActiveBridge, deletedMessageIds: Set<string>) {
    if (!target.sessionDirectory || deletedMessageIds.size === 0) return;
    await createSessionDataStore({
      sessionDirectory: target.sessionDirectory,
      featureModules: target.featureModules,
      }).pruneByMessageIds(deletedMessageIds);
  }

async function readModuleProcessorData(target: ActiveBridge, module: FeatureModule) {
    if (!module.contract) throw new Error(`Feature module ${module.id} has no unified data contract.`);
    if (!target.sessionDirectory) return { collections: {} };
    await ensureFeatureModuleRecords(target);
    const store = createSessionDataStore({ sessionDirectory: target.sessionDirectory, featureModules: target.featureModules });
    const collections: Record<string, unknown> = {};
    for (const collectionId of Object.keys(module.contract.collections)) collections[collectionId] = await store.readCollection(module.id, collectionId);
    return { collections };
  }

async function writeContextReceipt(target: ActiveBridge, run: RpRun) {
    if (!target.sessionDirectory) return;
    const directory = resolve(target.sessionDirectory, "context", "receipts");
    await mkdir(directory, { recursive: true });
    const receipt = {
      schemaVersion: 1,
      turn: target.turn,
      submittedMessageId: target.messages.find(record => record.sequence === run.submittedSequence)?.id || null,
      automatic: run.automaticSelections,
      agentQueries: run.agentQueries,
      processors: run.processorSelections,
      unresolvedAgentSources: run.agentSources.filter(source => !run.agentQueries.some(query => query.source === source)),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(resolve(directory, `turn-${String(target.turn).padStart(6, "0")}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

async function buildDynamicProcessorContext(target: ActiveBridge, run: RpRun) {
    if (target.contextProcessors.length === 0) return "";
    if (!target.sessionDirectory || !run.workflowRunId) throw new Error("Context processors require an active workflow node and session data store.");
    const workflowEntry = (target.workflowEngine as any).runs.get(run.workflowRunId);
    const narrativeNode = workflowEntry?.workflow?.nodes?.find((item: any) => item.id === run.workflowNarrativeNodeId);
    if (!narrativeNode) throw new Error("Context processors cannot resolve the active narrative node.");
    const store = createSessionDataStore({ sessionDirectory: target.sessionDirectory, featureModules: target.featureModules });
    const dataQueries: Record<string, unknown> = {};
    const dataQuerySignatures: Record<string, string> = {};
    for (const processor of target.contextProcessors) {
      for (const query of processor.definition.dependencies.dataQueries) {
        const signature = JSON.stringify(query);
        if (dataQuerySignatures[query.id] && dataQuerySignatures[query.id] !== signature) throw new Error(`Context processor data query ID ${query.id} has conflicting definitions.`);
        if (dataQuerySignatures[query.id]) continue;
        dataQuerySignatures[query.id] = signature;
        const access = narrativeNode.moduleAccess?.find((item: any) => item.moduleId === query.moduleId && item.collectionId === query.collectionId);
        if (!access) throw new Error(`Context processor ${processor.id} has no narrative-node access to ${query.moduleId}/${query.collectionId}.`);
        const budget = resolveNodeQueryBudget(access, workflowEntry.run.payload);
        dataQueries[query.id] = await queryData(store, query, { capabilities: access.capabilities, views: access.views, runtimeLimit: budget.maxRecords, runtimeCharacters: budget.maxCharacters, nodeLimit: budget.maxRecords, nodeCharacters: budget.maxCharacters });
      }
    }
    const available = {
      card: { id: target.cardId, name: target.cardName },
      turn: target.turn,
      currentInput: run.submittedText,
      openingId: target.openingId,
      player: { name: target.playerName, description: target.playerDescription },
      messages: target.messages.filter(record => record.sequence < run.submittedSequence),
      dataQueries,
      settings: { common: target.commonSettings, card: target.cardSettings },
    };
    await target.workflowEngine.addSourceReferences(run.workflowRunId, available.messages.map(messageSourceReference));
    const sections: string[] = [];
    for (const processor of target.contextProcessors) {
      try {
        const loaded = await import(`${pathToFileURL(processor.entryPath).href}?run=${Date.now()}-${randomUUID()}`);
        const selectContext = loaded.selectContext || loaded.default;
        if (typeof selectContext !== "function") throw new Error(`${processor.entryPath} must export selectContext().`);
        const result = await runContextProcessor(processor.definition, selectContext, available);
        run.processorSelections.push({ id: processor.id, include: result.include });
        if (result.include.length === 0) continue;
        const included = result.include.map(id => processor.fragments.find(fragment => fragment.id === id)!);
        const content = [];
        for (const fragment of included) {
          const source = await readFile(fragment.path, "utf8");
          content.push(`## ${renderCardText(fragment.title, target.playerName, fragment.path)}\n${renderCardText(source.trim(), target.playerName, fragment.path)}`);
        }
        sections.push([
          `# Dynamic card context: ${processor.id}`,
          ...content,
        ].filter(Boolean).join("\n\n"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        run.processorSelections.push({ id: processor.id, include: [], error: message });
        if (processor.failure === "error") {
          await writeContextReceipt(target, run);
          throw new Error(`Context processor ${processor.id} failed: ${message}`);
        }
      }
    }
    return sections.join("\n\n");
  }

async function buildAutomaticContext(target: ActiveBridge, run: RpRun) {
    const sections: string[] = [];
    const sources = ["messages"];
    for (const source of sources) {
      const records = await readSourceRecords(target, source, run);
      const policy = sourcePolicy(target, source);
      const catalog = await refreshSourceCatalog(target, source, records);
      if (policy.agent.mode !== "override") {
        const selected = selectRecords(records, policy.code.selector).records as RecordEnvelope[];
        run.automaticSelections[source] = selected.map(record => record.id);
        if (run.workflowRunId) await target.workflowEngine.addSourceReferences(run.workflowRunId, selected.map(messageSourceReference));
        sections.push(`# Authoritative editable Web RP history\n${authoritativeTranscript(target, selected)}`);
      } else {
        run.automaticSelections[source] = [];
      }
      if (policy.agent.mode !== "disabled") {
        run.agentSources.push(source);
        sections.push([
          `# Record catalog: ${source}`,
          `Agent selection mode: ${policy.agent.mode}. You must resolve message history once with rp_message_query before completing this node response. Use decision=select, success_empty, or not_triggered as authored.`,
          formatCatalog(catalog),
        ].join("\n"));
      }
    }
    return sections.join("\n\n");
  }

async function updateMetadata() {
    if (!scope.current?.recordId || !scope.current.sessionDirectory) return;
    const createdAt = scope.current.messages[0]?.createdAt || new Date().toISOString();
    const metadata = {
      id: scope.current.recordId,
      piSessionFile: scope.current.context.sessionManager.getSessionFile() || null,
      cardId: scope.current.cardId,
      cardName: scope.current.cardName,
      openingId: scope.current.openingId,
      playerName: scope.current.playerName,
      playerDescription: scope.current.playerDescription,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(resolve(scope.current.sessionDirectory, "session.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

async function stopBridge() {
    if (!scope.current) return;
    const closing = scope.current.close;
    scope.current = null;
    turn.current = null;
    await closing();
  }

async function resolveConfiguredModel(target: ActiveBridge, modelId: string, frozenOverride?: any) {
    if (!modelId || modelId === "pi:current") {
      if (!frozenOverride) return { profile: null, model: target.context.model };
      const frozenModel = frozenOverride.provider && frozenOverride.model
        ? target.context.modelRegistry.find(frozenOverride.provider, frozenOverride.model)
        : null;
      if (!frozenModel) throw new Error(`Frozen Pi model was not found: ${frozenOverride.provider}/${frozenOverride.model}.`);
      return { profile: null, model: frozenModel };
    }
    const currentProfile = (await target.configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === modelId);
    const profile = frozenOverride
      ? { ...structuredClone(frozenOverride), apiKey: currentProfile?.apiKey || "" }
      : currentProfile;
    if (!profile) throw new Error(`Unknown model profile: ${modelId}`);
    if (profile.baseUrl) {
      const providerId = `rp-${profile.id}`;
      pi.registerProvider(providerId, {
        name: profile.name,
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey || undefined,
        api: profile.api || "openai-completions",
        models: [{
          id: profile.model,
          name: profile.name,
          reasoning: profile.thinking !== "off",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: profile.contextWindow,
          maxTokens: profile.maxOutputTokens,
        }],
      } as any);
      const model = target.context.modelRegistry.find(providerId, profile.model);
      if (!model) throw new Error(`Model profile ${modelId} could not be registered.`);
      return { profile, model };
    }
    const model = target.context.modelRegistry.find(profile.provider, profile.model);
    if (!model) throw new Error(`Pi model was not found: ${profile.provider}/${profile.model}`);
    return { profile, model };
  }

function rememberDataReceipt(run: any, nodeId: string, receipt: any) {
    if (!receipt?.batchId || !["committed", "partial"].includes(receipt.status)) return receipt;
    const nodeBatches = run.nodes?.[nodeId]?.dataReadBatchIds;
    if (Array.isArray(nodeBatches) && !nodeBatches.includes(receipt.batchId)) nodeBatches.push(receipt.batchId);
    run.dataReadBatchIds ||= [];
    if (!run.dataReadBatchIds.includes(receipt.batchId)) run.dataReadBatchIds.push(receipt.batchId);
    return receipt;
  }

const executeWorkflowNode = scope.bind(createRpNodeExecutor({ scope, turn, appendMessage, updateMetadata, buildDynamicProcessorContext, rememberDataReceipt, promptControlsService, resolveConfiguredModel }));

async function startBridge(cardArgument: string, context: ExtensionContext) {
    await stopBridge();
    const cardDirectory = resolveCardDirectory(context.cwd, cardArgument.trim());
    if (boundCardId && cardArgument.trim() !== boundCardId) throw new Error(`This Pi process is bound to card ${boundCardId}.`);
    const manifest = JSON.parse(await readFile(resolve(cardDirectory, "manifest.json"), "utf8"));
    if (manifest.schema_version !== 2 || !manifest.id || !manifest.name) throw new Error("Card manifest must use schema_version 2 and contain id and name.");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.id)) {
      throw new Error("Card manifest id must be filesystem-safe before Web session storage can start.");
    }
    const webModulePath = resolve(cardDirectory, "web", "server.mjs");
    const webModule = await import(`${pathToFileURL(webModulePath).href}?session=${Date.now()}`);
    if (typeof webModule.startWebBridge !== "function") {
      throw new Error("Card web/server.mjs does not export startWebBridge().");
    }

    const cardSessionsDirectory = resolve(context.cwd, "sessions", manifest.id);
    const commonSettingsDirectory = isolatedRuntime ? resolve(cardDirectory, "settings-assets") : resolve(context.cwd, "settings");
    const commonSettingsPath = isolatedRuntime ? resolve(cardDirectory, "defaults", "common.json") : resolve(commonSettingsDirectory, "common.json");
    const avatarsDirectory = resolve(commonSettingsDirectory, "avatars");
    const cardSettingsPath = resolve(cardDirectory, "settings.json");
    const configProfiles = createConfigProfileStore({
      rootDirectory: context.cwd,
      directory: resolve(cardDirectory, "config-profiles"),
      scope: "card",
      ownerId: manifest.id,
    });
    await configProfiles.ensure();
    if (isolatedRuntime && (await configProfiles.list()).profiles.length === 1) {
      const profile = await configProfiles.create({ id: "card-local", name: "本卡设置" });
      const defaults = JSON.parse(await readFile(resolve(cardDirectory, "defaults", "model-profiles.json"), "utf8"));
      if (Array.isArray(defaults.profiles) && defaults.profiles.length) await configProfiles.save({ ...profile, models: defaults.profiles });
      await configProfiles.activate("card-local");
    }
    // Module workflows are read through their owning module registry, exactly like the workflow
    // engine does, so restore/retry/panel-default edits resolve the same definition the failed run
    // was started from and never fabricate a duplicate top-level workflow.
    await loadCardComponents(cardDirectory);
    const registeredFeatureModules = validateModuleRegistry(await readFeatureModules(cardDirectory, manifest.feature_modules));
    const configStore = createRpConfigStore(context.cwd, cardDirectory, {
      getModules: async () => scope.current?.cardDirectory === cardDirectory ? scope.current.featureModules : registeredFeatureModules,
      isolatedRuntime,
      profileStore: configProfiles,
    });

    const configToken = randomBytes(24).toString("base64url");
    await Promise.all([
      mkdir(commonSettingsDirectory, { recursive: true }),
      mkdir(avatarsDirectory, { recursive: true }),
      configStore.ensure(),
    ]);
    const globalCommonSettings = normalizeCommonSettings(isolatedRuntime
      ? JSON.parse(await readFile(commonSettingsPath, "utf8"))
      : await readOrCreateJson<CommonSettings>(commonSettingsPath, defaultCommonSettings));
    if (!isolatedRuntime) await writeFile(commonSettingsPath, `${JSON.stringify(globalCommonSettings, null, 2)}\n`, "utf8");
    const cardSettings = await readOrCreateJson<CardSettings>(cardSettingsPath, {
      schemaVersion: 1,
      cardId: manifest.id,
      settings: {},
    });
    if (!cardSettings.settings || typeof cardSettings.settings !== "object" || Array.isArray(cardSettings.settings)) {
      cardSettings.settings = {};
    }
    const commonSettings = mergeCommonSettings(globalCommonSettings, cardSettings.settings.common) as CommonSettings;
    const stableCardContext = await readCardContextFile(cardDirectory, manifest.fixed_context, "fixed_context");
    const featureModules = applyModuleProfile(registeredFeatureModules, await configProfiles.getActive());
    const comfyUi = createComfyUiService({ rootDirectory: context.cwd, cardDirectory, featureModules, isolatedRuntime });
    const contextProcessors = await readContextProcessors(cardDirectory, manifest.context_processors, featureModules);
    const messagePolicy = await readMessageRetrievalPolicy(cardDirectory, manifest.context_policy);
    const messageSkill = await readMessageRetrievalSkill(cardDirectory, manifest.context_skill, messagePolicy);
    cardSettings.settings.featureModules = normalizeModuleDisplaySettings(cardSettings.settings.featureModules, featureModules);
    const activeWorkflowId = await resolveActiveWorkflowId(configStore, cardSettings);
    await writeFile(cardSettingsPath, `${JSON.stringify(cardSettings, null, 2)}\n`, "utf8");
    const candidateRecordId = context.sessionManager.getSessionId();
    const candidateSessionDirectory = resolveSessionDirectory(cardSessionsDirectory, candidateRecordId);
    const metadataPath = resolve(candidateSessionDirectory, "session.json");
    const messagesPath = resolve(candidateSessionDirectory, "messages.jsonl");
    const previousMetadata = await readFile(metadataPath, "utf8").then(JSON.parse).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (previousMetadata?.cardId && previousMetadata.cardId !== manifest.id) {
      throw new Error("This Pi session already has a Web RP transcript for another card.");
    }
    const messages: RecordEnvelope[] = await readFile(messagesPath, "utf8").then(text => parseRecordLines(text) as RecordEnvelope[]).catch(error => {
        if (error.code !== "ENOENT") throw error;
        return [];
      });
    const hasExistingRecord = messages.length > 0;

    scope.current = {
      cardDirectory,
      isolatedRuntime,
      cardId: manifest.id,
      cardName: manifest.name,
      context,
      candidateRecordId,
      candidateSessionDirectory,
      recordId: hasExistingRecord ? candidateRecordId : null,
      sessionDirectory: hasExistingRecord ? candidateSessionDirectory : null,
      openingId: hasExistingRecord
        ? previousMetadata?.openingId || (messages.some(message => message.data.kind === "opening") ? manifest.default_opening : null)
        : null,
      playerName: hasExistingRecord ? previousMetadata?.playerName || commonSettings.user?.playerName || "玩家" : commonSettings.user?.playerName || "玩家",
      playerDescription: hasExistingRecord ? previousMetadata?.playerDescription ?? commonSettings.user?.description ?? "" : commonSettings.user?.description ?? "",
      stableCardContext,
      featureModules,
      messagePolicy,
      messageSkillPath: messageSkill.path,
      messageSkillDescription: messageSkill.description,
      contextProcessors,
      commonSettings,
      cardSettings,
      messages,
      pending: false,
      turn: messages.reduce((maximum, message) => Math.max(maximum, message.binding.turn), 0),
      configStore,
      configProfiles,
      configToken,
      comfyUi,
      workflowEngine: null as any,
      activeWorkflowId,
      close: async () => {},
      url: "",
    };

    const deliveredWorkflowEvents = new Set<string>();
    let workflowWriteQueue: Promise<unknown> = Promise.resolve();
    const serializeWorkflowWrite = async <T>(operation: () => Promise<T>) => {
      const result = workflowWriteQueue.then(operation, operation);
      workflowWriteQueue = result.then(() => undefined, () => undefined);
      return result;
    };
    const nodeCompletionTurns = new Map<string, number>();
    // Run -> shared data-read view references, rebuildable from persisted run state. Declared here
    // because both the initial restore and resuming a saved chat rebuild it.
    const readViewRegistry = createDataReadViewRegistry();
    const hydrateNodeCompletionTurns = async (sessionDirectory: string | null) => {
      nodeCompletionTurns.clear();
      if (!sessionDirectory) return;
      const snapshots = await readFile(resolve(sessionDirectory, "workflow", "runs.jsonl"), "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const run of snapshots) {
        if (!Number.isSafeInteger(run.turn)) continue;
        for (const state of Object.values(run.nodes || {}) as any[]) {
          if (state.status !== "completed") continue;
          const key = `${run.workflowId}:${state.id}`;
          nodeCompletionTurns.set(key, Math.max(nodeCompletionTurns.get(key) || -1, run.turn));
        }
      }
    };
    await hydrateNodeCompletionTurns(scope.requireCurrent().sessionDirectory);
    const dispatchWorkflowEvent = async (event: any, parentRun: any) => {
      if (!scope.current?.recordId || !scope.requireCurrent().sessionDirectory) return;
      const available = await configStore.listWorkflows();
      for (const candidate of available) {
        if (candidate.invalid || candidate.source !== "module" || candidate.kind === "foreground") continue;
        if (!workflowTriggerMatches(candidate, event)) continue;
        const triggerDocuments: Record<string, any> = {};
        if (candidate.trigger?.documents && Object.keys(candidate.trigger.documents).length) {
          const sourceWorkflow = await configStore.getWorkflow(event.workflowId);
          for (const [inputId, mapping] of Object.entries(candidate.trigger.documents) as any[]) {
            const sourceNode = sourceWorkflow.nodes.find((node: any) => node.id === mapping.fromNode);
            const output = sourceNode?.outputs?.[mapping.output];
            const state = parentRun.nodes?.[mapping.fromNode];
            if (!sourceNode || !output || state?.status !== "completed") throw new Error(`Trigger document ${inputId} is unavailable from ${mapping.fromNode}/${mapping.output}.`);
            if (!["turn", "session", "public"].includes(output.scope)) throw new Error(`Trigger document ${inputId} must use turn, session, or public scope.`);
            // Prefer the producer's own output; accept the handoff mirror the producer published with
            // `workspaceHandoff`, including an intentional `as` rename. Both are declared artifacts of
            // the same completed node, so neither invents material.
            const producerWorkspace = workflowNodeWorkspace(scope.requireChat().sessionDirectory, sourceWorkflow.id, parentRun.id, sourceNode.id);
            const candidates = [
              resolve(producerWorkspace, output.path),
              resolve(producerWorkspace, "handoff", sourceNode.id, output.path),
            ];
            const rewrite = (sourceNode.workspaceHandoff?.include || []).find((item: any) => item.output === mapping.output);
            if (typeof rewrite?.as === "string" && rewrite.as) candidates.push(resolve(producerWorkspace, "handoff", sourceNode.id, rewrite.as));
            let absolute: string | null = null;
            for (const candidatePath of candidates) {
              const readable = await readFile(resolve(candidatePath, output.kind === "directory" ? "DOCUMENTS.md" : ""), output.kind === "directory" ? "utf8" : undefined as any).then(() => true, () => false);
              if (readable) {
                absolute = candidatePath;
                break;
              }
            }
            if (!absolute) {
              throw new Error(`Trigger document ${inputId} was not produced: ${sourceWorkflow.id}/${sourceNode.id} declares output ${mapping.output} at ${output.path}, but no readable artifact exists there or in its handoff mirror.`);
            }
            triggerDocuments[inputId] = {
              path: relative(scope.requireChat().sessionDirectory, absolute).replaceAll("\\", "/"),
              format: output.format,
              kind: output.kind,
              narrativeSource: state.narrativeSource,
              sourceReferences: parentRun.sourceReferences || [],
              sourceArtifact: { workflowId: sourceWorkflow.id, workflowRunId: parentRun.id, nodeId: sourceNode.id, id: mapping.output, turn: parentRun.turn },
            };
          }
        }
        const visibleMessages = scope.requireCurrent().messages.filter(message => message.binding.turn <= parentRun.turn);
        const runId = `workflow-${randomUUID()}`;
        try {
          const frozenTriggerDocuments = await freezeTriggeredDocuments({ sessionDirectory: scope.requireChat().sessionDirectory, workflow: candidate, runId, triggerDocuments });
          await scope.requireCurrent().workflowEngine.start(candidate, {
            id: runId,
            cardId: scope.requireCurrent().cardId,
            chatId: scope.requireCurrent().recordId,
            turn: parentRun.turn,
            visibleThroughTurn: candidate.kind === "global-background" ? parentRun.turn : null,
            trigger: event,
            sourceReferences: visibleMessages.map(messageSourceReference),
            payload: {
              parentRunId: parentRun.id,
              triggerDocuments: frozenTriggerDocuments,
            },
          });
        } catch (error) {
          await cleanupFrozenTriggerInputs(scope.requireChat().sessionDirectory, candidate.id, runId).catch(() => {});
          context.ui.notify(`Background workflow ${candidate.id} was not started: ${(error as Error).message}`, "warning");
        }
      }
    };

    scope.requireCurrent().workflowEngine = new RpWorkflowEngine(bindWebBridge(scope, {
      policy: await configStore.getRuntimePolicy(),
      readCallTextFile: (request: any) => {
        if (!scope.current?.sessionDirectory || scope.requireCurrent().recordId !== request.run.chatId) throw new Error("Workflow call textFile has no active RP chat.");
        return readWorkflowCallTextFile({ ...request, sessionDirectory: scope.requireChat().sessionDirectory });
      },
      resolveAgent: async (agentId: string | null) => agentId ? (await configStore.getAgent(agentId)).effective : null,
      resolveModel: async (modelId: string) => {
        if (modelId === "pi:current") {
          const current = scope.current?.context.model;
          return current ? { id: "pi:current", provider: current.provider, model: current.id, maxConcurrency: 10 } : null;
        }
        return (await configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === modelId) || null;
      },
      resolveWorkflow: async (reference: string) => {
        for (const module of scope.current?.featureModules || []) {
          const workflow = module.workflows.find(candidate => canonicalWorkflowRef(candidate) === reference);
          if (workflow) return workflow;
        }
        return null;
      },
      onRunStart: async ({ run }: any) => {
        readViewRegistry.register(run);
        if (!scope.current?.sessionDirectory || scope.requireCurrent().recordId !== run.chatId) throw new Error("The workflow data read view has no active RP chat.");
        const store = createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules });
        const view = run.dataReadViewId ? { viewId: run.dataReadViewId } : await createDataReadView({
          sessionDirectory: scope.requireChat().sessionDirectory,
          store,
          sourceId: run.callContext?.rootRunId || run.id,
          visibleThroughTurn: run.visibleThroughTurn,
          visibleThroughTime: run.readSnapshotAt,
        });
        readViewRegistry.register({ ...run, dataReadViewId: view.viewId });
        const agentPromptControls = await snapshotAgentPromptControls(scope.requireCurrent().featureModules, (module: FeatureModule, region: any) => getDataRecord(store, {
          moduleId: module.id, collectionId: region.collectionId, id: region.recordId, view: region.view,
        }, { capabilities: [region.readCapability], views: [region.view], ...workflowDataReadAccess({ ...run, dataReadViewId: view.viewId }, store) }));
        return { dataReadViewId: view.viewId, dataReadBatchIds: run.dataReadBatchIds || [], agentPromptControls };
      },
      executor: executeWorkflowNode,
      beforeNodeComplete: async ({ workflow, run, node, result }: any) => {
        if (!scope.current?.sessionDirectory || scope.requireCurrent().recordId !== run.chatId) throw new Error("The workflow data commit has no active RP chat.");
        const store = createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules });
        const finalized = await finalizeNodeData({ sessionDirectory: scope.requireChat().sessionDirectory, store, workflow, run, node, result });
        for (const receipt of finalized.dataReceipts || []) rememberDataReceipt(run, node.id, receipt);
        return finalized;
      },
      onRunTerminal: async ({ run }: any) => {
        // A terminal parent is not the end of its descendants. Release this run's reference and
        // delete the snapshot only when no run still reads it — a deep-director child that outlives
        // the wrapper keeps the view it was handed.
        if (!scope.current?.sessionDirectory || scope.requireCurrent().recordId !== run.chatId) return;
        const releasable = readViewRegistry.release(run.id, run.dataReadViewId);
        if (!releasable) return;
        await deleteDataReadView({ sessionDirectory: scope.requireChat().sessionDirectory, viewId: releasable });
      },
      nodeHistory: (workflowId: string, nodeId: string) => nodeCompletionTurns.get(`${workflowId}:${nodeId}`) ?? null,
      onNodeComplete: async ({ workflow, run, node, agent, binding, result }: any) => {
        if (!scope.current?.sessionDirectory || scope.requireCurrent().recordId !== run.chatId) throw new Error("The workflow process record has no active RP chat.");
        const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(scope.requireChat().sessionDirectory, workflow.id, run.id, workflow.kind));
        const documentPath = await writeWorkflowProcessRecord(paths.workflowProcessRecords, {
          workflowId: workflow.id,
          runId: run.id,
          nodeId: node.id,
          nodeType: node.type,
          agentId: result.processRecord ? agent?.id || binding.agentId || null : null,
          modelId: result.processRecord ? binding.modelId || null : null,
          completedAt: run.nodes[node.id]?.completedAt,
          exchange: result.processRecord || null,
        });
        return {
          available: true,
          path: relative(scope.requireCurrent().context.cwd, documentPath).replaceAll("\\", "/"),
        };
      },
      onChange: async (run: any, workflow: any) => {
        if (!scope.current?.sessionDirectory || scope.requireCurrent().recordId !== run.chatId) return;
        const terminal = ["completed", "skipped", "failed", "cancelled"].includes(run.status);
        return withTerminalForegroundRelease(run, workflow, async () => {
          const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(scope.requireChat().sessionDirectory, workflow.id, run.id, workflow.kind));
          await serializeWorkflowWrite(() => appendWorkflowRunRecord(paths.workflowRuns, run));
          if (terminal) {
            await cleanupArtifacts(scope.requireChat().sessionDirectory, { type: "run", workflowRunId: run.id });
            await cleanupFrozenTriggerInputs(scope.requireChat().sessionDirectory, workflow.id, run.id);
          }
          for (const state of Object.values(run.nodes) as any[]) {
            const eventKey = `${run.id}:node:${state.id}:completed`;
            if (state.status === "completed" && !deliveredWorkflowEvents.has(eventKey)) {
              await serializeWorkflowWrite(async () => {
                const artifactDirectory = resolve(paths.workflowArtifacts, run.id);
                await mkdir(artifactDirectory, { recursive: true });
                await writeFile(resolve(artifactDirectory, `${state.id}.json`), `${JSON.stringify({ schemaVersion: 1, workflowId: workflow.id, runId: run.id, nodeId: state.id, turn: run.turn, output: state.output, usage: state.usage }, null, 2)}\n`, "utf8");
              });
              if (Number.isSafeInteger(run.turn)) nodeCompletionTurns.set(`${workflow.id}:${state.id}`, run.turn);
              deliveredWorkflowEvents.add(eventKey);
              if (!workflow.kind.startsWith("module-")) await dispatchWorkflowEvent({ type: "node", workflowId: workflow.id, nodeId: state.id, runId: run.id }, run);
            }
          }
          const completeKey = `${run.id}:workflow:completed`;
          if (run.status === "completed" && !deliveredWorkflowEvents.has(completeKey)) {
            deliveredWorkflowEvents.add(completeKey);
            if (!workflow.kind.startsWith("module-")) await dispatchWorkflowEvent({ type: "after-workflow", workflowId: workflow.id, runId: run.id }, run);
          }
        }, () => {
          // Host persistence, cleanup and event delivery may fail. A terminal foreground run must
          // still release the exact turn it owns, otherwise the engine records the host failure but
          // the Web session remains busy forever with no cancellable live instance.
          if (turn.current && turn.current.workflowRunId === run.id) {
            if (run.status === "completed" && turn.current.agentSettled) {
              turn.current.workflowCompleted = true;
              releaseCompletedRpTurn(run.id);
            } else {
              releaseRpTurn("failed", describeTurnFailure(run, Boolean(turn.current.agentSettled)));
            }
          }
        });
      },
    }));

    const restoreWorkflowRuns = async (sessionDirectory: string | null) => {
      if (!sessionDirectory) return;
      // The reference graph is rebuilt from persisted runs *before* any restore, because restoring a
      // run that is already terminal immediately runs its terminal finalization — and that
      // finalization must see the other consumers of the same view, not just itself.
      const persistedRuns = await readFile(resolve(sessionDirectory, "workflow", "runs.jsonl"), "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      const latestPersisted = new Map<string, any>();
      for (const run of persistedRuns) latestPersisted.set(run.id, run);
      const revived = readViewRegistry.hydrate([...latestPersisted.values()]);
      if (revived) console.log(`Data read views kept alive by ${revived} restored workflow run(s).`);
      const persisted = persistedRuns;
      const latest = new Map<string, any>();
      for (const run of persisted) latest.set(run.id, run);
      for (const run of latest.values()) {
        if (["completed", "skipped", "failed", "cancelled"].includes(run.status)) continue;
        try {
          const workflow = await configStore.getModuleWorkflow(run.ownerModuleId || null, run.workflowId);
          if (!workflow) throw new Error(`Workflow definition was not found for ${run.workflowId}.`);
          for (const state of Object.values(run.nodes || {}) as any[]) {
            if (state.status === "completed") deliveredWorkflowEvents.add(`${run.id}:node:${state.id}:completed`);
          }
          if (workflow.kind === "foreground" && !turn.current && typeof run.payload?.currentInput === "string") {
            const finalizer = workflow.nodes.find((node: any) => node.type === "turn-finalize");
            const existingAssistant = scope.requireCurrent().messages.find(message => message.binding.turn === run.turn && message.data.role === "assistant");
            scope.requireCurrent().pending = true;
            turn.current = {
              cardId: scope.requireCurrent().cardId,
              recordId: scope.requireCurrent().recordId!,
              submittedText: run.payload.currentInput,
              submittedSequence: Number.isSafeInteger(run.payload.userSequence) ? run.payload.userSequence : scope.requireCurrent().messages.at(-1)?.sequence || 0,
              assistantContent: "",
              automaticSelections: {}, agentQueries: [], agentSources: [], processorSelections: [],
              contextContent: null, phase: "narrative", assistantMessageId: existingAssistant?.id || null,
              workflowRunId: run.id, workflowNarrativeNodeId: finalizer?.narrative?.fromNode || null,
              resolveNarrative: null, rejectNarrative: null,
              baseModel: scope.requireCurrent().context.model,
              agentSettled: Boolean(existingAssistant),
            };
          }
          await scope.requireCurrent().workflowEngine.restore(workflow, run);
          readViewRegistry.register({ ...run, terminalFinalized: undefined });
        } catch (error) {
          // A run that cannot be restored stayed non-terminal in `runs.jsonl`, so every later load
          // retried the same failing restore and `blockingTurnRuns()` kept counting it — the session was
          // blocked for ever by a run that could never make progress. Record it as terminally failed,
          // with the reason, so it stops blocking and the panel has something to show.
          const failedRun = {
            ...run,
            status: "failed",
            error: `Could not be restored: ${(error as Error).message}`,
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            changeFailures: [...(Array.isArray(run.changeFailures) ? run.changeFailures : []), { at: new Date().toISOString(), hook: "restore", message: (error as Error).message }].slice(-5),
          };
          try {
            // `workflow` is scoped to the try block, so the failure path must derive the workspace
            // kind from the persisted run itself. `run.kind` is what the run was written with.
            const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(scope.requireChat().sessionDirectory, run.workflowId, run.id, run.kind));
            await serializeWorkflowWrite(() => appendWorkflowRunRecord(paths.workflowRuns, failedRun));
          } catch (writeError) {
            console.warn(`Could not persist the failed restore of workflow run ${run.id}: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
          }
          context.ui.notify(`Workflow run ${run.id} could not be restored and was marked failed so it no longer blocks this chat: ${(error as Error).message}`, "warning");
        }
      }
    };
    await restoreWorkflowRuns(scope.requireCurrent().sessionDirectory);

    function requireFrontendModule(moduleId: string) {
      const module = scope.current?.featureModules.find(item => item.id === moduleId && item.surface === "frontend");
      if (!module) throw httpError(404, `Frontend feature module ${moduleId} was not found.`);
      return module;
    }
    function activeDataStore() {
      if (!scope.current?.sessionDirectory) throw httpError(409, "Start or resume a chat before using module data.");
      return createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules });
    }
    async function startManualBackgroundWorkflow(workflowId: string, payload: any) {
      if (!scope.current?.recordId || !scope.requireCurrent().sessionDirectory) throw httpError(409, "Start or resume a chat before running a background workflow.");
      const workflow = await configStore.copyWorkflowToCard(workflowId);
      if (workflow.kind === "foreground" || workflow.kind.startsWith("module-")) throw httpError(400, "Manual controls may activate only top-level background workflows.");
      const completedThrough = latestCompletedTurn(scope.current);
      const visibleMessages = scope.requireCurrent().messages.filter(message => message.binding.turn <= (workflow.kind === "global-background" ? completedThrough : scope.current!.turn));
      const run = await scope.requireCurrent().workflowEngine.start(workflow, {
        cardId: scope.requireCurrent().cardId,
        chatId: scope.requireCurrent().recordId,
        turn: workflow.kind === "global-background" ? completedThrough : scope.requireCurrent().turn,
        visibleThroughTurn: workflow.kind === "global-background" ? completedThrough : null,
        trigger: { type: "manual" },
          sourceReferences: [],
          payload: { ...payload },
      });
      return { activated: workflow.id, run };
    }
    let bridge;
    try {
      bridge = await webModule.startWebBridge({
        cardDirectory,
        bridge: bindWebBridge(scope, {
...createConfigWebBridge({ manifest, scope, configToken, configProfiles, configStore, cardDirectory, ensureFeatureModuleRecords, context, resolveConfiguredModel }),
...createWorkflowsWebBridge({ scope, configStore, cardSettingsPath, startManualBackgroundWorkflow, turn, requireFrontendModule }),
...createModulesWebBridge({ scope, ensureFeatureModuleRecords, activeDataStore, requireFrontendModule, cardSettingsPath }),
...createChatWebBridge({ webSnapshot, scope, manifest, commonSettingsDirectory, cardSettingsPath, isolatedRuntime, cardDirectory, context, boundCardId, pi, cardSessionsDirectory, rewriteMessages, updateMetadata, pruneModuleRecords, hydrateNodeCompletionTurns, restoreWorkflowRuns, ensureFeatureModuleRecords, appendMessage, dispatchWorkflowEvent, ensureActiveRecord, turn }),
...createImageWebBridge({ getSession: () => scope.requireCurrent(), ensureFeatureModuleRecords, configStore, httpError, openLocalDocument, imageExecutionGuard })
}),
      });
    } catch (error) {
      scope.current = null;
      throw error;
    }
    scope.requireCurrent().close = bridge.close;
    scope.requireCurrent().url = bridge.url;
    await updateMetadata();
    if (process.env.BOBO_RP_READY_FILE && isolatedRuntime) {
      await writeFile(process.env.BOBO_RP_READY_FILE, `${JSON.stringify({ cardId: manifest.id, url: bridge.url })}\n`, "utf8");
    } else openBrowser(bridge.url);
    context.ui.notify(`Web RP opened: ${bridge.url}`, "info");
    return bridge.url;
  }

function currentDataNode() {
    return resolveCurrentDataNode({
      sessionDirectory: scope.current?.sessionDirectory,
      featureModules: scope.current?.featureModules || [],
      getRun: (runId: string) => (scope.current?.workflowEngine as any)?.runs?.get(runId),
      workflowRunId: turn.current?.workflowRunId,
      narrativeNodeId: turn.current?.workflowNarrativeNodeId,
    });
  }

return { scope, startBridge, stopBridge, register: createHostRegistration({ startBridge, currentDataNode, scope, rememberDataReceipt, turn, writeContextReceipt, boundCardId, isolatedRuntime, stopBridge }) };
}
