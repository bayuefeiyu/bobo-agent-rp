import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  buildCatalog,
  createRecordEnvelope,
  formatCatalog,
  normalizeRetrievalPolicy,
  parseRecordLines,
  reviseRecord,
  selectRecords,
  toRecordLines,
  validateRecordEnvelope,
} from "../lib/rp-records.mjs";
import {
  runContextProcessor,
  validateContextProcessorDefinition,
} from "../lib/rp-context-processors.mjs";
import { removeSavedUserProfile } from "../lib/rp-user-profiles.mjs";
import { defaultCommonSettings, mergeCommonSettings, normalizeCommonSettings } from "../lib/rp-common-settings.mjs";
import { createRpConfigStore, resolveActiveForegroundWorkflow } from "../lib/rp-config-store.mjs";
import { createConfigProfileStore } from "../lib/rp-config-profiles.mjs";
import { RpWorkflowEngine } from "../lib/rp-workflow-engine.mjs";
import { withTerminalForegroundRelease } from "../lib/rp-workflow-host.mjs";
import { composeNodePrompt, composeWorkflowNodeDynamicContext, moveModelTailToEnd, resolveNodeProfiles } from "../lib/rp-model-config.mjs";
import { assertDocumentWorkspaceAgentTools, canonicalWorkflowRef, normalizeWorkflowDefinition, resolveCodeNodeRoute, resolveNodeQueryBudget, workflowTriggerMatches } from "../lib/rp-workflows.mjs";
import { normalizeFeatureModuleManifest } from "../lib/rp-feature-modules.mjs";
import { normalizeResourceCatalog } from "../lib/rp-resource-catalog.mjs";
import { copyDocumentSet, copyWorkspaceEntry, writeCollisionSafeFile } from "../lib/rp-document-sets.mjs";
import { tokenUsageFromMessages } from "../lib/rp-token-usage.mjs";
import { appendWorkflowRunRecord, ensureWorkflowWorkspace, pruneWorkflowState, workflowProcessRecordPath, workflowWorkspacePaths, writeWorkflowProcessRecord } from "../lib/rp-workspace.mjs";
import { capabilityAllows, normalizeDataContract } from "../lib/rp-data-contracts.mjs";
import { RpDataStore } from "../lib/rp-data-store.mjs";
import { getDataRecord, getDataRecordHistory, queryAllData, queryData, queryDataStable } from "../lib/rp-data-query.mjs";
import { createDataReadView, deleteDataReadView, readDataReadViewCollection, resolveDataReadViewIdentity } from "../lib/rp-data-read-view.mjs";
import { createDataBatchDraft, executeDataBatch, executeDataBatchOrThrow, updateDataBatchDraft } from "../lib/rp-data-changes.mjs";
import { inspectDataImpact, inspectDataIntegrity, readDataReceipt } from "../lib/rp-data-transactions.mjs";
import { dataValueAt } from "../lib/rp-data-index.mjs";
import { finalizeNodeData, resolveCodeSubmissionBinding, resolveCodeSubmissionSourceReferences } from "../lib/rp-data-node-runtime.mjs";
import { cleanupArtifacts, workflowNodeWorkspace } from "../lib/rp-data-artifacts.mjs";
import { createComfyUiService } from "../lib/rp-comfyui.mjs";
import { createRpRandomService } from "../lib/rp-random.mjs";
import { artifactSourceReference, messageSourceReference, narrativeSourceLabel, normalizeNarrativeSource } from "../lib/rp-narrative-source.mjs";
import { applyFrontendSettingsValues, frontendRegion, normalizeModuleFrontendView, validateFrontendWorkflowPayload } from "../lib/rp-module-frontend.mjs";
import { stageWorkflowCallInputs, stageWorkspaceHandoffs } from "../lib/rp-workspace-handoff.mjs";
import { cleanupFrozenTriggerInputs, createDocumentWorkspaceSnapshot, freezeTriggeredDocuments, stageTriggeredDocuments, workspaceDocumentFromArtifact } from "../lib/rp-workspace-snapshot.mjs";
import { runTeamMeeting } from "../lib/rp-team-runtime.mjs";
import { readAuthorizedTeamMaterial, readDeclaredTeamDocuments } from "../lib/rp-team-access.mjs";
import { checkpointTeamSessionAttempt, rollbackTeamSessionAttempt } from "../lib/rp-team-session.mjs";

type WebMessage = {
  sequence: number;
  turn: number;
  role: "user" | "assistant";
  kind: "opening" | "message";
  content: string;
  createdAt: string;
  editedAt?: string;
  narrativeSource?: Record<string, unknown>;
};

const comfyImageExecutions = new Map<string, Promise<unknown>>();

type RecordEnvelope = {
  schemaVersion: 1;
  id: string;
  source: string;
  sequence: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  binding: { messageId: string | null; turn: number };
  metadata: { recordType: string; entityIds: string[]; tags: string[]; title?: string };
  data: Record<string, any>;
};

type RetrievalPolicy = {
  schemaVersion: 2;
  code: { profile: "default" | "custom"; selector: Record<string, any> };
  agent: { mode: "disabled" | "append" | "override"; fallback: "code"; onNotTriggered: "code" | "empty"; maxRecords: number };
};

type ActiveBridge = {
  cardDirectory: string;
  cardId: string;
  cardName: string;
  context: ExtensionContext;
  candidateRecordId: string;
  candidateSessionDirectory: string;
  recordId: string | null;
  sessionDirectory: string | null;
  openingId: string | null;
  playerName: string;
  playerDescription: string;
  stableCardContext: string;
  featureModules: FeatureModule[];
  commonSettings: CommonSettings;
  cardSettings: CardSettings;
  messages: RecordEnvelope[];
  messagePolicy: RetrievalPolicy;
  messageSkillPath: string | null;
  messageSkillDescription: string;
  contextProcessors: ContextProcessor[];
  pending: boolean;
  turn: number;
  configStore: any;
  configProfiles: any;
  configToken: string;
  comfyUi: any;
  workflowEngine: RpWorkflowEngine;
  activeWorkflowId: string;
  close: () => Promise<void>;
  url: string;
};

type RpRun = {
  cardId: string;
  recordId: string;
  submittedText: string;
  submittedSequence: number;
  assistantContent: string;
  automaticSelections: Record<string, string[]>;
  agentQueries: Array<Record<string, unknown>>;
  agentSources: string[];
  processorSelections: Array<{ id: string; include: string[]; error?: string }>;
  contextContent: string | null;
  phase: "narrative" | "done";
  assistantMessageId: string | null;
  workflowRunId?: string | null;
  workflowNarrativeNodeId?: string | null;
  resolveNarrative?: ((value: any) => void) | null;
  rejectNarrative?: ((error: Error) => void) | null;
  modelHeadPrompt?: string | null;
  modelTailPrompt?: string | null;
  nodeAgentPrompt?: string | null;
  workflowNodePrompt?: string | null;
  baseModel?: any;
  phaseStartedAt?: number;
  agentSettled?: boolean;
  workflowCompleted?: boolean;
  /**
   * Set when a foreground turn ended without publishing player-visible prose. The UI states it
   * explicitly, because "no prose" and "this turn needed no prose" must not look the same.
   *
   * `recordId` ties the note to the chat it happened in, so a failure is not reported while the
   * player is looking at a different chat.
   */
  lastTurnFailure?: { turn: number; detail: string | null; at: string; recordId: string | null } | null;
};

type FeatureModule = {
  id: string;
  moduleKind: "data" | "resource" | "hybrid";
  title: string;
  description: string;
  surface: "frontend" | "background";
  contextOrder: number;
  displayOrder: number;
  basedOn: string | null;
  contract: any | null;
  resourceCatalog: any | null;
  resourceCatalogPath: string | null;
  view: { schemaVersion: number; regions: any[] };
  viewPath: string | null;
  moduleDirectory: string;
  skillPath: string;
  skillDescription: string;
  workflows: any[];
};

function dataModuleBindings(modules: FeatureModule[]) {
  return modules.filter(module => module.contract).map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory }));
}

type ContextProcessor = {
  id: string;
  description: string;
  contextOrder: number;
  failure: "error" | "omit";
  entryPath: string;
  definition: any;
  fragments: Array<{ id: string; title: string; path: string }>;
};

type ModuleDisplaySettings = {
  order: string[];
  hidden: string[];
};

type CommonSettings = {
  schemaVersion: 1;
  user: {
    playerName: string;
    description: string;
    savedProfiles: Array<{ name: string; description: string; avatar?: string }>;
  };
  system: { fontSize: number };
};

type CardSettings = {
  schemaVersion: 1;
  cardId: string;
  settings: Record<string, unknown>;
};

function normalizeModuleDisplaySettings(value: any, modules: FeatureModule[]): ModuleDisplaySettings {
  const frontendModules = modules
    .filter(module => module.surface === "frontend")
    .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
  const validIds = new Set(frontendModules.map(module => module.id));
  const order: string[] = [];
  if (Array.isArray(value?.order)) {
    for (const id of value.order) {
      if (typeof id === "string" && validIds.has(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const module of frontendModules) {
    if (!order.includes(module.id)) order.push(module.id);
  }
  const hidden = Array.isArray(value?.hidden)
    ? [...new Set(value.hidden.filter((id: unknown): id is string => typeof id === "string" && validIds.has(id)))]
    : [];
  return { order, hidden };
}

function recordToWebMessage(record: RecordEnvelope): WebMessage {
  const value = validateRecordEnvelope(record) as RecordEnvelope;
  if (value.source !== "messages" || !["user", "assistant"].includes(value.data.role) || !["opening", "message"].includes(value.data.kind) || typeof value.data.content !== "string") {
    throw new Error(`Message record ${value.id} has invalid message data.`);
  }
  return {
    sequence: value.sequence,
    turn: value.binding.turn,
    role: value.data.role,
    kind: value.data.kind,
    content: value.data.content,
    createdAt: value.createdAt,
    ...(value.revision > 1 ? { editedAt: value.updatedAt } : {}),
  };
}

function recordsToWebMessages(records: RecordEnvelope[]) {
  return records.map(recordToWebMessage);
}

function parseSkillDescription(text: string, label: string) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new Error(`${label} must start with YAML frontmatter.`);
  const description = match[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!description) throw new Error(`${label} frontmatter must contain a one-line description.`);
  return description.replace(/^['"]|['"]$/g, "");
}

function avatarExtension(mimeType: string) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  throw httpError(400, "Avatar must be a PNG, JPEG, or WebP image.");
}

function resolveAvatarFile(settingsDirectory: string, avatar: string) {
  if (!/^avatars\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(avatar)) {
    throw httpError(400, "Avatar path is invalid.");
  }
  const target = resolve(settingsDirectory, avatar);
  const relation = relative(settingsDirectory, target);
  if (!relation || relation.startsWith("..") || resolve(settingsDirectory, relation) !== target) {
    throw httpError(400, "Avatar path escapes the settings directory.");
  }
  return target;
}

function playerProfileContext(playerName: string, description: string) {
  return [
    "# Player character profile (fixed RP context)",
    `Name: ${playerName}`,
    description.trim() ? `Description:\n${description.trim()}` : "Description: not specified",
  ].join("\n\n");
}

async function fixedRpContext(active: ActiveBridge) {
  const sections = [
    "# Fixed card context",
    active.stableCardContext,
    playerProfileContext(active.playerName, active.playerDescription),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function featureModuleFixedContext(active: ActiveBridge) {
  if (active.featureModules.length === 0 || !active.sessionDirectory) return "";
  return [
    "# Card feature-module routing",
    ...active.featureModules.map(module => {
      return [
        `## ${module.title} (${module.id})`,
        module.skillDescription,
        `Module skill: ${relative(active.context.cwd, module.skillPath).replaceAll("\\", "/")}`,
        module.contract
          ? `Collections: ${Object.keys(module.contract.collections).join(", ")}. Use rp_data_query/rp_data_get only within the current workflow node's granted capabilities.`
          : `Static resource catalog: ${module.resourceCatalogPath ? relative(active.context.cwd, module.resourceCatalogPath).replaceAll("\\", "/") : "none"}. Access it only through the module's workflows.`,
      ].filter(Boolean).join("\n");
    }),
  ].join("\n\n");
}

function messageRetrievalFixedContext(active: ActiveBridge) {
  if (!active.messageSkillPath) return "";
  return [
    "# Card message-record retrieval skill",
    `Skill: ${relative(active.context.cwd, active.messageSkillPath).replaceAll("\\", "/")}`,
    active.messageSkillDescription,
    "Read this skill before using rp_message_query.",
  ].join("\n");
}

function authoritativeTranscript(active: ActiveBridge, messages: RecordEnvelope[]) {
  if (messages.length === 0) return "No prior conversation messages are stored.";
  return messages.map(record => {
    const message = recordToWebMessage(record);
    const speaker = message.role === "user" ? active.playerName : active.cardName;
    const kind = message.kind === "opening" ? "authored opening" : `turn ${message.turn}`;
    return `[${record.id} | ${speaker} | ${kind} | ${narrativeSourceLabel(record.metadata?.narrativeSource)}]\n${message.content}`;
  }).join("\n\n");
}

function recentCompletedTurnContext(active: ActiveBridge, beforeTurn: number, limit = 5) {
  const eligible = active.messages.filter(message => message.binding.turn < beforeTurn);
  const completedTurns = [...new Set(eligible.filter(message => message.data.role === "assistant").map(message => message.binding.turn))].slice(-limit);
  return authoritativeTranscript(active, eligible.filter(message => completedTurns.includes(message.binding.turn)));
}

async function readCardContextFile(cardDirectory: string, value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} must be one relative file path.`);
  const path = resolveCardChild(cardDirectory, value);
  if (!path) throw new Error(`${label} path escapes the card directory: ${value}`);
  return `## ${value}\n${(await readFile(path, "utf8")).trim()}`;
}

function resolveFeatureModuleChild(moduleDirectory: string, path: unknown, label: string) {
  if (typeof path !== "string" || !path || path.includes("\\")) throw new Error(`${label} must be a safe relative path.`);
  const target = resolve(moduleDirectory, path);
  const relation = relative(moduleDirectory, target);
  if (!relation || relation.startsWith("..") || resolve(moduleDirectory, relation) !== target) {
    throw new Error(`${label} escapes its feature-module directory.`);
  }
  return target;
}


function runtimeRetrievalPolicy(value: any, expectedSource: string, sourceKind: string): RetrievalPolicy {
  const fields = ["schemaVersion", "source", "code", "agent"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) {
    throw new Error(`Retrieval policy ${expectedSource} must use the exact schemaVersion 2 field set.`);
  }
  if (value.schemaVersion !== 2 || value.source !== expectedSource) throw new Error(`Retrieval policy source must be ${expectedSource}.`);
  if (!value.code || !["default", "custom"].includes(value.code.profile)) throw new Error(`Retrieval policy ${expectedSource} has an invalid code profile.`);
  if (value.code.profile === "default" && Object.keys(value.code).length !== 1) throw new Error(`Default code policy ${expectedSource} must not define a selector.`);
  if (value.code.profile === "custom" && (Object.keys(value.code).length !== 2 || !value.code.selector || typeof value.code.selector !== "object")) {
    throw new Error(`Custom code policy ${expectedSource} requires exactly one selector.`);
  }
  if (value.code.profile === "custom") selectRecords([], value.code.selector);
  if (!value.agent || Object.keys(value.agent).length !== 4 || !["disabled", "append", "override"].includes(value.agent.mode) || value.agent.fallback !== "code" || !["code", "empty"].includes(value.agent.onNotTriggered) || !Number.isSafeInteger(value.agent.maxRecords) || value.agent.maxRecords < 1) {
    throw new Error(`Retrieval policy ${expectedSource} has an invalid agent policy.`);
  }
  return normalizeRetrievalPolicy(value, sourceKind) as RetrievalPolicy;
}
async function readFeatureModules(cardDirectory: string, paths: unknown): Promise<FeatureModule[]> {
  if (!Array.isArray(paths)) throw new Error("feature_modules must be an array.");
  const modules: FeatureModule[] = [];
  const ids = new Set<string>();
  for (const value of paths) {
    if (typeof value !== "string") throw new Error("feature_modules contains a non-string path.");
    const modulePath = resolveCardChild(cardDirectory, value);
    if (!modulePath) throw new Error(`Feature-module path escapes the card directory: ${value}`);
    const record = normalizeFeatureModuleManifest(JSON.parse(await readFile(modulePath, "utf8")), `Feature module ${value}`);
    if (ids.has(record.id)) throw new Error(`Duplicate feature-module id: ${record.id}`);
    ids.add(record.id);
    const moduleDirectory = resolve(modulePath, "..");
    const viewPath = record.frontendViewFile ? resolveFeatureModuleChild(moduleDirectory, record.frontendViewFile, `${record.id}.frontendViewFile`) : null;
    const contractPath = record.dataContractFile ? resolveFeatureModuleChild(moduleDirectory, record.dataContractFile, `${record.id}.dataContractFile`) : null;
    const resourceCatalogPath = record.resourceCatalogFile ? resolveFeatureModuleChild(moduleDirectory, record.resourceCatalogFile, `${record.id}.resourceCatalogFile`) : null;
    const skillPath = resolveFeatureModuleChild(moduleDirectory, record.skillFile, `${record.id}.skillFile`);
    const workflowPaths = record.workflowFiles.map(path => resolveFeatureModuleChild(moduleDirectory, path, `${record.id}.workflowFiles`));
    const [view, rawContract, rawResourceCatalog, skillText, rawWorkflows] = await Promise.all([
      viewPath ? readFile(viewPath, "utf8").then(JSON.parse) : null,
      contractPath ? readFile(contractPath, "utf8").then(JSON.parse) : null,
      resourceCatalogPath ? readFile(resourceCatalogPath, "utf8").then(JSON.parse) : null,
      readFile(skillPath, "utf8"),
      Promise.all(workflowPaths.map(path => readFile(path, "utf8").then(JSON.parse))),
    ]);
    const contract = rawContract ? normalizeDataContract(rawContract, record.id) : null;
    const resourceCatalog = rawResourceCatalog ? normalizeResourceCatalog(rawResourceCatalog, record.id) : null;
    const normalizedView = view && contract ? normalizeModuleFrontendView(view, contract) : { schemaVersion: 1, regions: [] };
    const workflows = rawWorkflows.map(raw => normalizeWorkflowDefinition(raw));
    for (const workflow of workflows) {
      if (!workflow.kind.startsWith("module-") || workflow.ownerModuleId !== record.id) {
        throw new Error(`Feature module ${record.id} may own only module workflows whose ownerModuleId matches the module.`);
      }
    }
    const refs = workflows.map(canonicalWorkflowRef);
    if (new Set(refs).size !== refs.length) throw new Error(`Feature module ${record.id} declares duplicate workflow references.`);
    modules.push({
      id: record.id,
      moduleKind: record.moduleKind,
      title: record.title.trim(),
      description: record.description.trim(),
      surface: record.surface,
      contextOrder: record.contextOrder,
      displayOrder: record.displayOrder,
      basedOn: record.basedOn,
      contract,
      resourceCatalog,
      resourceCatalogPath,
      view: normalizedView,
      viewPath,
      moduleDirectory,
      skillPath,
      skillDescription: parseSkillDescription(skillText, `${record.id}.skillFile`),
      workflows,
    });
  }
  return modules.sort((left, right) => left.contextOrder - right.contextOrder || left.id.localeCompare(right.id));
}

async function readContextProcessors(cardDirectory: string, paths: unknown, modules: FeatureModule[]): Promise<ContextProcessor[]> {
  if (!Array.isArray(paths)) throw new Error("context_processors must be an array.");
  const processors: ContextProcessor[] = [];
  const ids = new Set<string>();
  const moduleIds = new Set(modules.map(module => module.id));
  for (const value of paths) {
    if (typeof value !== "string") throw new Error("context_processors contains a non-string path.");
    const definitionPath = resolveCardChild(cardDirectory, value);
    if (!definitionPath) throw new Error(`Context-processor path escapes the card directory: ${value}`);
    const definition = validateContextProcessorDefinition(JSON.parse(await readFile(definitionPath, "utf8")));
    if (ids.has(definition.id)) throw new Error(`Duplicate context-processor id: ${definition.id}`);
    ids.add(definition.id);
    for (const query of definition.dependencies.dataQueries) {
      if (!moduleIds.has(query.moduleId)) throw new Error(`Context processor ${definition.id} requires unknown feature module ${query.moduleId}.`);
      const module = modules.find(item => item.id === query.moduleId)!;
      if (!module.contract?.collections[query.collectionId]) throw new Error(`Context processor ${definition.id} requires unknown collection ${query.moduleId}/${query.collectionId}.`);
    }
    const entryPath = resolveFeatureModuleChild(cardDirectory, definition.entryFile, `${definition.id}.entryFile`);
    await readFile(entryPath, "utf8");
    const fragments = [];
    for (const fragment of definition.fragments) {
      const path = resolveFeatureModuleChild(cardDirectory, fragment.file, `${definition.id}.fragments.${fragment.id}`);
      await readFile(path, "utf8");
      fragments.push({ id: fragment.id, title: fragment.title.trim(), path });
    }
    processors.push({
      id: definition.id,
      description: definition.description.trim(),
      contextOrder: definition.contextOrder,
      failure: definition.failure,
      entryPath,
      definition,
      fragments,
    });
  }
  return processors.sort((left, right) => left.contextOrder - right.contextOrder || left.id.localeCompare(right.id));
}

async function readMessageRetrievalPolicy(cardDirectory: string, path: unknown): Promise<RetrievalPolicy> {
  if (typeof path !== "string") throw new Error("manifest context_policy must be a card-relative path.");
  const policyPath = resolveCardChild(cardDirectory, path);
  if (!policyPath) throw new Error("manifest context_policy escapes the card directory.");
  const value = JSON.parse(await readFile(policyPath, "utf8"));
  return runtimeRetrievalPolicy(value, "messages", "messages");
}

async function readMessageRetrievalSkill(cardDirectory: string, path: unknown, policy: RetrievalPolicy) {
  const enabled = policy.agent.mode !== "disabled";
  if (!enabled && path === undefined) return { path: null, description: "" };
  if (typeof path !== "string") throw new Error("manifest context_skill is required when message Agent retrieval is enabled.");
  const skillPath = resolveCardChild(cardDirectory, path);
  if (!skillPath) throw new Error("manifest context_skill escapes the card directory.");
  const text = await readFile(skillPath, "utf8");
  return { path: skillPath, description: parseSkillDescription(text, "context_skill") };
}

/**
 * Call targets a workflow declares but this card cannot resolve.
 *
 * A `call` node would fail when it runs and an agent node would simply not see the entry, so
 * reporting the whole set once at load time is clearer than discovering it node by node.
 */
function unresolvedWorkflowCalls(workflow: any, featureModules: any[]): string[] {
  const resolved = new Set<string>();
  for (const module of featureModules || []) {
    for (const candidate of module.workflows || []) resolved.add(`${module.id}/${candidate.id}`);
  }
  const missing = new Set<string>();
  for (const node of workflow.nodes || []) {
    for (const binding of node.workflowCalls || []) {
      const target = typeof binding === "string" ? binding : binding?.target;
      if (typeof target === "string" && !resolved.has(target)) missing.add(target);
    }
    if (node.type === "call" && typeof node.target === "string" && !resolved.has(node.target)) missing.add(node.target);
  }
  return [...missing].sort();
}

/**
 * Resolve the card's active foreground workflow without fabricating or persisting a choice.
 * A missing field is only defaulted when the card declares exactly one foreground workflow;
 * ambiguity and absence are reported instead of silently rewritten into the card's settings.json.
 */
async function resolveActiveWorkflowId(configStore: any, cardSettings: { settings: Record<string, any> }): Promise<string> {
  const topLevel = await configStore.listWorkflows();
  return resolveActiveForegroundWorkflow(topLevel, cardSettings.settings.activeWorkflowId);
}

async function readOrCreateJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(path, `${JSON.stringify(fallback, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(writeError => {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
    });
    return JSON.parse(await readFile(path, "utf8"));
  }
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function mergeConfigValue(base: any, override: any): any {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = mergeConfigValue(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}

function workflowConfigFields(workflow: any) {
  const fields: any[] = [];
  if (workflow.kind === "foreground") {
    fields.push({ path: "/turnContext/recentCompleteTurns", label: "最近完整正文回合数", type: "integer", minimum: 1, maximum: 50, help: "决定正文 Agent 和依赖正文快照的工作流可读取多少个最近完整回合；下一次工作流实例生效。" });
  }
  if (workflow.defaults && typeof workflow.defaults === "object") {
    fields.push({ path: "/defaults/agentId", label: "默认 Agent", type: "agent", help: "节点没有单独指定 Agent 时使用；下一次工作流实例生效。" });
    fields.push({ path: "/defaults/modelId", label: "默认模型", type: "model", help: "节点和 Agent 都没有更高优先级模型时使用；下一次工作流实例生效。" });
  }
  for (let index = 0; index < (workflow.nodes || []).length; index += 1) {
    const node = workflow.nodes[index];
    if (node.type !== "agent") continue;
    fields.push({ path: `/nodes/${index}/agentId`, label: `${node.title || node.id} · Agent`, type: "agent", help: `${node.description || "Agent 节点"} 修改只影响之后启动的实例。` });
    fields.push({ path: `/nodes/${index}/modelId`, label: `${node.title || node.id} · 模型`, type: "model", help: "节点级模型覆盖，优先于工作流和 Agent 默认模型；下一次实例生效。" });
  }
  return fields;
}

function applyModuleProfile(featureModules: FeatureModule[], profile: any) {
  if (!profile) return featureModules;
  return featureModules.map(module => ({
    ...module,
    workflows: module.workflows.map(workflow => {
      const qualified = `module/${module.id}/workflow/${workflow.id}`;
      const override = profile.workflowOverrides?.[qualified] || profile.workflowOverrides?.[workflow.id];
      return override ? normalizeWorkflowDefinition(mergeConfigValue(workflow, override)) : workflow;
    }),
  }));
}

async function moduleAgentCatalog(module: FeatureModule) {
  const directory = resolve(module.moduleDirectory, "agents");
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const result = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name, "agent.json");
    const value = await readFile(path, "utf8").then(JSON.parse).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (value?.id) result.push({ key: `module/${module.id}/agent/${value.id}`, group: `模块 · ${module.title}`, moduleId: module.id, base: value });
  }
  return result;
}

async function activeConfigCatalog(target: ActiveBridge) {
  const agents = (await target.configStore.listAgents()).map((item: any) => ({ key: `${item.source === "card" ? "card" : "runtime"}/agent/${item.effective.id}`, group: "通用", base: item.base }));
  for (const module of target.featureModules) agents.push(...await moduleAgentCatalog(module));
  const workflows = (await target.configStore.listWorkflows()).map((workflow: any) => ({ key: `${workflow.source === "card" ? "card" : "runtime"}/workflow/${workflow.id}`, group: "通用", base: workflow, fields: workflowConfigFields(workflow) }));
  for (const module of target.featureModules) for (const workflow of module.workflows) workflows.push({ key: `module/${module.id}/workflow/${workflow.id}`, group: `模块 · ${module.title}`, moduleId: module.id, base: workflow, fields: workflowConfigFields(workflow) });
  const modules = [];
  for (const module of target.featureModules) {
    let base = {};
    const settings = module.contract?.collections?.settings;
    if (settings?.storage?.initialSnapshotFile) {
      const raw = await readFile(resolve(module.moduleDirectory, settings.storage.initialSnapshotFile), "utf8").then(JSON.parse).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const record = Array.isArray(raw) ? raw[0] : raw;
      if (record?.data && typeof record.data === "object") base = record.data;
    }
    modules.push({
      id: module.id,
      title: module.title,
      description: module.description,
      base,
      fields: (module.view?.regions || []).filter((region: any) => region.type === "settings-form").flatMap((region: any) => (region.fields || []).map((field: any) => ({ ...field, help: field.help || region.description || module.description, applyMode: "new-session", regionId: region.id }))),
    });
  }
  return { schemaVersion: 1, agents, workflows, modules, runtimePolicy: await target.configStore.getRuntimePolicy() };
}

function resolveCardDirectory(cwd: string, card: string) {
  const cardsRoot = resolve(cwd, "cards");
  const target = card.includes("/") || card.includes("\\") ? resolve(cwd, card) : resolve(cardsRoot, card);
  const relation = relative(cardsRoot, target);
  if (!relation || relation.startsWith("..") || resolve(cardsRoot, relation) !== target) {
    throw new Error("The Web RP card must be a child of the project's cards directory.");
  }
  return target;
}

function resolveSessionDirectory(root: string, sessionId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId)) throw httpError(400, "Session ID is invalid.");
  const target = resolve(root, sessionId);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || resolve(root, relation) !== target) {
    throw httpError(400, "Session path escapes the card session directory.");
  }
  return target;
}

function resolveCardChild(cardDirectory: string, path: string) {
  const target = resolve(cardDirectory, path);
  const relation = relative(cardDirectory, target);
  if (!relation || relation.startsWith("..") || resolve(cardDirectory, relation) !== target) return null;
  return target;
}

function imageMimeFromBytes(body: Buffer) {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function locateCardCover(cardDirectory: string, manifest: any) {
  const candidates = [
    typeof manifest.cover === "string" ? manifest.cover : "",
    "cover.png", "cover.apng", "cover.webp", "cover.jpg", "cover.jpeg",
    "source/original.png", "source/original.apng", "source/original.webp", "source/original.jpg", "source/original.jpeg",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = resolveCardChild(cardDirectory, candidate);
    if (!path) continue;
    try {
      const body = await readFile(path);
      const mimeType = imageMimeFromBytes(body);
      if (!mimeType) continue;
      return { body, mimeType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}

function openBrowser(url: string) {
  if (process.platform === "win32") {
    execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url]);
  } else if (process.platform === "darwin") {
    execFile("open", [url]);
  } else {
    execFile("xdg-open", [url]);
  }
}

function openLocalDocument(path: string) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const done = (error: Error | null) => error ? rejectPromise(error) : resolvePromise();
    if (process.platform === "win32") {
      execFile("rundll32.exe", ["url.dll,FileProtocolHandler", path], done);
    } else if (process.platform === "darwin") {
      execFile("open", [path], done);
    } else {
      execFile("xdg-open", [path], done);
    }
  });
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

function debugMessageContent(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (message?.content === undefined) return "";
  return JSON.stringify(message.content, null, 2);
}

function lastAgentExchange(messages: any[], startedAt = 0) {
  const relevant = messages.filter(message => {
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : Date.parse(message?.timestamp || "");
    return !startedAt || !Number.isFinite(timestamp) || timestamp >= startedAt;
  });
  let assistantIndex = -1;
  for (let index = relevant.length - 1; index >= 0; index -= 1) {
    if (relevant[index]?.role === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex === -1) return null;
  const received = relevant.slice(0, assistantIndex).reverse().find(message => message?.role !== "assistant");
  const sent = relevant[assistantIndex];
  return {
    received: received ? { role: received.role || received.customType || "unknown", content: debugMessageContent(received) } : null,
    sent: { role: sent.role || "assistant", content: debugMessageContent(sent) },
  };
}

export default function (pi: ExtensionAPI) {
  let active: ActiveBridge | null = null;
  let rpRun: RpRun | null = null;
  function latestCompletedTurn(target: ActiveBridge) {
    return target.messages.reduce((maximum, message) => message.data.role === "assistant" ? Math.max(maximum, message.binding.turn) : maximum, 0);
  }
  function blockingTurnWorkflows(target: ActiveBridge | null) {
    return target?.workflowEngine?.blockingTurnRuns?.() || [];
  }
  function bridgeBusy(target: ActiveBridge) {
    return target.pending || !target.context.isIdle() || target.workflowEngine?.hasBlockingTurnRun?.() === true;
  }
  /**
   * The Web state every response carries. Keeping one definition means a response can never quietly
   * drop a field the page relies on, such as the note that the last turn produced no prose.
   */
  function webSnapshot(extra: Record<string, unknown> = {}) {
    const failure = active?.lastTurnFailure || null;
    return {
      sessionId: active?.recordId || null,
      openingId: active?.openingId || null,
      playerName: active?.playerName || "玩家",
      messages: active ? recordsToWebMessages(active.messages) : [],
      busy: active ? bridgeBusy(active) : false,
      blockingWorkflows: blockingTurnWorkflows(active),
      lastTurnFailure: failure && failure.recordId === (active?.recordId || null) ? failure : null,
      ...extra,
    };
  }
  /**
   * Release the current turn's foreground occupation.
   *
   * A terminal failure leaves the same situation a cancel does — the player's message stays in
   * the transcript with no reply — so it must release the same way, including aborting a context
   * that never went idle. It additionally records why, because a silently released turn reads as
   * "this turn simply needed no prose".
   */
  function releaseRpTurn(reason: "completed" | "failed", detail: string | null) {
    if (!active || !rpRun) return;
    if (reason === "failed") {
      if (!active.context.isIdle()) {
        try { active.context.abort(); }
        catch (error) { console.warn(`Failed to abort the terminal foreground context: ${error instanceof Error ? error.message : String(error)}`); }
      }
      active.lastTurnFailure = { turn: active.turn, detail, at: new Date().toISOString(), recordId: active.recordId };
    }
    active.pending = false;
    rpRun = null;
  }
  function releaseCompletedRpTurn(runId: string) {
    if (!active || !rpRun || rpRun.workflowRunId !== runId || !rpRun.agentSettled || !rpRun.workflowCompleted) return;
    releaseRpTurn("completed", null);
  }
  /** Short, player-readable reason for a foreground turn that produced no narrative. */
  function describeTurnFailure(run: any, narrativePublished: boolean): string {
    if (run.status === "completed" && !narrativePublished) return "回合收尾节点未发布正文";
    const failed = Object.values(run.nodes || {}).find((state: any) => ["failed", "cancelled"].includes(state?.status));
    const error = typeof failed?.error === "string" && failed.error ? failed.error : null;
    return error ? `${failed.id}：${error}` : `工作流以 ${run.status} 结束`;
  }
  async function ensureFeatureModuleRecords(target: ActiveBridge) {
    if (!target.recordId || !target.sessionDirectory) return;
    const profile = await target.configProfiles.getActive();
    await new RpDataStore({
      sessionDirectory: target.sessionDirectory,
      modules: dataModuleBindings(target.featureModules),
      initialOverrides: profile?.moduleOverrides || {},
    }).initialize();
  }

  async function ensureActiveRecord() {
    if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
    if (!active.recordId || !active.sessionDirectory) {
      await mkdir(active.candidateSessionDirectory, { recursive: true });
      active.recordId = active.candidateRecordId;
      active.sessionDirectory = active.candidateSessionDirectory;
    }
    await ensureFeatureModuleRecords(active);
  }

  async function appendMessage(message: WebMessage) {
    if (!active) return;
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
    active.messages.push(record);
    await appendFile(resolve(active.sessionDirectory!, "messages.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  async function rewriteMessages() {
    if (!active?.sessionDirectory) return;
    const messagesPath = resolve(active.sessionDirectory, "messages.jsonl");
    const temporaryPath = resolve(active.sessionDirectory, `.messages-${Date.now()}-${process.pid}.tmp`);
    await writeFile(temporaryPath, toRecordLines(active.messages), "utf8");
    await rename(temporaryPath, messagesPath);
  }

  async function pruneModuleRecords(target: ActiveBridge, deletedMessageIds: Set<string>) {
    if (!target.sessionDirectory || deletedMessageIds.size === 0) return;
    await new RpDataStore({
      sessionDirectory: target.sessionDirectory,
      modules: dataModuleBindings(target.featureModules),
    }).pruneByMessageIds(deletedMessageIds);
  }

  async function readModuleProcessorData(target: ActiveBridge, module: FeatureModule) {
    if (!module.contract) throw new Error(`Feature module ${module.id} has no unified data contract.`);
    if (!target.sessionDirectory) return { collections: {} };
    await ensureFeatureModuleRecords(target);
    const store = new RpDataStore({ sessionDirectory: target.sessionDirectory, modules: dataModuleBindings(target.featureModules) });
    const collections: Record<string, unknown> = {};
    for (const collectionId of Object.keys(module.contract.collections)) collections[collectionId] = await store.readCollection(module.id, collectionId);
    return { collections };
  }

  async function readSourceRecords(target: ActiveBridge, source: string, run: RpRun): Promise<RecordEnvelope[]> {
    if (source === "messages") return target.messages.filter(record => record.sequence < run.submittedSequence);
    throw new Error(`Unknown RP transcript source: ${source}`);
  }

  function sourcePolicy(target: ActiveBridge, source: string): RetrievalPolicy {
    if (source === "messages") return target.messagePolicy;
    throw new Error(`Unknown RP transcript source: ${source}`);
  }

  function sourceCatalogPath(target: ActiveBridge, source: string) {
    if (!target.sessionDirectory) throw new Error("The active RP chat has no session directory.");
    if (source === "messages") return resolve(target.sessionDirectory, "catalog", "messages.json");
    throw new Error(`Unknown RP transcript source: ${source}`);
  }

  async function refreshSourceCatalog(target: ActiveBridge, source: string, records: RecordEnvelope[]) {
    if (!target.sessionDirectory) return buildCatalog(records);
    const path = sourceCatalogPath(target, source);
    await mkdir(resolve(path, ".."), { recursive: true });
    const catalog = buildCatalog(records);
    await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    return catalog;
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
    const store = new RpDataStore({ sessionDirectory: target.sessionDirectory, modules: dataModuleBindings(target.featureModules) });
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
          content.push(`## ${fragment.title}\n${source.trim()}`);
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
    if (!active?.recordId || !active.sessionDirectory) return;
    const createdAt = active.messages[0]?.createdAt || new Date().toISOString();
    const metadata = {
      id: active.recordId,
      piSessionFile: active.context.sessionManager.getSessionFile() || null,
      cardId: active.cardId,
      cardName: active.cardName,
      openingId: active.openingId,
      playerName: active.playerName,
      playerDescription: active.playerDescription,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(resolve(active.sessionDirectory, "session.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  async function stopBridge() {
    if (!active) return;
    const closing = active.close;
    active = null;
    rpRun = null;
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

  function workflowDataReadAccess(run: any, store: RpDataStore, batchIds: string[] = run.inheritedDataReadBatchIds || []) {
    if (run.dataReadViewId) {
      return {
        readCollection: (moduleId: string, collectionId: string) => readDataReadViewCollection({
          sessionDirectory: store.sessionDirectory,
          store,
          viewId: run.dataReadViewId,
          batchIds,
          moduleId,
          collectionId,
        }),
      };
    }
    return { visibleThroughTurn: run.visibleThroughTurn, visibleThroughTime: run.readSnapshotAt };
  }

  function resolveWorkflowIdentity(run: any, store: RpDataStore, value: string, batchIds: string[] = run.inheritedDataReadBatchIds || []) {
    return run.dataReadViewId
      ? resolveDataReadViewIdentity({ sessionDirectory: store.sessionDirectory, store, viewId: run.dataReadViewId, batchIds, value })
      : store.resolveIdentity(value);
  }

  async function executeWorkflowNode(task: any) {
    if (!active?.recordId || !active.sessionDirectory) throw new Error("The workflow has no active RP chat.");
    const { workflow, run, node, agent, binding } = task;
    const dataReadBatchIds = task.dataReadBatchIds || run.nodes?.[node.id]?.dataReadBatchIds || run.inheritedDataReadBatchIds || [];
    assertDocumentWorkspaceAgentTools(node, agent);
    const usesWorkspace = !task.teamMember && ["agent", "team", "code", "call"].includes(node.type);
    const callInputs = usesWorkspace ? await stageWorkflowCallInputs({ sessionDirectory: active.sessionDirectory, workflow, run, node }) : [];
    const triggeredDocuments = usesWorkspace ? await stageTriggeredDocuments({ sessionDirectory: active.sessionDirectory, workflow, run, node }) : [];
    const upstreamHandoffs = usesWorkspace ? [...triggeredDocuments, ...await stageWorkspaceHandoffs({ sessionDirectory: active.sessionDirectory, workflow, run, node })] : [];
    if (upstreamHandoffs.length) await active.workflowEngine.addSourceReferences(run.id, upstreamHandoffs.map(artifactSourceReference));
    if (node.type === "team") {
      const nodeWorkspace = workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
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
      const meetingContext = [
        `Card: ${active.cardName} (${active.cardId})`,
        `Workflow: ${workflow.id}; run: ${run.id}; turn: ${run.turn ?? "unknown"}`,
        "The full authorized input catalog is at shared/INPUTS.json. Paths in that catalog are relative to the team node workspace; use the team read tool to inspect them.",
        typeof run.payload?.currentInput === "string" && run.payload.currentInput.trim() ? `Current input:\n${run.payload.currentInput.trim()}` : "",
        node.prompt || node.description || "",
      ].filter(Boolean).join("\n\n");
      const invokeTeamTool = async (request: any) => {
        if (request?.adapter !== "declared-document-read-v1") throw new Error(`Unsupported team tool adapter: ${request?.adapter || "missing"}`);
        const documents = await readDeclaredTeamDocuments({ documents: request.documents, nodeWorkspace, maxCharacters: request.arguments?.maxCharacters });
        return { output: { adapter: request.adapter, request: String(request.text || ""), documents }, usage: null };
      };
      const deliverables = await runTeamMeeting({
        config: node.team,
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
      if (!rpRun || rpRun.workflowRunId !== run.id) throw new Error("Turn finalization is not bound to the current RP turn.");
      const sourceNode = workflow.nodes.find((candidate: any) => candidate.id === node.narrative.fromNode);
      const sourceOutput = sourceNode?.outputs?.[node.narrative.output];
      if (!sourceNode || !sourceOutput) throw new Error("Turn finalization narrative source is unavailable.");
      const sourcePath = resolve(workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, sourceNode.id), sourceOutput.path);
      const content = (await readFile(sourcePath, "utf8")).trim();
      if (!content) throw new Error("The selected narrative output is empty.");
      const narrativeSource = normalizeNarrativeSource(run.nodes[sourceNode.id]?.narrativeSource, { producerKind: "agent", layer: "story" });
      const existing = active.messages.find(message => message.binding.turn === run.turn && message.data.role === "assistant");
      if (existing && existing.data.content !== content) throw new Error("This turn already has a different persisted narrative.");
      const assistantRecord = existing || await appendMessage({
          sequence: active.messages.length,
          turn: run.turn,
          role: "assistant",
          kind: "message",
          content,
          createdAt: new Date().toISOString(),
          narrativeSource,
        });
      if (!assistantRecord) throw new Error("The narrative message could not be persisted.");
      rpRun.assistantContent = content;
      rpRun.assistantMessageId = assistantRecord.id;
      rpRun.agentSettled = true;
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
        const nodeWorkspace = workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
        await mkdir(nodeWorkspace, { recursive: true });
        await writeFile(resolve(nodeWorkspace, "recent-turns.md"), `# Recent complete turns\n\n${recentCompletedTurnContext(active, run.turn, node.metadata.includeRecentTurns)}\n`, "utf8");
        documents["recent-turns"] = "recent-turns.md";
      }
      return { output: await task.invokeWorkflow({
        workflow: node.target,
        text: typeof node.metadata?.text === "string" ? node.metadata.text : run.payload?.currentInput || "",
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
      const parentWorkspace = workflowNodeWorkspace(active.sessionDirectory, parentWorkflowId, parentRunId, parentNodeId);
      const outputs: Record<string, string> = {};
      for (const [exportId, source] of Object.entries(node.exports) as any[]) {
        const requested = outputPaths[exportId];
        if (typeof requested !== "string" || !requested) throw new Error(`Caller did not provide outputPaths.${exportId}.`);
        const destination = resolve(parentWorkspace, requested);
        const destinationRelative = relative(parentWorkspace, destination);
        if (!destinationRelative || destinationRelative.startsWith("..") || destinationRelative.includes(`..${sep}`)) throw new Error(`Output path for ${exportId} escapes the caller workspace.`);
        const sourceNode = workflow.nodes.find((candidate: any) => candidate.id === source.fromNode);
        const outputDefinition = source.output ? sourceNode?.outputs?.[source.output] : null;
        if (outputDefinition?.format === "document-set") {
          await copyDocumentSet(
            resolve(workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, sourceNode.id), outputDefinition.path),
            destination,
            `${workflow.id}/${exportId}`,
          );
          outputs[exportId] = destinationRelative.replaceAll("\\", "/");
          continue;
        }
        if (outputDefinition?.kind === "directory") {
          await copyWorkspaceEntry(
            resolve(workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, sourceNode.id), outputDefinition.path),
            destination,
            `${workflow.id}/${exportId}`,
          );
          outputs[exportId] = destinationRelative.replaceAll("\\", "/");
          continue;
        }
        const content = outputDefinition
          ? await readFile(resolve(workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, sourceNode.id), outputDefinition.path), "utf8")
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
        const nodeWorkspace = workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
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
        const preparedContext = rpRun?.workflowRunId === run.id ? await buildDynamicProcessorContext(active, rpRun) : "";
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
            recentCompletedTurnContext(active, run.turn, recentTurns) || "No earlier complete turns are in the configured window.",
            "",
          ].join("\n"), "utf8");
        }
        return { output: { prepared: true, upstreamContext: Boolean(preparedContext.trim()) } };
      }
      if (!node.metadata?.entryFile) return { output: { acknowledged: true } };
      const entryPath = resolve(active.cardDirectory, node.metadata.entryFile);
      if (relative(active.cardDirectory, entryPath).startsWith("..")) {
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
      const nodeWorkspace = workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
      await mkdir(nodeWorkspace, { recursive: true });
      const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
      const accessFor = (moduleId: string, collectionId: string) => {
        const access = node.moduleAccess?.find((item: any) => item.moduleId === moduleId && item.collectionId === collectionId);
        if (!access) throw new Error(`Code node ${node.id} has no access to ${moduleId}/${collectionId}.`);
        return access;
      };
      const data = Object.freeze({
        receipt: (batchId: string) => readDataReceipt(active.sessionDirectory, batchId),
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
        getCurrent: (request: any) => {
          const access = accessFor(request.moduleId, request.collectionId);
          return getDataRecord(store, request, { capabilities: access.capabilities, views: access.views });
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
              messages: active.messages,
              visibleThroughTurn: run.visibleThroughTurn ?? run.turn,
              fallback: { turn: run.turn || 0, messageId: node.metadata?.unboundData === true ? null : rpRun?.assistantMessageId || null },
            }),
            sourceReferences: resolveCodeSubmissionSourceReferences(options.sourceMessageIds, {
              messages: active.messages,
              visibleThroughTurn: run.visibleThroughTurn ?? run.turn,
              fallback: run.sourceReferences || [],
              expectedRevisions: options.sourceMessageRevisions ?? null,
            }),
          },
        })),
      });
      const services: Record<string, any> = { comfy: active.comfyUi };
      if (node.runtimeServices?.includes("random")) {
        services.random = createRpRandomService({
          sessionDirectory: active.sessionDirectory,
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
        card: { id: active.cardId, name: active.cardName },
        featureModules: active.featureModules.map(item => item.id),
        module: workflow.ownerModuleId ? (() => {
          const owner = active.featureModules.find(item => item.id === workflow.ownerModuleId);
          if (!owner) throw new Error(`Workflow owner module ${workflow.ownerModuleId} is not loaded.`);
          return Object.freeze({ id: owner.id, moduleKind: owner.moduleKind, directory: owner.moduleDirectory, resourceCatalog: structuredClone(owner.resourceCatalog) });
        })() : null,
        conversation: {
          messages: structuredClone(active.messages.filter(message => message.binding.turn <= (run.visibleThroughTurn ?? run.turn ?? active!.turn))),
          player: { name: active.playerName, description: active.playerDescription },
          fixedContext: active.stableCardContext,
          primaryCharacters: "",
        },
        workspace: nodeWorkspace,
        data,
        calls: Object.freeze({ invoke: (request: any) => task.invokeWorkflow(request) }),
        services: Object.freeze(services),
      }));
      return { output, route: resolveCodeNodeRoute(node, output), assistantMessageId: rpRun?.assistantMessageId || null };
    }

    const { profile, model } = await resolveConfiguredModel(active, binding.modelId, task.teamMember ? task.model : null);
    if (!model) throw new Error("No model is available for this workflow node.");
    const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(active.sessionDirectory, workflow.id, run.id, workflow.kind));
    const nodeWorkspace = node.metadata?.teamMemberWorkspace
      ? resolve(node.metadata.teamMemberWorkspace)
      : workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
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
      const processorPath = resolve(active.cardDirectory, "runtime", "workflow-context", `${node.context.processor}.mjs`);
      const loaded: any = await import(`${pathToFileURL(processorPath).href}?run=${Date.now()}-${randomUUID()}`);
      const buildContext = loaded.buildContext || loaded.default;
      if (typeof buildContext !== "function") throw new Error(`${processorPath} must export buildContext().`);
      const result = await buildContext(Object.freeze({
        card: Object.freeze({ id: active.cardId, name: active.cardName }),
        player: Object.freeze({ name: active.playerName, description: active.playerDescription }),
        openingId: active.openingId,
        turn: run.turn,
        payload: structuredClone(run.payload),
        messages: structuredClone(active.messages.filter(message => message.binding.turn <= (run.visibleThroughTurn ?? run.turn ?? active!.turn))),
        upstream: structuredClone(upstream),
      }));
      if (typeof result !== "string") throw new Error(`Workflow context processor ${node.context.processor} must return a string.`);
      customContext = result;
    }
    const prompt = composeNodePrompt({
      piSystemPrompt: active.context.getSystemPrompt(),
      modelHead: profile?.headPrompt,
      agentPrompt: agent?.prompt,
      fixedContext: node.metadata?.fixedContext === "none" ? "" : await fixedRpContext(active),
      dynamicContext: composeWorkflowNodeDynamicContext({
        workflowKind: workflow.kind,
        turn: run.turn,
        recentCompleteTurns: workflow.turnContext?.recentCompleteTurns,
        recentContext: workflow.kind === "foreground" && node.metadata?.documentWorkspace !== true && Number.isSafeInteger(run.turn) ? recentCompletedTurnContext(active, run.turn, workflow.turnContext.recentCompleteTurns) : "",
        callContext: run.callContext,
        documentWorkspace: node.metadata?.documentWorkspace === true,
        handoffMirrorRoots,
        customContext,
      }),
      upstreamArtifacts: node.metadata?.documentWorkspace === true
        ? ""
        : upstream.length || upstreamArtifactContent.length ? `Upstream node outputs and declared artifacts:\n${JSON.stringify({ outputs: upstream, artifacts: upstreamArtifactContent }, null, 2)}` : "",
      currentInput: typeof run.payload?.currentInput === "string"
        ? run.payload.currentInput
        : typeof run.textInput === "string" ? run.textInput : "",
      nodePrompt: node.prompt || node.description,
    });
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const dataStore = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
    let teamControl: any = null;
    const nodeToolFactory = {
      name: "rp-node-tools",
      hidden: true,
      factory(workerPi: any) {
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
          sessionDirectory: active.sessionDirectory!,
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
          const target = active.featureModules.find(module => module.id === moduleId)?.workflows.find(candidate => canonicalWorkflowRef(candidate) === callBinding.target);
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
            text: Type.Optional(Type.String()),
            arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
            documents: Type.Optional(Type.Record(Type.String(), Type.String())),
            outputPaths: Type.Record(Type.String(), Type.String()),
          }),
          async execute(_id: string, parameters: any) {
            const request = structuredClone(parameters);
            const callBinding = node.workflowCalls.find((item: any) => item.target === request.workflow);
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
            for (const [id, path] of Object.entries(result.outputs || {})) {
              if (typeof path !== "string") continue;
              dynamicCallOutputs.push({ id: `call.${request.workflow}.${id}`, path, readPolicy: "conditional", authority: "canonical", appliesAt: "planning-and-writing", perspective: "general", priority: 0, description: `Declared output ${id} from ${request.workflow}.` });
            }
            return { content: [{ type: "text", text: JSON.stringify(result.outputs, null, 2) }], details: result };
          },
        });
        }
        }
        if (node.moduleAccess?.length && agent?.tools?.includes("rp_data_query")) {
        workerPi.registerTool({
          name: "rp_data_query",
          label: "Query RP data",
          description: "Query authorized indexed RP data with a named return view.",
          parameters: Type.Any(),
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
          parameters: Type.Any(),
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
            const receipt = rememberDataReceipt(run, node.id, await executeDataBatch(dataStore, batch, { access: node.moduleAccess, allowBestEffort: node.dataCommit?.allowBestEffort === true, context: { initiatorKind: node.type === "code" ? "code" : "agent", initiatorId: agent?.id || node.id, workflowId: workflow.id, workflowRunId: run.id, nodeId: node.id, binding: { turn: run.turn || 0, messageId: rpRun?.assistantMessageId || null }, sourceReferences: run.sourceReferences || [] } }));
            return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };
          },
        });
        }
      },
    };
    const loader = new sdk.DefaultResourceLoader({
      cwd: nodeWorkspace,
      agentDir: sdk.getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: prompt.systemPrompt,
      extensionFactories: [nodeToolFactory, ...(profile?.tailPrompt ? [{
        name: "rp-model-tail",
        hidden: true,
        factory(workerPi: any) {
          workerPi.on("context", (event: any) => ({
            messages: moveModelTailToEnd(event.messages, profile.tailPrompt),
          }));
        },
      }] : [])],
    });
    await loader.reload();
    const permittedBuiltins = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);
    const permittedDataTools = new Set(["rp_data_query", "rp_data_get", "rp_data_resolve", "rp_data_submit"]);
    const permittedRuntimeTools = new Set(["rp_roll"]);
    const tools = node.metadata?.teamMember === true
      ? ["rp_team_read", ...(task.teamMember?.member?.role === "leader" && task.teamMember?.phase === "discussion" ? ["rp_team_control"] : [])]
      : (agent?.tools || []).filter((name: string) => permittedBuiltins.has(name) || permittedRuntimeTools.has(name) || (node.moduleAccess?.length && permittedDataTools.has(name)));
    const hasResolvedWorkflowCall = node.workflowCalls?.some((binding: any) => {
      const [moduleId] = binding.target.split("/");
      return active.featureModules.find(module => module.id === moduleId)?.workflows.some(candidate => canonicalWorkflowRef(candidate) === binding.target);
    });
    if (hasResolvedWorkflowCall) tools.push("rp_call");
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
    const { session } = await sdk.createAgentSession({
      cwd: nodeWorkspace,
      modelRuntime: (active.context.modelRegistry as any).runtime,
      model,
      ...(profile?.thinking && profile.thinking !== "off" ? { thinkingLevel: profile.thinking } : {}),
      ...(tools.length ? { tools } : { noTools: "all" }),
      resourceLoader: loader,
      sessionManager,
    });
    const usageMessageStart = session.messages.length;
    const teamSessionCheckpoint = teamSessionDirectory ? checkpointTeamSessionAttempt(sessionManager) : null;
    try {
      const userPrompt = prompt.contextMessages.join("\n\n") || "Execute this workflow node and return its result.";
      // From here on a failure may be the model's, so the runtime must stop calling it deterministic.
      task.markModelDispatched?.();
      await session.prompt(userPrompt, { expandPromptTemplates: false, source: "extension" });
      if (teamSessionPointer) {
        const persistedSession = session.sessionFile || session.sessionManager?.getSessionFile?.() || null;
        if (persistedSession) await writeFile(teamSessionPointer, `${persistedSession}\n`, "utf8");
      }
      const assistant = [...session.messages].reverse().find((message: any) => message.role === "assistant");
      const content = messageText(assistant);
      if (!content) throw new Error("Workflow agent returned no text output.");
      if (node.metadata?.teamMember === true && typeof task.teamMember?.validateOutput === "function") {
        try { task.teamMember.validateOutput(content); }
        catch (error) {
          const rejected = error instanceof Error ? error : new Error(String(error));
          (rejected as any).rejectedContent = content;
          throw rejected;
        }
      }
      let output: any = content;
      if (agent?.outputMode === "json") {
        const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        try { output = JSON.parse(normalized); }
        catch { throw new Error(`Workflow Agent ${agent.id} must return valid JSON.`); }
      }
      for (const definition of Object.values(node.outputs || {}) as any[]) {
        if (definition.format !== "narrative") continue;
        const outputPath = resolve(nodeWorkspace, definition.path);
        const outputRelative = relative(nodeWorkspace, outputPath);
        if (!outputRelative || outputRelative.startsWith("..") || outputRelative.includes(`..${sep}`)) throw new Error(`Narrative output path for node ${node.id} escapes its workspace.`);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, content, "utf8");
      }
      if (node.metadata?.textOutput) {
        const definition = node.outputs?.[node.metadata.textOutput];
        const outputPath = resolve(nodeWorkspace, definition.path);
        const outputRelative = relative(nodeWorkspace, outputPath);
        if (!outputRelative || outputRelative.startsWith("..") || outputRelative.includes(`..${sep}`)) throw new Error(`Text output path for node ${node.id} escapes its workspace.`);
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, `${content.trim()}\n`, "utf8");
      }
      const snapshotDeclaration = node.metadata?.documentWorkspaceSnapshot;
      if (snapshotDeclaration) {
        const definition = node.outputs?.[snapshotDeclaration.output];
        if (!definition || definition.format !== "document-workspace-snapshot" || definition.kind !== "directory") throw new Error(`Node ${node.id} documentWorkspaceSnapshot must reference a declared directory output with format document-workspace-snapshot.`);
        await createDocumentWorkspaceSnapshot({
          nodeWorkspace,
          outputPath: definition.path,
          documents: workspaceDocuments,
          dynamicOutputs: dynamicCallOutputs,
          currentInput: typeof run.payload?.currentInput === "string" ? run.payload.currentInput : "",
          narrative: content,
          turnContext: workflow.turnContext,
        });
      }
      return {
        output,
        ...(node.metadata?.teamMember === true ? { content, control: teamControl } : {}),
        assistantMessageId: rpRun?.assistantMessageId || null,
        usage: tokenUsageFromMessages(session.messages.slice(usageMessageStart)),
        processRecord: lastAgentExchange(session.messages),
        context: {
          mode: node.context.mode,
          nodePrompt: node.prompt || node.description || null,
          customContext: customContext || null,
        },
      };
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
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
  }

  async function startBridge(cardArgument: string, context: ExtensionContext) {
    await stopBridge();
    const cardDirectory = resolveCardDirectory(context.cwd, cardArgument.trim());
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
    const commonSettingsDirectory = resolve(context.cwd, "settings");
    const commonSettingsPath = resolve(commonSettingsDirectory, "common.json");
    const avatarsDirectory = resolve(commonSettingsDirectory, "avatars");
    const cardSettingsPath = resolve(cardDirectory, "settings.json");
    const configProfiles = createConfigProfileStore({
      rootDirectory: context.cwd,
      directory: resolve(cardDirectory, "config-profiles"),
      scope: "card",
      ownerId: manifest.id,
    });
    await configProfiles.ensure();
    const configStore = createRpConfigStore(context.cwd, cardDirectory, { profileStore: configProfiles });
    const configToken = randomBytes(24).toString("base64url");
    await Promise.all([
      mkdir(commonSettingsDirectory, { recursive: true }),
      mkdir(avatarsDirectory, { recursive: true }),
      configStore.ensure(),
    ]);
    const globalCommonSettings = normalizeCommonSettings(await readOrCreateJson<CommonSettings>(commonSettingsPath, defaultCommonSettings));
    await writeFile(commonSettingsPath, `${JSON.stringify(globalCommonSettings, null, 2)}\n`, "utf8");
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
    const featureModules = applyModuleProfile(await readFeatureModules(cardDirectory, manifest.feature_modules), await configProfiles.getActive());
    const comfyUi = createComfyUiService({ rootDirectory: context.cwd, cardDirectory, featureModules });
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

    active = {
      cardDirectory,
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
    await hydrateNodeCompletionTurns(active.sessionDirectory);
    const dispatchWorkflowEvent = async (event: any, parentRun: any) => {
      if (!active?.recordId || !active.sessionDirectory) return;
      const available = await configStore.listWorkflows();
      for (const candidate of available) {
        if (candidate.invalid || candidate.source !== "card" || candidate.kind === "foreground") continue;
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
            const absolute = resolve(workflowNodeWorkspace(active.sessionDirectory, sourceWorkflow.id, parentRun.id, sourceNode.id), output.path);
            await readFile(resolve(absolute, output.kind === "directory" ? "DOCUMENTS.md" : ""), output.kind === "directory" ? "utf8" : undefined as any);
            triggerDocuments[inputId] = {
              path: relative(active.sessionDirectory, absolute).replaceAll("\\", "/"),
              format: output.format,
              kind: output.kind,
              narrativeSource: state.narrativeSource,
              sourceReferences: parentRun.sourceReferences || [],
              sourceArtifact: { workflowId: sourceWorkflow.id, workflowRunId: parentRun.id, nodeId: sourceNode.id, id: mapping.output, turn: parentRun.turn },
            };
          }
        }
        const visibleMessages = active.messages.filter(message => message.binding.turn <= parentRun.turn);
        const runId = `workflow-${randomUUID()}`;
        try {
          const frozenTriggerDocuments = await freezeTriggeredDocuments({ sessionDirectory: active.sessionDirectory, workflow: candidate, runId, triggerDocuments });
          await active.workflowEngine.start(candidate, {
            id: runId,
            cardId: active.cardId,
            chatId: active.recordId,
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
          await cleanupFrozenTriggerInputs(active.sessionDirectory, candidate.id, runId).catch(() => {});
          context.ui.notify(`Background workflow ${candidate.id} was not started: ${(error as Error).message}`, "warning");
        }
      }
    };

    active.workflowEngine = new RpWorkflowEngine({
      policy: await configStore.getRuntimePolicy(),
      resolveAgent: async (agentId: string | null) => agentId ? (await configStore.getAgent(agentId)).effective : null,
      resolveModel: async (modelId: string) => {
        if (modelId === "pi:current") {
          const current = active?.context.model;
          return current ? { id: "pi:current", provider: current.provider, model: current.id, maxConcurrency: 10 } : null;
        }
        return (await configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === modelId) || null;
      },
      resolveWorkflow: async (reference: string) => {
        for (const module of active?.featureModules || []) {
          const workflow = module.workflows.find(candidate => canonicalWorkflowRef(candidate) === reference);
          if (workflow) return workflow;
        }
        return null;
      },
      onRunStart: async ({ run }: any) => {
        if (run.dataReadViewId) return null;
        if (!active?.sessionDirectory || active.recordId !== run.chatId) throw new Error("The workflow data read view has no active RP chat.");
        const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
        const view = await createDataReadView({
          sessionDirectory: active.sessionDirectory,
          store,
          sourceId: run.callContext?.rootRunId || run.id,
          visibleThroughTurn: run.visibleThroughTurn,
          visibleThroughTime: run.readSnapshotAt,
        });
        return { dataReadViewId: view.viewId, dataReadBatchIds: run.dataReadBatchIds || [] };
      },
      executor: executeWorkflowNode,
      beforeNodeComplete: async ({ workflow, run, node, result }: any) => {
        if (!active?.sessionDirectory || active.recordId !== run.chatId) throw new Error("The workflow data commit has no active RP chat.");
        const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
        const finalized = await finalizeNodeData({ sessionDirectory: active.sessionDirectory, store, workflow, run, node, result });
        for (const receipt of finalized.dataReceipts || []) rememberDataReceipt(run, node.id, receipt);
        return finalized;
      },
      onRunTerminal: async ({ run }: any) => {
        if (!run.callContext && run.dataReadViewId && active?.sessionDirectory && active.recordId === run.chatId) {
          await deleteDataReadView({ sessionDirectory: active.sessionDirectory, viewId: run.dataReadViewId });
        }
      },
      nodeHistory: (workflowId: string, nodeId: string) => nodeCompletionTurns.get(`${workflowId}:${nodeId}`) ?? null,
      onNodeComplete: async ({ workflow, run, node, agent, binding, result }: any) => {
        if (!active?.sessionDirectory || active.recordId !== run.chatId) throw new Error("The workflow process record has no active RP chat.");
        const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(active.sessionDirectory, workflow.id, run.id, workflow.kind));
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
          path: relative(active.context.cwd, documentPath).replaceAll("\\", "/"),
        };
      },
      onChange: async (run: any, workflow: any) => {
        if (!active?.sessionDirectory || active.recordId !== run.chatId) return;
        const terminal = ["completed", "skipped", "failed", "cancelled"].includes(run.status);
        return withTerminalForegroundRelease(run, workflow, async () => {
          const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(active.sessionDirectory, workflow.id, run.id, workflow.kind));
          await serializeWorkflowWrite(() => appendWorkflowRunRecord(paths.workflowRuns, run));
          if (terminal) {
            await cleanupArtifacts(active.sessionDirectory, { type: "run", workflowRunId: run.id });
            await cleanupFrozenTriggerInputs(active.sessionDirectory, workflow.id, run.id);
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
          if (rpRun?.workflowRunId === run.id) {
            if (run.status === "completed" && rpRun.agentSettled) {
              rpRun.workflowCompleted = true;
              releaseCompletedRpTurn(run.id);
            } else {
              releaseRpTurn("failed", describeTurnFailure(run, rpRun.agentSettled));
            }
          }
        });
      },
    });

    const restoreWorkflowRuns = async (sessionDirectory: string | null) => {
      if (!sessionDirectory) return;
      const persisted = await readFile(resolve(sessionDirectory, "workflow", "runs.jsonl"), "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      const latest = new Map<string, any>();
      for (const run of persisted) latest.set(run.id, run);
      for (const run of latest.values()) {
        if (["completed", "skipped", "failed", "cancelled"].includes(run.status)) continue;
        try {
          const workflow = run.ownerModuleId
            ? active.featureModules.find(module => module.id === run.ownerModuleId)?.workflows.find(candidate => candidate.id === run.workflowId)
            : await configStore.getWorkflow(run.workflowId);
          if (!workflow) throw new Error(`Workflow definition was not found for ${run.ownerModuleId ? `${run.ownerModuleId}/` : ""}${run.workflowId}.`);
          for (const state of Object.values(run.nodes || {}) as any[]) {
            if (state.status === "completed") deliveredWorkflowEvents.add(`${run.id}:node:${state.id}:completed`);
          }
          if (workflow.kind === "foreground" && !rpRun && typeof run.payload?.currentInput === "string") {
            const finalizer = workflow.nodes.find((node: any) => node.type === "turn-finalize");
            const existingAssistant = active.messages.find(message => message.binding.turn === run.turn && message.data.role === "assistant");
            active.pending = true;
            rpRun = {
              cardId: active.cardId,
              recordId: active.recordId!,
              submittedText: run.payload.currentInput,
              submittedSequence: Number.isSafeInteger(run.payload.userSequence) ? run.payload.userSequence : active.messages.at(-1)?.sequence || 0,
              assistantContent: "",
              automaticSelections: {}, agentQueries: [], agentSources: [], processorSelections: [],
              contextContent: null, phase: "narrative", assistantMessageId: existingAssistant?.id || null,
              workflowRunId: run.id, workflowNarrativeNodeId: finalizer?.narrative?.fromNode || null,
              resolveNarrative: null, rejectNarrative: null,
              baseModel: active.context.model,
              agentSettled: Boolean(existingAssistant),
            };
          }
          await active.workflowEngine.restore(workflow, run);
        } catch (error) {
          context.ui.notify(`Workflow run ${run.id} could not be restored: ${(error as Error).message}`, "warning");
        }
      }
    };
    await restoreWorkflowRuns(active.sessionDirectory);

    function requireFrontendModule(moduleId: string) {
      const module = active?.featureModules.find(item => item.id === moduleId && item.surface === "frontend");
      if (!module) throw httpError(404, `Frontend feature module ${moduleId} was not found.`);
      return module;
    }
    function activeDataStore() {
      if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before using module data.");
      return new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
    }
    async function startManualBackgroundWorkflow(workflowId: string, payload: any) {
      if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "Start or resume a chat before running a background workflow.");
      const workflow = await configStore.copyWorkflowToCard(workflowId);
      if (workflow.kind === "foreground" || workflow.kind.startsWith("module-")) throw httpError(400, "Manual controls may activate only top-level background workflows.");
      const completedThrough = latestCompletedTurn(active);
      const visibleMessages = active.messages.filter(message => message.binding.turn <= (workflow.kind === "global-background" ? completedThrough : active!.turn));
      const run = await active.workflowEngine.start(workflow, {
        cardId: active.cardId,
        chatId: active.recordId,
        turn: workflow.kind === "global-background" ? completedThrough : active.turn,
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
        bridge: {
          getState: async () => webSnapshot(),
          getSettings: async () => ({
            common: active?.commonSettings || defaultCommonSettings,
            card: active?.cardSettings || { schemaVersion: 1, cardId: manifest.id, settings: {} },
          }),
          getConfigContext: async () => ({ mode: "play", scope: "card", ownerId: manifest.id, token: active?.configToken || configToken }),
          authorizeConfigMutation: async (value: unknown) => {
            if (value !== (active?.configToken || configToken)) throw httpError(403, "Configuration session token is invalid.");
            return true;
          },
          getConfigCatalog: async () => activeConfigCatalog(active!),
          listConfigProfiles: async () => configProfiles.list(),
          getConfigProfile: async (profileId: string) => profileId === "builtin" ? {
            schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "builtin", name: "内置默认", builtin: true,
            models: await configStore.listModels(), agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {},
            compatibility: { moduleProtocol: 6, workflowProtocol: 3 },
          } : configProfiles.get(profileId),
          createConfigProfile: async (value: any) => {
            const seed = value.seedFromId === "builtin" ? {
              schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "builtin", name: "内置默认",
              models: await configStore.listModels(), agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {},
              compatibility: { moduleProtocol: 6, workflowProtocol: 3 },
            } : value.seedFromId ? await configProfiles.exportProfile(value.seedFromId) : null;
            return configProfiles.create({ id: value.id, name: value.name, description: value.description, seed });
          },
          saveConfigProfile: async (value: any) => {
            const saved = await configProfiles.save(value);
            const listing = await configProfiles.list();
            if (active && listing.activeProfileId === saved.id) {
              active.featureModules = applyModuleProfile(await readFeatureModules(cardDirectory, manifest.feature_modules), await configProfiles.getActive());
              active.workflowEngine.policy = await configStore.getRuntimePolicy();
            }
            return saved;
          },
          renameConfigProfile: async (profileId: string, value: any) => configProfiles.rename(profileId, value.name),
          duplicateConfigProfile: async (profileId: string, value: any) => configProfiles.duplicate(profileId, value),
          deleteConfigProfile: async (profileId: string) => configProfiles.remove(profileId),
          importConfigProfile: async (value: any) => configProfiles.importProfile(value.profile, { id: value.id, name: value.name }),
          exportConfigProfile: async (profileId: string) => configProfiles.exportProfile(profileId),
          saveConfigModelSecret: async (profileId: string, modelId: string, value: any) => configProfiles.saveModelSecret(profileId, modelId, value.apiKey || ""),
          activateConfigProfile: async (profileId: string) => {
            const result = await configProfiles.activate(profileId);
            if (active) {
              active.featureModules = applyModuleProfile(await readFeatureModules(cardDirectory, manifest.feature_modules), await configProfiles.getActive());
              active.workflowEngine.policy = await configStore.getRuntimePolicy();
            }
            return { ...result, appliesToExistingModuleData: false, workflowInstancesKeepStartSnapshot: true };
          },
          listModels: async () => ({
            profiles: await configStore.listModels(),
            current: context.model ? {
              id: "pi:current",
              name: `当前 Pi 模型 · ${context.model.provider}/${context.model.id}`,
              provider: context.model.provider,
              model: context.model.id,
              virtual: true,
            } : { id: "pi:current", name: "当前 Pi 模型", virtual: true },
          }),
          saveModel: async (value: any) => {
            const saved = await configStore.saveModel(value);
            await resolveConfiguredModel(active!, saved.id);
            return saved;
          },
          deleteModel: async (modelId: string) => {
            await configStore.removeModel(modelId);
            pi.unregisterProvider(`rp-${modelId}`);
            return { deleted: modelId };
          },
          discoverModels: async (value: any) => {
            const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/$/, "") : "";
            if (!baseUrl) throw httpError(400, "baseUrl is required.");
            const headers: Record<string, string> = { accept: "application/json" };
            if (typeof value.apiKey === "string" && value.apiKey.trim()) {
              if (value.api === "anthropic-messages") {
                headers["x-api-key"] = value.apiKey.trim();
                headers["anthropic-version"] = "2023-06-01";
              } else headers.authorization = `Bearer ${value.apiKey.trim()}`;
            }
            const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw httpError(400, `Model list request failed: HTTP ${response.status}`);
            const payload: any = await response.json();
            const models = (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
              .map((item: any) => typeof item === "string" ? item : item?.id)
              .filter((id: unknown): id is string => typeof id === "string" && id.trim())
              .sort();
            return { models };
          },
          testModel: async (value: any) => {
            const modelId = typeof value.modelId === "string" ? value.modelId : "";
            const { profile, model } = await resolveConfiguredModel(active!, modelId);
            if (!model) throw httpError(400, "The selected model is unavailable.");
            const startedAt = Date.now();
            const response: any = await context.modelRegistry.complete(model, {
              systemPrompt: "This is an API connectivity smoke test. Reply briefly.",
              messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
            }, { maxTokens: Math.min(profile?.maxOutputTokens || 64, 64) } as any);
            if (response.stopReason === "error") throw httpError(400, response.errorMessage || "Model test failed.");
            return { ok: true, elapsedMs: Date.now() - startedAt, reply: messageText(response), provider: response.provider, model: response.model };
          },
          listAgents: async () => ({ agents: await configStore.listAgents() }),
          saveAgent: async (value: any, scope: "card" | "global") => configStore.saveAgent(value, { scope }),
          restoreAgent: async (agentId: string) => configStore.restoreAgent(agentId),
          listWorkflows: async () => {
            const topLevel = (await configStore.listWorkflows()).map((workflow: any) => ({ ...workflow, reference: workflow.id }));
            const moduleWorkflows = (active?.featureModules || []).flatMap(module => module.workflows.map((workflow: any) => ({
              ...workflow,
              source: "module",
              moduleTitle: module.title,
              reference: `${module.id}/${workflow.id}`,
            })));
            return { activeWorkflowId: active?.activeWorkflowId || "standard-rp", workflows: [...topLevel, ...moduleWorkflows] };
          },
          listWorkflowRuns: async () => {
            if (!active?.sessionDirectory) return { runs: [] };
            const persisted = await readFile(resolve(active.sessionDirectory, "workflow", "runs.jsonl"), "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            });
            const latest = new Map<string, any>();
            for (const run of persisted) latest.set(run.id, { ...run, live: false });
            const blockingRunIds = new Set(active.workflowEngine.blockingTurnRuns().map((item: any) => item.runId));
            for (const run of active.workflowEngine.snapshot()) latest.set(run.id, { ...run, live: true, blocksNextTurn: blockingRunIds.has(run.id) });
            const runs = await Promise.all([...latest.values()].map(async run => {
              const enriched = structuredClone(run);
              for (const node of Object.values(enriched.nodes || {}) as any[]) {
                const teamStatePath = resolve(workflowNodeWorkspace(active!.sessionDirectory!, run.workflowId, run.id, node.id), "team", "state.json");
                const teamState = await readFile(teamStatePath, "utf8").then(JSON.parse).catch(error => {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                  throw error;
                });
                if (!teamState) continue;
                node.team = {
                  status: teamState.status,
                  phase: teamState.phase,
                  round: teamState.round,
                  speechCount: teamState.speechSeq || 0,
                  taskCounts: Object.values(teamState.tasks || {}).reduce((counts: any, task: any) => ({ ...counts, [task.status]: (counts[task.status] || 0) + 1 }), {}),
                  budgets: teamState.budgets || {},
                  usage: teamState.usage || null,
                  error: teamState.error || null,
                  failedMember: teamState.lastMemberFailure || null,
                  transcriptAvailable: true,
                };
              }
              return enriched;
            }));
            return { runs: runs.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))) };
          },
          openWorkflowTeamTranscript: async (runId: string, nodeId: string) => {
            if (!active?.sessionDirectory) throw httpError(409, "Select an opening or saved chat before opening a team transcript.");
            const live = active.workflowEngine.snapshot().find((item: any) => item.id === runId);
            const persistedRun = live ? null : await readFile(resolve(active.sessionDirectory, "workflow", "runs.jsonl"), "utf8")
              .then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse().find(item => item.id === runId))
              .catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
              });
            const run = live || persistedRun;
            if (!run?.nodes?.[nodeId]) throw httpError(404, "Team workflow node was not found.");
            const transcriptPath = resolve(workflowNodeWorkspace(active.sessionDirectory, run.workflowId, runId, nodeId), "team", "shared", "TRANSCRIPT.md");
            await readFile(transcriptPath, "utf8").catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Team transcript was not found.");
              throw error;
            });
            try { await openLocalDocument(transcriptPath); }
            catch (error) { throw httpError(500, `Could not open the team transcript: ${(error as Error).message}`); }
            return { opened: true, path: relative(active.context.cwd, transcriptPath).replaceAll("\\", "/") };
          },
          openWorkflowNodeProcessRecord: async (runId: string, nodeId: string) => {
            if (!active?.sessionDirectory) throw httpError(409, "Select an opening or saved chat before opening a workflow process record.");
            const runs = active.workflowEngine.snapshot();
            const live = runs.find((run: any) => run.id === runId);
            const persisted = live ? null : await readFile(resolve(active.sessionDirectory, "workflow", "runs.jsonl"), "utf8")
              .then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).reverse().find(run => run.id === runId))
              .catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
              });
            const run = live || persisted;
            if (!run?.nodes?.[nodeId]?.processRecord?.available) throw httpError(404, "Workflow node process record was not found.");
            const documentPath = workflowProcessRecordPath(resolve(active.sessionDirectory, "workflow", "process-records"), runId, nodeId);
            await readFile(documentPath, "utf8");
            try {
              await openLocalDocument(documentPath);
            } catch (error) {
              throw httpError(500, `Could not open the workflow process record: ${(error as Error).message}`);
            }
            return { opened: true, path: relative(active.context.cwd, documentPath).replaceAll("\\", "/") };
          },
          getWorkflowPolicy: async () => configStore.getRuntimePolicy(),
          saveWorkflowPolicy: async (value: any) => {
            const policy = await configStore.saveRuntimePolicy(value);
            if (active) active.workflowEngine.policy = policy;
            return policy;
          },
          activateWorkflow: async (workflowId: string, value: any) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const workflow = await configStore.copyWorkflowToCard(workflowId);
            if (workflow.kind === "foreground") {
              active.activeWorkflowId = workflow.id;
              active.cardSettings.settings.activeWorkflowId = workflow.id;
              await writeFile(cardSettingsPath, `${JSON.stringify(active.cardSettings, null, 2)}\n`, "utf8");
              return { activated: workflow.id, startsOnNextInput: true };
            }
            return startManualBackgroundWorkflow(workflow.id, value?.payload || {});
          },
          updateWorkflowNodeBinding: async (workflowId: string, nodeId: string, value: any) => {
            const workflow = await configStore.copyWorkflowToCard(workflowId);
            const node = workflow.nodes.find((item: any) => item.id === nodeId);
            if (!node) throw httpError(404, "Workflow node was not found.");
            node.agentId = typeof value.agentId === "string" && value.agentId ? value.agentId : null;
            node.modelId = typeof value.modelId === "string" && value.modelId ? value.modelId : null;
            return configStore.saveCardWorkflow(workflow);
          },
          updateWorkflowTrigger: async (workflowId: string, value: any) => {
            const workflow = await configStore.copyWorkflowToCard(workflowId);
            if (workflow.kind === "foreground") throw httpError(400, "Foreground workflow triggers cannot be changed here.");
            const blocking = workflow.trigger?.blockNextTurnUntilReady === true ? { blockNextTurnUntilReady: true } : {};
            if (value?.type === "manual") workflow.trigger = { type: "manual", ...blocking };
            else if (value?.type === "after-opening") workflow.trigger = { type: "after-opening", ...blocking };
            else if (value?.type === "after-workflow") workflow.trigger = { type: "after-workflow", workflowId: String(value.workflowId || ""), ...blocking };
            else if (value?.type === "node") workflow.trigger = { type: "node", workflowId: String(value.workflowId || ""), nodeId: String(value.nodeId || ""), ...blocking };
            else throw httpError(400, "Unsupported workflow trigger type.");
            return configStore.saveCardWorkflow(workflow);
          },
          retryWorkflowNode: async (runId: string, nodeId: string, value: any) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const run = active.workflowEngine.snapshot().find((item: any) => item.id === runId);
            if (!run) throw httpError(404, "Workflow run was not found.");
            const workflow = await configStore.getWorkflow(run.workflowId);
            if (workflow.kind === "foreground" && ["completed", "skipped", "failed", "cancelled"].includes(run.status)) {
              throw httpError(409, "A terminal foreground turn cannot be retried in place. Fix the card or configuration, then submit a new player turn.");
            }
            const node = workflow.nodes.find((item: any) => item.id === nodeId);
            if (!node) throw httpError(404, "Workflow node was not found.");
            if (value.saveAsCardDefault === true) {
              const editableWorkflow = await configStore.copyWorkflowToCard(run.workflowId);
              const editableNode = editableWorkflow.nodes.find((item: any) => item.id === nodeId);
              if (!editableNode) throw httpError(404, "Workflow node was not found.");
              if (editableNode.type === "team" && typeof value.memberId === "string") {
                const members = [editableNode.team?.leader, editableNode.team?.secretary, ...(editableNode.team?.experts || [])];
                const member = value.memberId.startsWith("member:")
                  ? members.find((item: any) => item?.id === value.memberId.slice("member:".length))
                  : value.memberId.startsWith("assistant:")
                    ? (editableNode.team?.assistants || []).find((item: any) => item?.id === value.memberId.slice("assistant:".length))
                    : null;
                if (!member) throw httpError(400, "The failed team member could not be resolved in the card workflow.");
                member.modelId = value.modelId;
              } else editableNode.modelId = value.modelId;
              await configStore.saveCardWorkflow(editableWorkflow);
            }
            const retried = await active.workflowEngine.retry(runId, nodeId, value.modelId, { saveOverride: value.saveAsCardDefault === true, memberId: value.memberId || null });
            return retried;
          },
          recoverWorkflowNode: async (runId: string, nodeId: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            return active.workflowEngine.recover(runId, nodeId);
          },
          cancelWorkflowRun: async (runId: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const cancelled = await active.workflowEngine.cancel(runId);
            if (rpRun?.workflowRunId === runId) {
              if (!active.context.isIdle()) active.context.abort();
              active.pending = false;
              rpRun = null;
            }
            return cancelled;
          },
          skipWorkflowRun: async (runId: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const skipped = await active.workflowEngine.skip(runId);
            if (rpRun?.workflowRunId === runId) {
              if (!active.context.isIdle()) active.context.abort();
              active.pending = false;
              rpRun = null;
            }
            return skipped;
          },
          getImageGeneration: async () => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const profiles = (await active.comfyUi.profiles()).map((profile: any) => ({
              id: profile.id,
              title: profile.title,
              revision: profile.revision,
              guideId: profile.guideId,
              connectionId: profile.connectionId,
              digest: profile.digest,
              workflowDigest: profile.workflowDigest,
              prompt: profile.prompt,
              overrideStale: profile.overrideStale,
            }));
            const connections = await active.comfyUi.listConnections();
            if (!active.sessionDirectory) return { available: true, sessionId: null, profiles, connections, preferences: null, requests: [], renders: [] };
            await ensureFeatureModuleRecords(active);
            const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
            const module = active.featureModules.find(item => item.id === "comfy-image-generation");
            if (!module) return { available: false, sessionId: active.recordId, profiles: [], connections, preferences: null, requests: [], renders: [] };
            const [settings, requests, renders] = await Promise.all([
              store.readCollection(module.id, "settings"),
              store.readCollection(module.id, "requests"),
              store.readCollection(module.id, "renders"),
            ]);
            const requestSummaries = requests.records.map((record: any) => ({
              ...record,
              data: {
                ordinal: record.data.ordinal,
                sourceKind: record.data.sourceKind,
                triggerKind: record.data.triggerKind,
                promptState: record.data.promptState,
                selectedProfileIds: record.data.selectedProfileIds,
                dedupeKey: record.data.dedupeKey,
                createdAt: record.data.createdAt,
              },
            }));
            return { available: true, sessionId: active.recordId, profiles, connections, preferences: settings.records.find(item => item.id === "image-preferences") || null, requests: requestSummaries, renders: renders.records };
          },
          saveImagePreferences: async (value: any) => {
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before saving image preferences.");
            await ensureFeatureModuleRecords(active);
            const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
            const current = (await store.readCollection("comfy-image-generation", "settings")).records.find(item => item.id === "image-preferences");
            if (!current) throw httpError(404, "Image preferences record was not found.");
            const profiles = await active.comfyUi.profiles();
            const valid = new Set(profiles.map((item: any) => item.id));
            const selectedProfileIds = Array.isArray(value.selectedProfileIds) ? [...new Set(value.selectedProfileIds.filter((id: unknown) => typeof id === "string" && valid.has(id)))] : [];
            const inputPolicy = value.inputPolicy && typeof value.inputPolicy === "object" ? value.inputPolicy : current.data.inputPolicy;
            const next = { selectedProfileIds, quickMode: value.quickMode === true, inputPolicy };
            const batchId = `image-preferences-${Date.now()}-${randomUUID()}`;
            await executeDataBatchOrThrow(store, { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `update-${randomUUID()}`, moduleId: "comfy-image-generation", collectionId: "settings", recordType: "image.preferences", action: "update", targetId: current.id, expectedRevision: current.revision, data: next }] }, { access: [{ moduleId: "comfy-image-generation", collectionId: "settings", capabilities: ["image.preferences.configure"], views: ["maintenance"] }], context: { initiatorKind: "user", initiatorId: "web", binding: { turn: active.turn, messageId: null } } });
            return { saved: true, preferences: next };
          },
          startImageGeneration: async (value: any) => {
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "Start or resume a chat before generating an image.");
            const module = active.featureModules.find(item => item.id === "comfy-image-generation");
            if (!module) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const execution: any = await import(`${pathToFileURL(resolve(module.moduleDirectory, "runtime", "image-execution.mjs")).href}?web=${Date.now()}`);
            const operationId = typeof value.operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.operationId) ? value.operationId : randomUUID();
            const payload = execution.normalizeImageOperationIntent({ ...value, operationId });
            const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
            const existing = (await store.readCollection("comfy-image-generation", "requests")).records.find(item => item.id === `image-request-${operationId}`);
            if (existing) execution.assertImageOperationIntent(existing, payload, operationId);
            const workflow = await configStore.copyWorkflowToCard("agent-image-generation");
            const completedThrough = latestCompletedTurn(active);
            const run = await active.workflowEngine.start(workflow, { cardId: active.cardId, chatId: active.recordId, turn: completedThrough, visibleThroughTurn: completedThrough, trigger: { type: "manual" }, payload, reuseActive: true });
            return { accepted: true, runId: run.id };
          },
          recoverImageGeneration: async (requestId: string) => {
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "Start or resume a chat before recovering image generation.");
            const module = active.featureModules.find(item => item.id === "comfy-image-generation");
            if (!module) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
            const [requestState, renderState] = await Promise.all([store.readCollection("comfy-image-generation", "requests"), store.readCollection("comfy-image-generation", "renders")]);
            const request = requestState.records.find(item => item.id === requestId);
            if (!request) throw httpError(404, "Image request was not found.");
            const renders = renderState.records.filter(item => item.data.requestId === requestId && ["pending", "submitting", "submitted"].includes(item.data.state));
            if (!renders.length) return { accepted: false, requestId, reason: "no-recoverable-renders" };
            const operationId = request.data.dedupeKey;
            const activeRun = active.workflowEngine.snapshot().find((run: any) => run.payload?.operationId === operationId && run.status === "awaiting-recovery");
            if (activeRun) {
              const recovered = await active.workflowEngine.recover(activeRun.id);
              return { accepted: true, requestId, runId: recovered.id, mode: "workflow" };
            }
            const execution: any = await import(`${pathToFileURL(resolve(module.moduleDirectory, "runtime", "image-execution.mjs")).href}?recover=${Date.now()}`);
            const access = [
              { moduleId: "comfy-image-generation", collectionId: "requests", capabilities: ["image.requests.prepare"], views: ["maintenance"] },
              { moduleId: "comfy-image-generation", collectionId: "renders", capabilities: ["image.renders.execute"], views: ["maintenance"] },
            ];
            const constraints = (collectionId: string) => {
              const item = access.find(candidate => candidate.collectionId === collectionId)!;
              return { capabilities: item.capabilities, views: item.views, runtimeLimit: 1000, runtimeCharacters: 1000000, nodeLimit: 1000, nodeCharacters: 1000000 };
            };
            const data = {
              query: (query: any) => queryData(store, query, constraints(query.collectionId)),
              get: (query: any) => getDataRecord(store, query, constraints(query.collectionId)),
              submit: (draft: any) => executeDataBatchOrThrow(store, draft, { access, context: { initiatorKind: "user", initiatorId: "web", binding: { turn: active?.turn || 0, messageId: null } } }),
            };
            if (!comfyImageExecutions.has(requestId)) {
              const task = execution.executeImageOperation({ data, services: { comfy: active.comfyUi }, requestId, renders })
                .catch(console.error)
                .finally(() => comfyImageExecutions.delete(requestId));
              comfyImageExecutions.set(requestId, task);
            }
            return { accepted: true, requestId, mode: "render-recovery" };
          },
          saveComfyConnection: async (value: any) => active?.comfyUi.saveConnection(value),
          testComfyConnection: async (connectionId: string) => active?.comfyUi.testConnection(connectionId),
          saveComfyProfileOverride: async (profileId: string, value: any) => active?.comfyUi.saveProfileOverride(profileId, value.prompt || value),
          openComfyProfileDocument: async (profileId: string, target: unknown) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const profile = (await active.comfyUi.profiles([profileId]))[0];
            if (!profile) throw httpError(404, "ComfyUI profile was not found.");
            const paths: Record<string, string> = { profile: resolve(profile.directory, "profile.json"), workflow: resolve(profile.directory, "workflow.api.json"), guide: resolve(active.featureModules.find(item => item.id === "comfy-image-generation")!.moduleDirectory, "skill", "guides", profile.guideId, "SKILL.md") };
            if (typeof target !== "string" || !paths[target]) throw httpError(400, "Document target must be profile, workflow, or guide.");
            await readFile(paths[target], "utf8"); await openLocalDocument(paths[target]);
            return { opened: true, path: relative(active.context.cwd, paths[target]).replaceAll("\\", "/") };
          },
          getComfyRenderImage: async (renderId: string, outputIndex: number, preview: unknown) => {
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before viewing generated images.");
            const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
            const render = (await store.readCollection("comfy-image-generation", "renders")).records.find(item => item.id === renderId);
            if (!render) throw httpError(404, "Image render record was not found.");
            const output = render.data.outputs?.[outputIndex];
            if (!output) throw httpError(404, "Image output was not found.");
            const cleanPreview = typeof preview === "string" && /^(webp|jpeg);\d{1,3}$/.test(preview) ? preview : null;
            return active.comfyUi.view({ connectionId: render.data.connectionId, output, preview: cleanPreview });
          },
          regenerateComfyRender: async (renderId: string, contentPrompt: string, scope: "current" | "all", operationId: string) => {
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before regenerating images.");
            const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
            const [requestState, renderState] = await Promise.all([store.readCollection("comfy-image-generation", "requests"), store.readCollection("comfy-image-generation", "renders")]);
            const sourceRender = renderState.records.find(item => item.id === renderId);
            if (!sourceRender) throw httpError(404, "Image render record was not found.");
            const sourceRequest = requestState.records.find(item => item.id === sourceRender.data.requestId);
            if (!sourceRequest) throw httpError(404, "Source image request was not found.");
            const profileIds = scope === "all" ? sourceRequest.data.selectedProfileIds : [sourceRender.data.profileId];
            const profiles = await active.comfyUi.profiles(profileIds);
            if (!profiles.length) throw httpError(409, "The adapted profile is no longer available.");
            const ordinal = Math.max(0, ...requestState.records.map(item => Number(item.data.ordinal || 0))) + 1;
            const promptByGuide = new Map(sourceRequest.data.contentPrompts.map((item: any) => [item.guideId, item.content]));
            promptByGuide.set(sourceRender.data.guideId, contentPrompt);
            const module = active.featureModules.find(item => item.id === "comfy-image-generation");
            if (!module) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const execution: any = await import(`${pathToFileURL(resolve(module.moduleDirectory, "runtime", "image-execution.mjs")).href}?web=${Date.now()}`);
            const access = [
              { moduleId: "comfy-image-generation", collectionId: "requests", capabilities: ["image.requests.prepare"], views: ["maintenance"] },
              { moduleId: "comfy-image-generation", collectionId: "renders", capabilities: ["image.renders.execute"], views: ["maintenance"] },
            ];
            const constraints = (collectionId: string) => {
              const item = access.find(candidate => candidate.collectionId === collectionId)!;
              return { capabilities: item.capabilities, views: item.views, runtimeLimit: 1000, runtimeCharacters: 1000000, nodeLimit: 1000, nodeCharacters: 1000000 };
            };
            const data = {
              query: (request: any) => queryData(store, request, constraints(request.collectionId)),
              get: (request: any) => getDataRecord(store, request, constraints(request.collectionId)),
              submit: (draft: any) => executeDataBatchOrThrow(store, draft, { access, context: { initiatorKind: "user", initiatorId: "web", binding: { turn: active?.turn || 0, messageId: null } } }),
            };
            const editedContentPrompts = [...promptByGuide].map(([guideId, content]) => ({ guideId, content }));
            const derivedFrom = { sourceRequestId: sourceRequest.id, sourceRenderId: sourceRender.id, scope };
            const definition = execution.buildImageOperation({ operationId, ordinal, source: sourceRequest.data, profiles, contentPrompts: editedContentPrompts, chatFolder: sourceRender.data.chatFolder, services: { comfy: active.comfyUi }, derivedFrom, intent: { operationId, profileIds, inputPolicy: { kind: sourceRequest.data.sourceKind }, userDirection: sourceRequest.data.userDirection, derivedFrom, editedContentPrompts } });
            const ensured = await execution.ensureImageOperation({ data, definition });
            if (!comfyImageExecutions.has(definition.requestId)) {
              const task = execution.executeImageOperation({ data, services: { comfy: active.comfyUi }, requestId: definition.requestId, renders: ensured.renders })
                .catch(console.error)
                .finally(() => comfyImageExecutions.delete(definition.requestId));
              comfyImageExecutions.set(definition.requestId, task);
            }
            return { accepted: true, requestId: definition.requestId, renderIds: ensured.renders.map((item: any) => item.id) };
          },
          listFeatureModules: async () => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (active.recordId && active.sessionDirectory) await ensureFeatureModuleRecords(active);
            const modules = [];
            const frontendModules = active.featureModules
              .filter(module => module.surface === "frontend")
              .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
            for (const module of frontendModules) {
              let data = null;
              let available = false;
              let dataError = "";
              if (active.sessionDirectory) {
                try {
                  if (module.view.schemaVersion === 1) {
                    const store = activeDataStore();
                    const collections: Record<string, unknown> = {};
                    for (const collectionId of Object.keys(module.contract.collections)) collections[collectionId] = await store.readCollection(module.id, collectionId);
                    data = { collections };
                  }
                  available = true;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    dataError = "模块记录暂时无法解析；完成写入后页面会自动重试。";
                  }
                }
              }
              modules.push({
                id: module.id,
                title: module.title,
                description: module.description,
                displayOrder: module.displayOrder,
                available,
                error: dataError,
                view: module.view,
                data,
              });
            }
            return { sessionId: active.recordId, modules };
          },
          queryModuleFrontendRegion: async (moduleId: string, regionId: string, value: any) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId); if (!["record-browser", "story-browser"].includes(region.type)) throw new Error(`Frontend region ${regionId} is not a record or story browser.`); }
            catch (error) { throw httpError(400, (error as Error).message); }
            const where: Record<string, unknown> = {};
            for (const filter of region.filters || []) {
              let filterValue = value?.filters?.[filter.id];
              if (filterValue === undefined || filterValue === null || filterValue === "") continue;
              if (filter.control === "number") filterValue = Number(filterValue);
              if (filter.control === "boolean") filterValue = filterValue === true || filterValue === "true";
              if (filter.control === "select" && !filter.options.includes(String(filterValue))) throw httpError(400, `Filter ${filter.id} has an unsupported value.`);
              if (filter.control === "number" && !Number.isFinite(filterValue)) throw httpError(400, `Filter ${filter.id} must be numeric.`);
              where[filter.index] = { [filter.operator]: filterValue };
            }
            const search = typeof value?.search === "string" && value.search.trim() ? { query: value.search.trim().slice(0, 500) } : undefined;
            try {
              const view = region.type === "story-browser" ? region.indexView : region.view;
              const maxCharacters = region.type === "story-browser" ? region.indexMaxCharacters : region.maxCharacters;
              return await queryDataStable(activeDataStore(), { moduleId, collectionId: region.collectionId, recordTypes: region.recordTypes, where, search, view, includeInactive: region.includeInactive, cursor: value?.cursor || null, limit: region.pageSize, maxCharacters, order: region.type === "story-browser" ? "desc" : "asc" }, { capabilities: [region.readCapability], views: [view], runtimeLimit: region.pageSize, runtimeCharacters: maxCharacters });
            } catch (error) { throw httpError(400, (error as Error).message); }
          },
          getModuleFrontendStory: async (moduleId: string, regionId: string, recordId: string) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "story-browser"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            const record = await getDataRecord(activeDataStore(), { moduleId, collectionId: region.collectionId, id: recordId, view: region.fullView }, { capabilities: [region.readCapability], views: [region.fullView] });
            if (!record) throw httpError(404, `Story ${recordId} was not found.`);
            return record;
          },
          openModuleAuthoritySource: async (moduleId: string, regionId: string, recordId: string) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "story-browser"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            if (!region.allowOpenAuthoritySource) throw httpError(403, "This story browser does not expose its authority source.");
            const path = await activeDataStore().authorityFileForRecord(moduleId, region.collectionId, recordId);
            await openLocalDocument(path);
            return { opened: true, path: relative(active.context.cwd, path).replaceAll("\\", "/"), unsupportedDirectEdit: true };
          },
          getModuleFrontendHistory: async (moduleId: string, regionId: string, recordId: string, cursor: string | null) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "record-browser"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            return getDataRecordHistory(activeDataStore(), { moduleId, collectionId: region.collectionId, id: recordId, view: region.view, cursor, limit: 20 }, { capabilities: [region.readCapability], views: [region.view], runtimeLimit: 20 });
          },
          getModuleFrontendSettings: async (moduleId: string, regionId: string) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "settings-form"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            const store = activeDataStore();
            const state = await store.readCollection(moduleId, region.collectionId);
            const raw = state.records.find((item: any) => item.id === region.recordId && item.recordType === region.recordType);
            if (!raw) throw httpError(404, `Settings record ${region.recordId} was not found.`);
            const rendered = await getDataRecord(store, { moduleId, collectionId: region.collectionId, id: region.recordId, view: region.view }, { capabilities: [region.readCapability], views: [region.view] });
            return { record: rendered, values: Object.fromEntries(region.fields.map((field: any) => [field.path, dataValueAt(raw, `/data${field.path}`)])) };
          },
          updateModuleFrontendSettings: async (moduleId: string, regionId: string, value: any) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "settings-form"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            if (!Number.isSafeInteger(value?.expectedRevision) || value.expectedRevision < 1) throw httpError(400, "expectedRevision must be a positive integer.");
            const store = activeDataStore();
            const state = await store.readCollection(moduleId, region.collectionId);
            const current = state.records.find((item: any) => item.id === region.recordId && item.recordType === region.recordType);
            if (!current) throw httpError(404, `Settings record ${region.recordId} was not found.`);
            let next;
            try { next = applyFrontendSettingsValues(region, current.data, value.values || {}); }
            catch (error) { throw httpError(400, (error as Error).message); }
            const receipt = await executeDataBatch(store, { protocolVersion: 1, batchId: `frontend-${moduleId}-${regionId}-${randomUUID()}`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `update-${randomUUID()}`, moduleId, collectionId: region.collectionId, recordType: region.recordType, action: "update", targetId: region.recordId, expectedRevision: value.expectedRevision, data: next }] }, { access: [{ moduleId, collectionId: region.collectionId, capabilities: [region.updateCapability], views: [region.view] }], context: { initiatorKind: "user", initiatorId: "web-module-frontend", binding: { turn: active?.turn || 0, messageId: null }, sourceReferences: [] } });
            if (receipt.status !== "committed") throw httpError(receipt.results?.some((item: any) => item.code === "revision_conflict") ? 409 : 400, `Settings update failed: ${receipt.results?.[0]?.error || receipt.status}`);
            return { saved: true, receipt };
          },
          runModuleFrontendWorkflow: async (moduleId: string, regionId: string, workflowId: string, value: any) => {
            const module = requireFrontendModule(moduleId);
            let region;
            let payload;
            try {
              region = frontendRegion(module, regionId, "workflow-controls");
              payload = validateFrontendWorkflowPayload(region, workflowId, value?.payload || {});
            } catch (error) { throw httpError(400, (error as Error).message); }
            return startManualBackgroundWorkflow(workflowId, { ...payload, frontendModuleId: moduleId, frontendRegionId: regionId });
          },
          inspectModuleFrontendIntegrity: async (moduleId: string, regionId: string) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "integrity-alerts"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before inspecting module integrity.");
            const result = await inspectDataIntegrity(active.sessionDirectory, {
              messages: active.messages,
              allowedModuleIds: [moduleId],
            });
            const issues = [...result.issues];
            if (region.coverage) {
              const coverage = region.coverage;
              const store = activeDataStore();
              const state = await store.readCollection(moduleId, coverage.collectionId);
              const archiveState = state.records.find((item: any) => item.id === coverage.stateRecordId && item.recordType === coverage.stateRecordType);
              const settings = state.records.find((item: any) => item.id === coverage.settingsRecordId && item.recordType === coverage.settingsRecordType);
              if (!archiveState || !settings) throw httpError(409, "Module coverage state is not initialized.");
              const lastArchivedTurn = Number(dataValueAt(archiveState, `/data${coverage.lastArchivedTurnPath}`));
              const enabled = dataValueAt(settings, `/data${coverage.enabledPath}`) === true;
              const protectRecentTurns = Number(dataValueAt(settings, `/data${coverage.protectRecentTurnsPath}`));
              const archiveEveryTurns = Number(dataValueAt(settings, `/data${coverage.archiveEveryTurnsPath}`));
              if (![lastArchivedTurn, protectRecentTurns, archiveEveryTurns].every(Number.isSafeInteger)) throw httpError(500, "Module coverage declaration resolved invalid values.");
              const intervals = lastArchivedTurn > 0 ? [{ start: 1, end: lastArchivedTurn }] : [];
              const currentRevisionByMessage = new Map(active.messages.map(message => [message.id, message.revision]));
              const acknowledgedMessages = new Set<string>();
              for (const item of state.records.filter((entry: any) => entry.status === "active" && entry.recordType === coverage.coverageRecordType)) {
                const start = Number(dataValueAt(item, `/data${coverage.startTurnPath}`));
                const end = Number(dataValueAt(item, `/data${coverage.endTurnPath}`));
                if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start) intervals.push({ start, end });
                if (!["repair", "supplement"].includes(item.data?.operation)) continue;
                for (const messageId of item.data?.coveredMessageIds || []) {
                  const currentRevision = currentRevisionByMessage.get(messageId);
                  if (item.provenance?.sourceReferences?.some((source: any) => source.kind === "message" && source.id === messageId && source.revision === currentRevision)) acknowledgedMessages.add(messageId);
                }
              }
              for (let index = issues.length - 1; index >= 0; index -= 1) if (issues[index].type === "source-revised" && acknowledgedMessages.has(issues[index].messageId)) issues.splice(index, 1);
              intervals.sort((left, right) => left.start - right.start || left.end - right.end);
              const merged: Array<{ start: number; end: number }> = [];
              for (const interval of intervals) {
                const previous = merged.at(-1);
                if (previous && interval.start <= previous.end + 1) previous.end = Math.max(previous.end, interval.end);
                else merged.push({ ...interval });
              }
              const eligibleLastTurn = Math.max(0, latestCompletedTurn(active) - protectRecentTurns);
              if (enabled && eligibleLastTurn > 0) {
                let cursor = 1;
                for (const interval of merged) {
                  if (interval.end < cursor) continue;
                  if (interval.start > cursor) issues.push({ id: `coverage:${cursor}:${Math.min(eligibleLastTurn, interval.start - 1)}`, type: "coverage-gap", severity: "warning", moduleId, startTurn: cursor, endTurn: Math.min(eligibleLastTurn, interval.start - 1), batchIds: [], targets: [] });
                  cursor = Math.max(cursor, interval.end + 1);
                  if (cursor > eligibleLastTurn) break;
                }
                if (cursor <= eligibleLastTurn && eligibleLastTurn - cursor + 1 >= archiveEveryTurns) issues.push({ id: `coverage:${cursor}:${eligibleLastTurn}`, type: "coverage-gap", severity: "warning", moduleId, startTurn: cursor, endTurn: eligibleLastTurn, batchIds: [], targets: [] });
              }
            }
            issues.sort((left: any, right: any) => left.startTurn - right.startTurn || left.type.localeCompare(right.type));
            return { ...result, issues, action: region.action, empty: region.empty };
          },
          inspectDataImpact: async (messageId: string, revision: number | null, moduleId: string | null) => {
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before inspecting data impact.");
            const installed = active.featureModules.map(item => item.id);
            if (moduleId && !installed.includes(moduleId)) throw httpError(404, `Feature module ${moduleId} is not available.`);
            return inspectDataImpact(active.sessionDirectory, { messageId, revision, allowedModuleIds: moduleId ? [moduleId] : installed });
          },
          openFeatureModuleDocument: async (moduleId: string, target: unknown) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (target !== "data" && target !== "definition") throw httpError(400, "Module document target must be data or definition.");
            const module = active.featureModules.find(item => item.id === moduleId && item.surface === "frontend");
            if (!module) throw httpError(404, "Feature module was not found in the Web interface.");
            let documentPath: string;
            if (target === "definition") {
              documentPath = resolve(module.moduleDirectory, "data-contract.json");
            } else {
              if (!active.sessionDirectory) throw httpError(409, "Select an opening or saved chat before opening module data.");
              await ensureFeatureModuleRecords(active);
              const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) });
              const collections: Record<string, unknown> = {};
              for (const collectionId of Object.keys(module.contract.collections)) collections[collectionId] = await store.readCollection(module.id, collectionId);
              documentPath = resolve(active.sessionDirectory, "workspace", "public", "module-views", `${module.id}.json`);
              await mkdir(resolve(documentPath, ".."), { recursive: true });
              await writeFile(documentPath, `${JSON.stringify({ generated: true, moduleId: module.id, collections }, null, 2)}\n`, "utf8");
            }
            await readFile(documentPath, "utf8");
            try {
              await openLocalDocument(documentPath);
            } catch (error) {
              throw httpError(500, `Could not open the local document: ${(error as Error).message}`);
            }
            return {
              opened: true,
              target,
              path: relative(active.context.cwd, documentPath).replaceAll("\\", "/"),
            };
          },
          getUserAvatar: async (playerName: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            const profile = active.commonSettings.user.savedProfiles.find(item => item.name === playerName);
            if (!profile?.avatar) throw httpError(404, "This player profile has no avatar.");
            const path = resolveAvatarFile(commonSettingsDirectory, profile.avatar);
            const body = await readFile(path).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Player avatar was not found.");
              throw error;
            });
            const extension = extname(path).toLowerCase();
            const mimeType = extension === ".png" ? "image/png"
              : extension === ".webp" ? "image/webp"
                : "image/jpeg";
            return { body, mimeType };
          },
          updateUserAvatar: async ({ playerName, mimeType, body }: { playerName: string; mimeType: string; body: Buffer }) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            let profile = active.commonSettings.user.savedProfiles.find(item => item.name === playerName);
            if (!profile) {
              profile = {
                name: playerName,
                description: playerName === active.playerName ? active.playerDescription : "",
              };
              active.commonSettings.user.savedProfiles.push(profile);
            }
            const previousAvatar = profile.avatar;
            const digest = createHash("sha256").update(playerName.normalize("NFC"), "utf8").digest("hex");
            const avatar = `avatars/${digest}${avatarExtension(mimeType)}`;
            await writeFile(resolveAvatarFile(commonSettingsDirectory, avatar), body);
            profile.avatar = avatar;
            active.cardSettings.settings.common = {
              ...(active.cardSettings.settings.common as Record<string, unknown> || {}),
              user: structuredClone(active.commonSettings.user),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(active.cardSettings, null, 2)}\n`, "utf8");
            if (previousAvatar && previousAvatar !== avatar) {
              await rm(resolveAvatarFile(commonSettingsDirectory, previousAvatar), { force: true });
            }
            return { common: active.commonSettings, playerName };
          },
          listCards: async () => {
            const cardsRoot = resolve(context.cwd, "cards");
            const directories = await readdir(cardsRoot, { withFileTypes: true });
            const cards = [];
            for (const directory of directories) {
              if (!directory.isDirectory()) continue;
              try {
                const directoryPath = resolveCardDirectory(context.cwd, directory.name);
                const cardManifest = JSON.parse(await readFile(resolve(directoryPath, "manifest.json"), "utf8"));
                if (!cardManifest.id || !cardManifest.name) continue;
                cards.push({
                  id: cardManifest.id,
                  name: cardManifest.name,
                  hasCover: Boolean(await locateCardCover(directoryPath, cardManifest)),
                });
              } catch (error) {
                console.warn(`Skipping invalid RP card ${directory.name}:`, (error as Error).message);
              }
            }
            return cards.sort((left, right) => left.name.localeCompare(right.name));
          },
          getCardCover: async (cardId: string) => {
            const directoryPath = resolveCardDirectory(context.cwd, cardId);
            const cardManifest = JSON.parse(await readFile(resolve(directoryPath, "manifest.json"), "utf8"));
            const cover = await locateCardCover(directoryPath, cardManifest);
            if (!cover) throw httpError(404, "Card cover was not found.");
            return cover;
          },
          switchCard: async (cardId: string, forceNew = false) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (cardId === active.cardId && !forceNew) return { current: true };
            resolveCardDirectory(context.cwd, cardId);
            if (!active.context.isIdle()) throw httpError(409, "Wait for the current Pi response before switching chats.");
            pi.sendUserMessage(`/rp-web-reset ${cardId}`, { expandPromptTemplates: true });
            return { current: false, switching: true };
          },
          listSessions: async () => {
            const directories = await readdir(cardSessionsDirectory, { withFileTypes: true }).catch(error => {
              if (error.code === "ENOENT") return [];
              throw error;
            });
            const sessions = [];
            for (const directory of directories) {
              if (!directory.isDirectory()) continue;
              const recordDirectory = resolveSessionDirectory(cardSessionsDirectory, directory.name);
              try {
                const [metadataText, messagesText] = await Promise.all([
                  readFile(resolve(recordDirectory, "session.json"), "utf8"),
                  readFile(resolve(recordDirectory, "messages.jsonl"), "utf8"),
                ]);
                const metadata = JSON.parse(metadataText);
                if (metadata.cardId && metadata.cardId !== manifest.id) continue;
                const recordMessages = parseRecordLines(messagesText) as RecordEnvelope[];
                if (recordMessages.length === 0) continue;
                const lastMessage = recordMessages.at(-1);
                sessions.push({
                  id: directory.name,
                  playerName: metadata.playerName || "玩家",
                  openingId: metadata.openingId || null,
                  messageCount: recordMessages.length,
                  lastMessage: lastMessage?.data.content || "",
                  updatedAt: metadata.updatedAt || lastMessage?.updatedAt || metadata.createdAt || "",
                });
              } catch (error) {
                if (error.code !== "ENOENT") console.warn(`Skipping invalid RP session ${directory.name}:`, error.message);
              }
            }
            return sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
          },
          deleteSession: async (sessionId: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (sessionId === active.recordId) throw httpError(409, "The active chat cannot be deleted.");
            const recordDirectory = resolveSessionDirectory(cardSessionsDirectory, sessionId);
            await rm(recordDirectory, { recursive: true, force: false }).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") throw httpError(404, "Saved chat was not found.");
              throw error;
            });
            return { deleted: sessionId };
          },
          updateMessage: async (sequence: number, content: string) => {
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "There is no active saved chat to edit.");
            if (bridgeBusy(active)) throw httpError(409, "Wait for the current turn and its blocking background workflows before editing messages.");
            const index = active.messages.findIndex(message => message.sequence === sequence);
            if (index === -1) throw httpError(404, "Saved message was not found.");
            const previous = active.messages[index];
            const updated = reviseRecord(previous, { ...previous.data, content }) as RecordEnvelope;
            active.messages[index] = updated;
            await rewriteMessages();
            await updateMetadata();
            return webSnapshot();
          },
          deleteMessage: async (sequence: number) => {
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "There is no active saved chat to edit.");
            if (bridgeBusy(active)) throw httpError(409, "Wait for the current turn and its blocking background workflows before deleting messages.");
            const index = active.messages.findIndex(message => message.sequence === sequence);
            if (index === -1) throw httpError(404, "Saved message was not found.");
            const deleted = active.messages.splice(index);
            const deletedFromTurn = deleted.reduce((minimum, message) => Math.min(minimum, message.binding.turn), Number.POSITIVE_INFINITY);
            active.messages = active.messages.map((message, nextSequence) => ({ ...message, sequence: nextSequence }));
            active.turn = active.messages.reduce((maximum, message) => Math.max(maximum, message.binding.turn), 0);
            const deletedMessageIds = new Set(deleted.map(message => message.id));
            await pruneModuleRecords(active, deletedMessageIds);
            if (Number.isSafeInteger(deletedFromTurn)) {
              await pruneWorkflowState(active.sessionDirectory, deletedFromTurn);
              active.workflowEngine.pruneRuns((run: any) => (Number.isSafeInteger(run.turn) && run.turn >= deletedFromTurn) || (Number.isSafeInteger(run.visibleThroughTurn) && run.visibleThroughTurn >= deletedFromTurn));
              await hydrateNodeCompletionTurns(active.sessionDirectory);
            }
            for (const draftPath of [outputDraftPath(active), variableDraftPath(active)]) {
              const pendingDraft = await readFile(draftPath, "utf8").then(JSON.parse).catch(error => {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw error;
              });
              if (pendingDraft?.assistantMessageId && deletedMessageIds.has(pendingDraft.assistantMessageId)) {
                await rm(draftPath, { force: true });
              }
            }
            const becameEmpty = active.messages.length === 0;
            const deletedDirectory = active.sessionDirectory;
            if (becameEmpty) {
              await rm(deletedDirectory, { recursive: true, force: false });
            } else {
              await rewriteMessages();
              await updateMetadata();
            }
            if (becameEmpty) {
              active.recordId = null;
              active.sessionDirectory = null;
              active.openingId = null;
            }
            return webSnapshot();
          },
          resumeSession: async (sessionId: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (active.messages.length > 0) throw httpError(409, "The current Web RP session has already started.");
            const recordDirectory = resolveSessionDirectory(cardSessionsDirectory, sessionId);
            let metadata;
            let recordMessages: RecordEnvelope[];
            try {
              const [metadataText, messagesText] = await Promise.all([
                readFile(resolve(recordDirectory, "session.json"), "utf8"),
                readFile(resolve(recordDirectory, "messages.jsonl"), "utf8"),
              ]);
              metadata = JSON.parse(metadataText);
              recordMessages = parseRecordLines(messagesText) as RecordEnvelope[];
            } catch (error) {
              if (error.code === "ENOENT") throw httpError(404, "Saved chat was not found.");
              throw error;
            }
            if (metadata.cardId && metadata.cardId !== active.cardId) {
              throw httpError(409, "Saved chat belongs to another card.");
            }
            if (recordMessages.length === 0) throw httpError(409, "Saved chat has no messages to resume.");

            active.recordId = sessionId;
            active.sessionDirectory = recordDirectory;
            active.openingId = metadata.openingId || manifest.default_opening || "opening-00";
            active.playerName = metadata.playerName || "玩家";
            active.playerDescription = metadata.playerDescription ?? active.commonSettings.user.description ?? "";
            active.messages = recordMessages;
            active.turn = recordMessages.reduce((maximum, message) => Math.max(maximum, message.binding.turn), 0);
            await hydrateNodeCompletionTurns(active.sessionDirectory);
            await restoreWorkflowRuns(active.sessionDirectory);
            await ensureFeatureModuleRecords(active);
            await updateMetadata();

            return webSnapshot();
          },
          selectOpening: async (opening: any) => {
          if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
          if (active.openingId) {
            return webSnapshot();
          }
          const createdAt = new Date().toISOString();
          active.openingId = opening.id;
          active.playerName = opening.playerName || active.playerName;
          const openingRecord = await appendMessage({
            sequence: 0,
            turn: 0,
            role: "assistant",
            kind: "opening",
            content: opening.content,
            createdAt,
            narrativeSource: { producerKind: "card", producerId: active.cardId, layer: "story", characterId: null },
          });
          await updateMetadata();
          await dispatchWorkflowEvent({ type: "after-opening", openingId: opening.id, messageId: openingRecord?.id || null }, { id: `opening-${opening.id}`, turn: 0 });
          return webSnapshot();
          },
          submitInput: async (content: string) => {
          if (!active?.openingId) throw httpError(409, "Select an opening first.");
          if (active.pending || !active.context.isIdle()) throw httpError(409, "Pi is still processing the previous message.");
          const blockers = active.workflowEngine.blockingTurnRuns();
          if (blockers.length) {
            const first = blockers[0];
            const additional = blockers.length > 1 ? ` and ${blockers.length - 1} other workflow(s)` : "";
            throw httpError(409, `Background workflow ${first.workflowTitle}${additional} must finish or be cancelled before the next player turn.`);
          }
          await ensureActiveRecord();
          active.lastTurnFailure = null;
          await cleanupArtifacts(active.sessionDirectory!, { type: "turn", turn: active.turn + 1 });
          active.turn += 1;
          active.pending = true;
          const userRecord = await appendMessage({
            sequence: active.messages.length,
            turn: active.turn,
            role: "user",
            kind: "message",
            content,
            createdAt: new Date().toISOString(),
            narrativeSource: { producerKind: "user", producerId: null, layer: "in-world", characterId: null },
          });
          await updateMetadata();
          rpRun = {
            cardId: active.cardId,
            recordId: active.recordId!,
            submittedText: content,
            submittedSequence: active.messages.at(-1)!.sequence,
            assistantContent: "",
            automaticSelections: {},
            agentQueries: [],
            agentSources: [],
            processorSelections: [],
            contextContent: null,
            phase: "narrative",
            assistantMessageId: null,
            workflowRunId: null,
            workflowNarrativeNodeId: null,
            resolveNarrative: null,
            rejectNarrative: null,
            baseModel: active.context.model,
          };
          try {
            const workflow = await active.configStore.getWorkflow(active.activeWorkflowId);
            if (workflow.kind !== "foreground") throw new Error(`Active workflow ${workflow.id} is not a foreground workflow.`);
            const unresolved = unresolvedWorkflowCalls(workflow, active.featureModules);
            if (unresolved.length) {
              throw Object.assign(
                new Error(`Active workflow ${workflow.id} calls modules this card does not install: ${unresolved.join(", ")}. Install them or reconcile the workflow's call declarations.`),
                { code: "workflow_configuration_invalid" },
              );
            }
            const finalizer = workflow.nodes.find((node: any) => node.type === "turn-finalize");
            rpRun.workflowNarrativeNodeId = finalizer?.narrative?.fromNode || null;
            const workflowRunId = `workflow-${randomUUID()}`;
            rpRun.workflowRunId = workflowRunId;
            await active.workflowEngine.start(workflow, {
              id: workflowRunId,
              cardId: active.cardId,
              chatId: active.recordId,
              turn: active.turn,
              trigger: { type: "player-input" },
              sourceReferences: userRecord ? [messageSourceReference(userRecord)] : [],
              payload: { currentInput: content, userSequence: rpRun.submittedSequence },
            });
          } catch (error) {
            active.pending = false;
            rpRun = null;
            throw error;
          }
          },
          updateUserSettings: async ({ playerName, description }: { playerName: string; description: string }) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            active.playerName = playerName;
            active.playerDescription = description;
            active.commonSettings.user.playerName = playerName;
            active.commonSettings.user.description = description;
            const existingProfile = active.commonSettings.user.savedProfiles.find(profile => profile.name === playerName);
            if (existingProfile) existingProfile.description = description;
            else active.commonSettings.user.savedProfiles.push({ name: playerName, description });
            active.cardSettings.settings.common = {
              ...(active.cardSettings.settings.common as Record<string, unknown> || {}),
              user: structuredClone(active.commonSettings.user),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(active.cardSettings, null, 2)}\n`, "utf8");
            await updateMetadata();
            return webSnapshot({ settings: active.commonSettings });
          },
          deleteUserProfile: async (playerName: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            const { settings, removed, activeChanged } = removeSavedUserProfile(active.commonSettings, playerName);
            active.commonSettings = settings;
            if (activeChanged) {
              active.playerName = settings.user.playerName;
              active.playerDescription = settings.user.description;
            }
            active.cardSettings.settings.common = {
              ...(active.cardSettings.settings.common as Record<string, unknown> || {}),
              user: structuredClone(active.commonSettings.user),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(active.cardSettings, null, 2)}\n`, "utf8");
            if (removed.avatar && !settings.user.savedProfiles.some(profile => profile.avatar === removed.avatar)) {
              await rm(resolveAvatarFile(commonSettingsDirectory, removed.avatar), { force: true }).catch(error => {
                console.warn(`Could not remove deleted player avatar ${removed.avatar}:`, (error as Error).message);
              });
            }
            await updateMetadata();
            return webSnapshot({ settings: active.commonSettings, deletedPlayerName: removed.name });
          },
          updateSystemSettings: async ({ fontSize }: { fontSize: number }) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            active.commonSettings.system.fontSize = fontSize;
            active.cardSettings.settings.common = {
              ...(active.cardSettings.settings.common as Record<string, unknown> || {}),
              system: structuredClone(active.commonSettings.system),
            };
            await writeFile(cardSettingsPath, `${JSON.stringify(active.cardSettings, null, 2)}\n`, "utf8");
            return {
              common: active.commonSettings,
              card: active.cardSettings,
            };
          },
          updateModuleDisplaySettings: async ({ order, hidden }: ModuleDisplaySettings) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            active.cardSettings.settings.featureModules = normalizeModuleDisplaySettings({ order, hidden }, active.featureModules);
            await writeFile(cardSettingsPath, `${JSON.stringify(active.cardSettings, null, 2)}\n`, "utf8");
            return { card: active.cardSettings };
          },
        },
      });
    } catch (error) {
      active = null;
      throw error;
    }
    active.close = bridge.close;
    active.url = bridge.url;
    await updateMetadata();
    openBrowser(bridge.url);
    context.ui.notify(`Web RP opened: ${bridge.url}`, "info");
    return bridge.url;
  }

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

  function currentDataNode() {
    if (!active?.sessionDirectory || !rpRun?.workflowRunId) throw new Error("RP data tools require an active workflow node.");
    const entry = (active.workflowEngine as any).runs.get(rpRun.workflowRunId);
    const nodeId = rpRun.workflowNarrativeNodeId;
    const node = entry?.workflow?.nodes?.find((item: any) => item.id === nodeId);
    if (!entry || !node) throw new Error("The active RP workflow node is unavailable.");
    return { entry, node, store: new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: dataModuleBindings(active.featureModules) }) };
  }

  function nodeDataAccess(node: any, moduleId: string, collectionId: string) {
    const access = node.moduleAccess?.find((item: any) => item.moduleId === moduleId && item.collectionId === collectionId);
    if (!access) throw new Error(`The current node has no access to ${moduleId}/${collectionId}.`);
    return access;
  }

  async function requireCurrentAgentTool(entry: any, node: any, toolName: string) {
    const agentId = node.agentId || entry.workflow.defaults?.agentId;
    if (!agentId) throw new Error(`The current workflow node has no Agent authorized for ${toolName}.`);
    const agent = (await active!.configStore.getAgent(agentId)).effective;
    if (!agent?.tools?.includes(toolName)) throw new Error(`Agent ${agentId} is not authorized to use ${toolName}.`);
    return agent;
  }

  pi.registerTool({
    name: "rp_data_query",
    label: "Query RP data",
    description: "Query one module collection through declared indexes/content search and return only an authorized named view under the node's query budget.",
    parameters: Type.Object({
      moduleId: Type.String(),
      collectionId: Type.String(),
      recordTypes: Type.Optional(Type.Array(Type.String())),
      where: Type.Optional(Type.Record(Type.String(), Type.Any())),
      search: Type.Optional(Type.Object({ query: Type.String(), fields: Type.Optional(Type.Array(Type.String())) })),
      sort: Type.Optional(Type.Array(Type.Object({ field: Type.String(), order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])) }))),
      view: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
      maxCharacters: Type.Optional(Type.Integer({ minimum: 1 })),
      cursor: Type.Optional(Type.String()),
      includeInactive: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, parameters) {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_query");
      const access = nodeDataAccess(node, parameters.moduleId, parameters.collectionId);
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
    },
  });

  pi.registerTool({
    name: "rp_data_get",
    label: "Read one RP data record",
    description: "Read one exact RP data record through an authorized named view.",
    parameters: Type.Object({ moduleId: Type.String(), collectionId: Type.String(), id: Type.String(), view: Type.Optional(Type.String()) }),
    async execute(_toolCallId, parameters) {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_get");
      const access = nodeDataAccess(node, parameters.moduleId, parameters.collectionId);
      const result = await getDataRecord(store, parameters, { capabilities: access.capabilities, views: access.views, ...workflowDataReadAccess(entry.run, store, entry.run.nodes[node.id]?.dataReadBatchIds || entry.run.inheritedDataReadBatchIds || []) });
      return { content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "Record not found." }], details: result };
    },
  });

  pi.registerTool({
    name: "rp_data_resolve",
    label: "Resolve RP data identity",
    description: "Resolve one registered ID, display name, or alias within the current node's authorized collections.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_toolCallId, parameters) {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_resolve");
      const matches = (await resolveWorkflowIdentity(entry.run, store, parameters.value, entry.run.nodes[node.id]?.dataReadBatchIds || entry.run.inheritedDataReadBatchIds || [])).filter((entry: any) => {
        const access = node.moduleAccess?.find((item: any) => item.moduleId === entry.moduleId && item.collectionId === entry.collectionId);
        return access && capabilityAllows(store.module(entry.moduleId).contract, access.capabilities, { collectionId: entry.collectionId, action: "query" });
      });
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }], details: matches };
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
      const { entry, node } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_change");
      const output = node.outputs?.[parameters.output];
      if (!output || output.format !== "unified-change-batch") throw new Error(`Node output ${parameters.output} is not a declared unified change batch.`);
      const root = workflowNodeWorkspace(active!.sessionDirectory!, entry.workflow.id, entry.run.id, node.id);
      const path = resolve(root, output.path);
      await mkdir(resolve(path, ".."), { recursive: true });
      const current = await readFile(path, "utf8").then(JSON.parse).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return createDataBatchDraft({ batchId: `${entry.run.id}-${node.id}-${parameters.output}`, commitPolicy: parameters.commitPolicy || "atomic" });
      });
      const next = updateDataBatchDraft(current, parameters.changes);
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return { content: [{ type: "text", text: `Data draft ${parameters.output} now contains ${next.operations.length} operation(s).` }], details: { output: parameters.output, batchId: next.batchId, operationCount: next.operations.length } };
    },
  });

  pi.registerTool({
    name: "rp_data_submit",
    label: "Submit an RP data draft",
    description: "Validate and submit one explicitly declared node output change draft now. Node-end handling will recognize the receipt and not duplicate it.",
    parameters: Type.Object({ output: Type.String() }),
    async execute(_toolCallId, parameters) {
      const { entry, node, store } = currentDataNode();
      await requireCurrentAgentTool(entry, node, "rp_data_submit");
      const output = node.outputs?.[parameters.output];
      if (!output || output.format !== "unified-change-batch") throw new Error(`Node output ${parameters.output} is not a declared unified change batch.`);
      const path = resolve(workflowNodeWorkspace(active!.sessionDirectory!, entry.workflow.id, entry.run.id, node.id), output.path);
      const batch = JSON.parse(await readFile(path, "utf8"));
      const receipt = rememberDataReceipt(entry.run, node.id, await executeDataBatch(store, batch, {
        access: node.moduleAccess,
        allowBestEffort: node.dataCommit?.allowBestEffort === true,
        context: { initiatorKind: "agent", initiatorId: node.agentId || node.id, workflowId: entry.workflow.id, workflowRunId: entry.run.id, nodeId: node.id, binding: { turn: entry.run.turn || 0, messageId: rpRun?.assistantMessageId || null }, sourceReferences: entry.run.sourceReferences || [] },
      }));
      return { content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }], details: receipt };
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
      if (!active?.pending || !rpRun || active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) throw new Error("rp_message_query requires an active Web RP narrative turn.");
      const source = "messages";
      const policy = active.messagePolicy;
      if (policy.agent.mode === "disabled") throw new Error("Agent message retrieval is disabled for this card.");
      if (rpRun.agentQueries.some(query => query.source === source)) throw new Error("rp_message_query already resolved message history for this turn.");
      const records = active.messages.filter(record => record.sequence < rpRun!.submittedSequence);
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
        const automatic = new Set(rpRun.automaticSelections[source] || []);
        selected = selected.filter(record => !automatic.has(record.id));
      }
      const receipt = { source, mode: policy.agent.mode, decision: parameters.decision, selector: parameters.selector || null, status, error: error || null, selectedRecordIds: selected.map(record => record.id), queriedAt: new Date().toISOString() };
      rpRun.agentQueries.push(receipt);
      if (rpRun.workflowRunId) await active.workflowEngine.addSourceReferences(rpRun.workflowRunId, selected.map(messageSourceReference));
      await writeContextReceipt(active, rpRun);
      return { content: [{ type: "text", text: [`RP message query: ${status}`, error ? `Reason: ${error}` : "", authoritativeTranscript(active, selected)].filter(Boolean).join("\n\n") }], details: receipt };
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
  pi.on("session_before_switch", stopBridge);
  pi.on("session_shutdown", stopBridge);
}
