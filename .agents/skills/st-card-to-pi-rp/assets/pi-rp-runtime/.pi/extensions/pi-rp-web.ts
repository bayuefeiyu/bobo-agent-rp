import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
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
import { createRpConfigStore } from "../lib/rp-config-store.mjs";
import { RpWorkflowEngine } from "../lib/rp-workflow-engine.mjs";
import { composeNodePrompt, resolveNodeProfiles } from "../lib/rp-model-config.mjs";
import { workflowTriggerMatches } from "../lib/rp-workflows.mjs";
import { tokenUsageFromMessages } from "../lib/rp-token-usage.mjs";
import { appendWorkflowRunRecord, ensureWorkflowWorkspace, pruneWorkflowState, workflowProcessRecordPath, workflowWorkspacePaths, writeWorkflowProcessRecord } from "../lib/rp-workspace.mjs";
import { capabilityAllows, normalizeDataContract } from "../lib/rp-data-contracts.mjs";
import { RpDataStore } from "../lib/rp-data-store.mjs";
import { getDataRecord, queryData } from "../lib/rp-data-query.mjs";
import { createDataBatchDraft, executeDataBatch, updateDataBatchDraft } from "../lib/rp-data-changes.mjs";
import { finalizeNodeData } from "../lib/rp-data-node-runtime.mjs";
import { cleanupArtifacts, readVisibleArtifacts, workflowNodeWorkspace } from "../lib/rp-data-artifacts.mjs";

type WebMessage = {
  sequence: number;
  turn: number;
  role: "user" | "assistant";
  kind: "opening" | "message";
  content: string;
  createdAt: string;
  editedAt?: string;
};

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
  primaryCharacterContext: string;
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
};

type FeatureModule = {
  id: string;
  title: string;
  description: string;
  surface: "frontend" | "background";
  contextOrder: number;
  displayOrder: number;
  basedOn: string | null;
  contract: any;
  view: { schemaVersion: 1; regions: unknown[] };
  viewPath: string;
  moduleDirectory: string;
  skillPath: string;
  skillDescription: string;
};

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

const defaultCommonSettings: CommonSettings = {
  schemaVersion: 1,
  user: {
    playerName: "玩家",
    description: "",
    savedProfiles: [{ name: "玩家", description: "" }],
  },
  system: { fontSize: 16 },
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

function normalizeCommonSettings(value: any): CommonSettings {
  const playerName = typeof value?.user?.playerName === "string" && value.user.playerName.trim()
    ? value.user.playerName.trim()
    : "玩家";
  const description = typeof value?.user?.description === "string" ? value.user.description : "";
  const savedProfiles = Array.isArray(value?.user?.savedProfiles)
    ? value.user.savedProfiles
      .filter((profile: any) => typeof profile?.name === "string" && profile.name.trim())
      .map((profile: any) => {
        const normalized = {
          name: profile.name.trim(),
          description: typeof profile.description === "string" ? profile.description : "",
        } as { name: string; description: string; avatar?: string };
        if (typeof profile.avatar === "string" && /^avatars\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(profile.avatar)) {
          normalized.avatar = profile.avatar;
        }
        return normalized;
      })
    : [];
  if (!savedProfiles.some(profile => profile.name === playerName)) savedProfiles.push({ name: playerName, description });
  return {
    schemaVersion: 1,
    user: { playerName, description, savedProfiles },
    system: { fontSize: Number.isInteger(value?.system?.fontSize) ? value.system.fontSize : 16 },
  };
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
  const primaryCharacters = active.primaryCharacterContext.trim();
  if (primaryCharacters) sections.push("# Primary card character profiles", primaryCharacters);
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
        `Collections: ${Object.keys(module.contract.collections).join(", ")}. Use rp_data_query/rp_data_get only within the current workflow node's granted capabilities.`,
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
    return `[${record.id} | ${speaker} | ${kind}]\n${message.content}`;
  }).join("\n\n");
}

async function readCardContextFiles(cardDirectory: string, paths: unknown, label: string) {
  if (!Array.isArray(paths)) return "";
  const sections = [];
  for (const value of paths) {
    if (typeof value !== "string") throw new Error(`${label} contains a non-string path.`);
    const path = resolveCardChild(cardDirectory, value);
    if (!path) throw new Error(`${label} path escapes the card directory: ${value}`);
    sections.push(`## ${value}\n${(await readFile(path, "utf8")).trim()}`);
  }
  return sections.join("\n\n");
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
    const record = JSON.parse(await readFile(modulePath, "utf8"));
    const moduleFields = ["schemaVersion", "id", "basedOn", "title", "description", "surface", "contextOrder", "displayOrder", "dataContractFile", "frontendViewFile", "skillFile"];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Feature module ${value} must be a JSON object.`);
    }
    const recordFields = Object.keys(record).sort();
    if (moduleFields.length !== recordFields.length || moduleFields.some(field => !recordFields.includes(field))) {
      throw new Error(`Feature module ${value} must use the exact schemaVersion 4 field set.`);
    }
    if (record.schemaVersion !== 4 || typeof record.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(record.id)) {
      throw new Error(`Invalid feature-module definition: ${value}`);
    }
    if (ids.has(record.id)) throw new Error(`Duplicate feature-module id: ${record.id}`);
    ids.add(record.id);
    const moduleDirectory = resolve(modulePath, "..");
    if (typeof record.title !== "string" || !record.title.trim()) {
      throw new Error(`Feature module ${record.id} must declare a non-empty title.`);
    }
    if (typeof record.description !== "string") {
      throw new Error(`Feature module ${record.id} must declare a description string.`);
    }
    if (record.surface !== "frontend" && record.surface !== "background") {
      throw new Error(`Feature module ${record.id} surface must be frontend or background.`);
    }
    if (!Number.isSafeInteger(record.contextOrder) || !Number.isSafeInteger(record.displayOrder)) {
      throw new Error(`Feature module ${record.id} must declare integer contextOrder and displayOrder values.`);
    }
    if (record.basedOn !== null && (typeof record.basedOn !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(record.basedOn))) {
      throw new Error(`Feature module ${record.id}.basedOn must be null or a safe module ID.`);
    }
    const viewPath = resolveFeatureModuleChild(moduleDirectory, record.frontendViewFile, `${record.id}.frontendViewFile`);
    const contractPath = resolveFeatureModuleChild(moduleDirectory, record.dataContractFile, `${record.id}.dataContractFile`);
    const skillPath = resolveFeatureModuleChild(moduleDirectory, record.skillFile, `${record.id}.skillFile`);
    const [view, rawContract, skillText] = await Promise.all([
      readFile(viewPath, "utf8").then(JSON.parse),
      readFile(contractPath, "utf8").then(JSON.parse),
      readFile(skillPath, "utf8"),
    ]);
    if (view?.schemaVersion !== 1 || !Array.isArray(view.regions)) {
      throw new Error(`Feature module ${record.id} has an invalid view specification.`);
    }
    const contract = normalizeDataContract(rawContract, record.id);
    modules.push({
      id: record.id,
      title: record.title.trim(),
      description: record.description.trim(),
      surface: record.surface,
      contextOrder: record.contextOrder,
      displayOrder: record.displayOrder,
      basedOn: record.basedOn,
      contract,
      view,
      viewPath,
      moduleDirectory,
      skillPath,
      skillDescription: parseSkillDescription(skillText, `${record.id}.skillFile`),
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
      if (!module.contract.collections[query.collectionId]) throw new Error(`Context processor ${definition.id} requires unknown collection ${query.moduleId}/${query.collectionId}.`);
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
  const enabled = policy.agent.mode !== "disabled" || policy.catalog.agentMode !== "disabled";
  if (!enabled && path === undefined) return { path: null, description: "" };
  if (typeof path !== "string") throw new Error("manifest context_skill is required when message Agent retrieval or catalog enrichment is enabled.");
  const skillPath = resolveCardChild(cardDirectory, path);
  if (!skillPath) throw new Error("manifest context_skill escapes the card directory.");
  const text = await readFile(skillPath, "utf8");
  return { path: skillPath, description: parseSkillDescription(text, "context_skill") };
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
  async function ensureFeatureModuleRecords(target: ActiveBridge) {
    if (!target.recordId || !target.sessionDirectory) return;
    await new RpDataStore({
      sessionDirectory: target.sessionDirectory,
      modules: target.featureModules.map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory })),
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
      metadata: { recordType: message.kind, entityIds: [], tags: [message.role] },
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
      modules: target.featureModules.map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory })),
    }).pruneByMessageIds(deletedMessageIds);
  }

  async function readModuleProcessorData(target: ActiveBridge, module: FeatureModule) {
    if (!target.sessionDirectory) return { collections: {} };
    await ensureFeatureModuleRecords(target);
    const store = new RpDataStore({ sessionDirectory: target.sessionDirectory, modules: target.featureModules.map(item => ({ contract: item.contract, moduleDirectory: item.moduleDirectory })) });
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
    const store = new RpDataStore({ sessionDirectory: target.sessionDirectory, modules: target.featureModules.map(item => ({ contract: item.contract, moduleDirectory: item.moduleDirectory })) });
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
        dataQueries[query.id] = await queryData(store, query, { capabilities: access.capabilities, views: access.views, runtimeLimit: 20, runtimeCharacters: 6000, nodeLimit: access.queryBudget?.maxRecords || 20, nodeCharacters: access.queryBudget?.maxCharacters || 6000 });
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
        sections.push(`# Authoritative editable Web RP history\n${authoritativeTranscript(target, selected)}`);
      } else {
        run.automaticSelections[source] = [];
      }
      if (policy.agent.mode !== "disabled") {
        if (policy.agent.mode !== "disabled") run.agentSources.push(source);
        sections.push([
          `# Record catalog: ${source}`,
          policy.agent.mode === "disabled" ? "Agent message selection is disabled; use only the automatically selected history." : `Agent selection mode: ${policy.agent.mode}. You must resolve message history once with rp_message_query before completing this node response. Use decision=select, success_empty, or not_triggered as authored.`,
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

  async function resolveConfiguredModel(target: ActiveBridge, modelId: string, piCurrentOverride?: any) {
    if (!modelId || modelId === "pi:current") return { profile: null, model: piCurrentOverride || target.context.model };
    const profile = (await target.configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === modelId);
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
  async function executeWorkflowNode(task: any) {
    if (!active?.recordId || !active.sessionDirectory) throw new Error("The workflow has no active RP chat.");
    const { workflow, run, node, agent, binding } = task;
    if (node.type === "turn-finalize") return { output: { committed: true, turn: run.turn } };
    if (node.type === "gate") return { route: run.payload?.route || node.metadata?.defaultRoute || null };
    if (node.type === "join") return { output: Object.fromEntries(node.dependsOn.map((id: string) => [id, run.nodes[id]?.output])) };
    if (node.type === "code") {
      if (!node.metadata?.entryFile) return { output: { acknowledged: true } };
      const entryPath = resolve(active.cardDirectory, node.metadata.entryFile);
      if (relative(active.cardDirectory, entryPath).startsWith("..")) throw new Error(`Code node ${node.id} entryFile escapes the card directory.`);
      const loaded: any = await import(`${pathToFileURL(entryPath).href}?run=${Date.now()}-${randomUUID()}`);
      const execute = loaded.execute || loaded.default;
      if (typeof execute !== "function") throw new Error(`${entryPath} must export execute().`);
      const nodeWorkspace = workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
      await mkdir(nodeWorkspace, { recursive: true });
      const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: active.featureModules.map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory })) });
      const accessFor = (moduleId: string, collectionId: string) => {
        const access = node.moduleAccess?.find((item: any) => item.moduleId === moduleId && item.collectionId === collectionId);
        if (!access) throw new Error(`Code node ${node.id} has no access to ${moduleId}/${collectionId}.`);
        return access;
      };
      const data = Object.freeze({
        query: (request: any) => {
          const access = accessFor(request.moduleId, request.collectionId);
          return queryData(store, request, { capabilities: access.capabilities, views: access.views, runtimeLimit: 20, runtimeCharacters: 6000, nodeLimit: access.queryBudget?.maxRecords || 20, nodeCharacters: access.queryBudget?.maxCharacters || 6000 });
        },
        get: (request: any) => {
          const access = accessFor(request.moduleId, request.collectionId);
          return getDataRecord(store, request, { capabilities: access.capabilities, views: access.views });
        },
        resolve: async (value: string) => (await store.resolveIdentity(value)).filter((entry: any) => {
          const access = node.moduleAccess?.find((item: any) => item.moduleId === entry.moduleId && item.collectionId === entry.collectionId);
          return access && capabilityAllows(store.module(entry.moduleId).contract, access.capabilities, { collectionId: entry.collectionId, action: "query" });
        }),
        submit: (batch: any) => executeDataBatch(store, batch, { access: node.moduleAccess, allowBestEffort: node.dataCommit?.allowBestEffort === true, context: { initiatorKind: "code", initiatorId: node.id, workflowId: workflow.id, workflowRunId: run.id, nodeId: node.id, binding: { turn: run.turn || 0, messageId: rpRun?.assistantMessageId || null } } }),
      });
      const output = await execute(Object.freeze({ run: structuredClone(run), node: structuredClone(node), card: { id: active.cardId, name: active.cardName }, workspace: nodeWorkspace, data }));
      return { output, assistantMessageId: rpRun?.assistantMessageId || null };
    }

    if (node.type === "narrative") {
      if (!rpRun || rpRun.workflowRunId !== run.id) throw new Error("Narrative node is not bound to the current RP turn.");
      if (rpRun.resolveNarrative) throw new Error("A narrative node is already active.");
      const configured = await resolveConfiguredModel(active, binding.modelId, rpRun.baseModel);
      if (!configured.model) throw new Error("No model is available for the narrative node.");
      if (active.context.model?.provider !== configured.model.provider || active.context.model?.id !== configured.model.id) {
        const selected = await pi.setModel(configured.model);
        if (!selected) throw new Error(`Pi could not select the narrative model: ${binding.modelId}`);
      }
      rpRun.modelHeadPrompt = configured.profile?.headPrompt || null;
      rpRun.modelTailPrompt = configured.profile?.tailPrompt || null;
      rpRun.nodeAgentPrompt = agent?.prompt || null;
      rpRun.workflowNodePrompt = node.prompt || null;
      return new Promise((resolveNarrative, rejectNarrative) => {
        rpRun!.workflowNarrativeNodeId = node.id;
        rpRun!.resolveNarrative = resolveNarrative;
        rpRun!.rejectNarrative = rejectNarrative;
        rpRun!.phaseStartedAt = Date.now();
        try {
          pi.sendUserMessage(rpRun!.submittedText);
        } catch (error) {
          rpRun!.resolveNarrative = null;
          rpRun!.rejectNarrative = null;
          rejectNarrative(error as Error);
        }
      });
    }

    const { profile, model } = await resolveConfiguredModel(active, binding.modelId);
    if (!model) throw new Error("No model is available for this workflow node.");
    const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(active.sessionDirectory, workflow.id, run.id, workflow.kind));
    const nodeWorkspace = workflowNodeWorkspace(active.sessionDirectory, workflow.id, run.id, node.id);
    await mkdir(nodeWorkspace, { recursive: true });
    const upstreamIds = node.context.fromNodes.length ? node.context.fromNodes : node.dependsOn;
    const upstream = node.context.mode === "fixed"
      ? []
      : upstreamIds.map((id: string) => ({
          id,
          output: run.nodes[id]?.output,
          ...(node.context.mode === "inherit" ? { inheritedContext: run.nodes[id]?.context } : {}),
        })).filter((item: any) => item.output !== null || item.inheritedContext);
    const upstreamArtifacts = node.context.mode === "fixed" ? [] : await readVisibleArtifacts({
      sessionDirectory: active.sessionDirectory,
      target: { workflowRunId: run.id, nodeId: node.id, turn: run.turn },
      fromNodeIds: upstreamIds,
    });
    const upstreamArtifactContent = [];
    for (const artifact of upstreamArtifacts) {
      const content = await readFile(artifact.path, "utf8");
      upstreamArtifactContent.push({ id: artifact.id, nodeId: artifact.nodeId, format: artifact.format, content: content.slice(0, 50000), truncated: content.length > 50000 });
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
      fixedContext: await fixedRpContext(active),
      dynamicContext: [Number.isSafeInteger(run.turn) ? `Turn: ${run.turn}` : "", run.payload?.frozenContext ? `Frozen completed-turn context:\n${run.payload.frozenContext}` : "", customContext].filter(Boolean).join("\n\n"),
      upstreamArtifacts: upstream.length || upstreamArtifactContent.length ? `Upstream node outputs and declared artifacts:\n${JSON.stringify({ outputs: upstream, artifacts: upstreamArtifactContent }, null, 2)}` : "",
      currentInput: typeof run.payload?.currentInput === "string" ? run.payload.currentInput : "",
      nodePrompt: node.prompt || node.description,
      modelTail: null,
    });
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const dataStore = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: active.featureModules.map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory })) });
    const dataToolFactory = {
      name: "rp-unified-data",
      hidden: true,
      factory(workerPi: any) {
        if (agent?.tools?.includes("rp_data_query")) {
        workerPi.registerTool({
          name: "rp_data_query",
          label: "Query RP data",
          description: "Query authorized indexed RP data with a named return view.",
          parameters: Type.Any(),
          async execute(_id: string, parameters: any) {
            const access = node.moduleAccess?.find((item: any) => item.moduleId === parameters.moduleId && item.collectionId === parameters.collectionId);
            if (!access) throw new Error(`This node has no access to ${parameters.moduleId}/${parameters.collectionId}.`);
            const result = await queryData(dataStore, parameters, { capabilities: access.capabilities, views: access.views, runtimeLimit: 20, runtimeCharacters: 6000, nodeLimit: access.queryBudget?.maxRecords || 20, nodeCharacters: access.queryBudget?.maxCharacters || 6000 });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
          },
        });
        }
        if (agent?.tools?.includes("rp_data_get")) {
        workerPi.registerTool({
          name: "rp_data_get",
          label: "Read one RP record",
          description: "Read one exact authorized RP record through a named view.",
          parameters: Type.Any(),
          async execute(_id: string, parameters: any) {
            const access = node.moduleAccess?.find((item: any) => item.moduleId === parameters.moduleId && item.collectionId === parameters.collectionId);
            if (!access) throw new Error(`This node has no access to ${parameters.moduleId}/${parameters.collectionId}.`);
            const result = await getDataRecord(dataStore, parameters, { capabilities: access.capabilities, views: access.views });
            return { content: [{ type: "text", text: result ? JSON.stringify(result, null, 2) : "Record not found." }], details: result };
          },
        });
        }
        if (agent?.tools?.includes("rp_data_resolve")) {
        workerPi.registerTool({
          name: "rp_data_resolve",
          label: "Resolve RP data identity",
          description: "Resolve one registered ID, display name, or alias within this node's authorized collections.",
          parameters: Type.Object({ value: Type.String() }),
          async execute(_id: string, parameters: any) {
            const matches = (await dataStore.resolveIdentity(parameters.value)).filter((entry: any) => {
              const access = node.moduleAccess?.find((item: any) => item.moduleId === entry.moduleId && item.collectionId === entry.collectionId);
              return access && capabilityAllows(dataStore.module(entry.moduleId).contract, access.capabilities, { collectionId: entry.collectionId, action: "query" });
            });
            return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }], details: matches };
          },
        });
        }
        if (agent?.tools?.includes("rp_data_submit")) {
        workerPi.registerTool({
          name: "rp_data_submit",
          label: "Submit RP data output",
          description: "Submit one declared unified-change-batch output before node end.",
          parameters: Type.Object({ output: Type.String() }),
          async execute(_id: string, parameters: any) {
            const output = node.outputs?.[parameters.output];
            if (!output || output.format !== "unified-change-batch") throw new Error(`Node output ${parameters.output} is not a declared unified change batch.`);
            const batch = JSON.parse(await readFile(resolve(nodeWorkspace, output.path), "utf8"));
            const receipt = await executeDataBatch(dataStore, batch, { access: node.moduleAccess, allowBestEffort: node.dataCommit?.allowBestEffort === true, context: { initiatorKind: node.type === "code" ? "code" : "agent", initiatorId: agent?.id || node.id, workflowId: workflow.id, workflowRunId: run.id, nodeId: node.id, binding: { turn: run.turn || 0, messageId: rpRun?.assistantMessageId || null } } });
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
      extensionFactories: [...(profile?.tailPrompt ? [{
        name: "rp-model-tail",
        hidden: true,
        factory(workerPi: any) {
          workerPi.on("context", (event: any) => ({
            messages: [...event.messages, { role: "user", content: profile.tailPrompt, timestamp: Date.now() }],
          }));
        },
      }] : []), dataToolFactory],
    });
    await loader.reload();
    const permittedBuiltins = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell"]);
    const permittedDataTools = new Set(["rp_data_query", "rp_data_get", "rp_data_resolve", "rp_data_submit"]);
    const tools = (agent?.tools || []).filter((name: string) => permittedBuiltins.has(name) || permittedDataTools.has(name));
    const { session } = await sdk.createAgentSession({
      cwd: nodeWorkspace,
      modelRuntime: (active.context.modelRegistry as any).runtime,
      model,
      ...(profile?.thinking && profile.thinking !== "off" ? { thinkingLevel: profile.thinking } : {}),
      ...(tools.length ? { tools } : { noTools: "all" }),
      resourceLoader: loader,
      sessionManager: sdk.SessionManager.inMemory(nodeWorkspace),
    });
    try {
      const userPrompt = prompt.contextMessages.join("\n\n") || "Execute this workflow node and return its result.";
      await session.prompt(userPrompt, { expandPromptTemplates: false, source: "extension" });
      const assistant = [...session.messages].reverse().find((message: any) => message.role === "assistant");
      const content = messageText(assistant);
      if (!content) throw new Error("Workflow agent returned no text output.");
      let output: any = content;
      if (agent?.outputMode === "json") {
        const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        try { output = JSON.parse(normalized); }
        catch { throw new Error(`Workflow Agent ${agent.id} must return valid JSON.`); }
      }
      return {
        output,
        assistantMessageId: rpRun?.assistantMessageId || null,
        usage: tokenUsageFromMessages(session.messages),
        processRecord: lastAgentExchange(session.messages),
        context: {
          mode: node.context.mode,
          nodePrompt: node.prompt || node.description || null,
          customContext: customContext || null,
        },
      };
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      (wrapped as any).usage = tokenUsageFromMessages(session.messages);
      throw wrapped;
    } finally {
      session.dispose();
    }
  }

  async function startBridge(cardArgument: string, context: ExtensionContext) {
    await stopBridge();
    const cardDirectory = resolveCardDirectory(context.cwd, cardArgument.trim());
    const manifest = JSON.parse(await readFile(resolve(cardDirectory, "manifest.json"), "utf8"));
    if (!manifest.id || !manifest.name) throw new Error("Card manifest must contain id and name.");
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
    const configStore = createRpConfigStore(context.cwd, cardDirectory);
    await Promise.all([
      mkdir(commonSettingsDirectory, { recursive: true }),
      mkdir(avatarsDirectory, { recursive: true }),
      configStore.ensure(),
    ]);
    const commonSettings = normalizeCommonSettings(await readOrCreateJson<CommonSettings>(commonSettingsPath, defaultCommonSettings));
    await writeFile(commonSettingsPath, `${JSON.stringify(commonSettings, null, 2)}\n`, "utf8");
    const cardSettings = await readOrCreateJson<CardSettings>(cardSettingsPath, {
      schemaVersion: 1,
      cardId: manifest.id,
      settings: {},
    });
    const stableCardContext = await readCardContextFiles(cardDirectory, manifest.fixed_context, "fixed_context");
    const primaryCharacterContext = await readCardContextFiles(cardDirectory, manifest.primary_characters, "primary_characters");
    const featureModules = await readFeatureModules(cardDirectory, manifest.feature_modules);
    const contextProcessors = await readContextProcessors(cardDirectory, manifest.context_processors, featureModules);
    const messagePolicy = await readMessageRetrievalPolicy(cardDirectory, manifest.context_policy);
    const messageSkill = await readMessageRetrievalSkill(cardDirectory, manifest.context_skill, messagePolicy);
    if (!cardSettings.settings || typeof cardSettings.settings !== "object" || Array.isArray(cardSettings.settings)) {
      cardSettings.settings = {};
    }
    cardSettings.settings.featureModules = normalizeModuleDisplaySettings(cardSettings.settings.featureModules, featureModules);
    if (typeof cardSettings.settings.activeWorkflowId !== "string") cardSettings.settings.activeWorkflowId = "standard-rp";
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
      primaryCharacterContext,
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
      workflowEngine: null as any,
      activeWorkflowId: cardSettings.settings.activeWorkflowId as string,
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
        await active.workflowEngine.start(candidate, {
          cardId: active.cardId,
          chatId: active.recordId,
          turn: parentRun.turn,
          visibleThroughTurn: candidate.kind === "global-background" ? parentRun.turn : null,
          trigger: event,
          payload: {
            parentRunId: parentRun.id,
            frozenContext: authoritativeTranscript(active, active.messages.filter(message => message.binding.turn <= parentRun.turn)),
          },
        }).catch(error => context.ui.notify(`Background workflow ${candidate.id} was not started: ${(error as Error).message}`, "warning"));
      }
    };

    active.workflowEngine = new RpWorkflowEngine({
      policy: await configStore.getRuntimePolicy(),
      resolveAgent: async (agentId: string | null) => agentId ? (await configStore.getAgent(agentId)).effective : null,
      resolveModel: async (modelId: string) => (await configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === modelId) || null,
      executor: executeWorkflowNode,
      beforeNodeComplete: async ({ workflow, run, node, result }: any) => {
        if (!active?.sessionDirectory || active.recordId !== run.chatId) throw new Error("The workflow data commit has no active RP chat.");
        const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: active.featureModules.map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory })) });
        return finalizeNodeData({ sessionDirectory: active.sessionDirectory, store, workflow, run, node, result });
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
        const paths = await ensureWorkflowWorkspace(workflowWorkspacePaths(active.sessionDirectory, workflow.id, run.id, workflow.kind));
        await serializeWorkflowWrite(() => appendWorkflowRunRecord(paths.workflowRuns, run));
        if (["completed", "failed", "cancelled"].includes(run.status)) await cleanupArtifacts(active.sessionDirectory, { type: "run", workflowRunId: run.id });
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
            await dispatchWorkflowEvent({ type: "node", workflowId: workflow.id, nodeId: state.id, runId: run.id }, run);
          }
        }
        const completeKey = `${run.id}:workflow:completed`;
        if (run.status === "completed" && !deliveredWorkflowEvents.has(completeKey)) {
          deliveredWorkflowEvents.add(completeKey);
          await dispatchWorkflowEvent({ type: "after-workflow", workflowId: workflow.id, runId: run.id }, run);
        }
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
        if (["completed", "failed", "cancelled"].includes(run.status)) continue;
        try {
          const workflow = await configStore.getWorkflow(run.workflowId);
          for (const state of Object.values(run.nodes || {}) as any[]) {
            if (state.status === "completed") deliveredWorkflowEvents.add(`${run.id}:node:${state.id}:completed`);
          }
          if (workflow.kind === "foreground" && !rpRun && typeof run.payload?.currentInput === "string") {
            active.pending = true;
            rpRun = {
              cardId: active.cardId,
              recordId: active.recordId!,
              submittedText: run.payload.currentInput,
              submittedSequence: Number.isSafeInteger(run.payload.userSequence) ? run.payload.userSequence : active.messages.at(-1)?.sequence || 0,
              assistantContent: "",
              automaticSelections: {}, agentQueries: [], agentSources: [], processorSelections: [],
              contextContent: null, phase: "narrative", assistantMessageId: null,
              workflowRunId: run.id, workflowNarrativeNodeId: workflow.nodes.find((node: any) => node.type === "narrative")?.id || null,
              resolveNarrative: null, rejectNarrative: null,
              baseModel: active.context.model,
            };
          }
          await active.workflowEngine.restore(workflow, run);
        } catch (error) {
          context.ui.notify(`Workflow run ${run.id} could not be restored: ${(error as Error).message}`, "warning");
        }
      }
    };
    await restoreWorkflowRuns(active.sessionDirectory);

    let bridge;
    try {
      bridge = await webModule.startWebBridge({
        cardDirectory,
        bridge: {
          getState: async () => ({
            sessionId: active?.recordId || null,
            openingId: active?.openingId || null,
            playerName: active?.playerName || "玩家",
            messages: active ? recordsToWebMessages(active.messages) : [],
            busy: active ? active.pending || !active.context.isIdle() : false,
          }),
          getSettings: async () => ({
            common: active?.commonSettings || defaultCommonSettings,
            card: active?.cardSettings || { schemaVersion: 1, cardId: manifest.id, settings: {} },
          }),
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
          listWorkflows: async () => ({
            activeWorkflowId: active?.activeWorkflowId || "standard-rp",
            workflows: await configStore.listWorkflows(),
          }),
          listWorkflowRuns: async () => {
            if (!active?.sessionDirectory) return { runs: [] };
            const persisted = await readFile(resolve(active.sessionDirectory, "workflow", "runs.jsonl"), "utf8").then(text => text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
              throw error;
            });
            const latest = new Map<string, any>();
            for (const run of persisted) latest.set(run.id, { ...run, live: false });
            for (const run of active.workflowEngine.snapshot()) latest.set(run.id, { ...run, live: true });
            return { runs: [...latest.values()].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))) };
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
            if (!active.recordId || !active.sessionDirectory) throw httpError(409, "Start or resume a chat before running a background workflow.");
            const completedThrough = latestCompletedTurn(active);
            const run = await active.workflowEngine.start(workflow, {
              cardId: active.cardId,
              chatId: active.recordId,
              turn: workflow.kind === "global-background" ? completedThrough : active.turn,
              visibleThroughTurn: workflow.kind === "global-background" ? completedThrough : null,
              trigger: { type: "manual" },
              payload: {
                ...(value?.payload || {}),
                frozenContext: authoritativeTranscript(active, active.messages.filter(message => message.binding.turn <= (workflow.kind === "global-background" ? completedThrough : active!.turn))),
              },
            });
            return { activated: workflow.id, run };
          },
          updateWorkflowNodeBinding: async (workflowId: string, nodeId: string, value: any) => {
            const workflow = await configStore.copyWorkflowToCard(workflowId);
            const node = workflow.nodes.find((item: any) => item.id === nodeId);
            if (!node) throw httpError(404, "Workflow node was not found.");
            node.agentId = typeof value.agentId === "string" && value.agentId ? value.agentId : null;
            node.modelId = typeof value.modelId === "string" && value.modelId ? value.modelId : null;
            return configStore.saveCardWorkflow(workflow);
          },
          retryWorkflowNode: async (runId: string, nodeId: string, value: any) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const run = active.workflowEngine.snapshot().find((item: any) => item.id === runId);
            if (!run) throw httpError(404, "Workflow run was not found.");
            const workflow = await configStore.copyWorkflowToCard(run.workflowId);
            const node = workflow.nodes.find((item: any) => item.id === nodeId);
            if (!node) throw httpError(404, "Workflow node was not found.");
            if (value.saveAsCardDefault === true) {
              node.modelId = value.modelId;
              await configStore.saveCardWorkflow(workflow);
            }
            const retried = await active.workflowEngine.retry(runId, nodeId, value.modelId, { saveOverride: value.saveAsCardDefault === true });
            return retried;
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
                  const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: active.featureModules.map(item => ({ contract: item.contract, moduleDirectory: item.moduleDirectory })) });
                  const collections: Record<string, unknown> = {};
                  for (const collectionId of Object.keys(module.contract.collections)) collections[collectionId] = await store.readCollection(module.id, collectionId);
                  data = { collections };
                  available = true;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    dataError = "模块记录暂时无法解析；完成写入后页面会自动重试。";
                  }
                }
              }
              const view = await readFile(module.viewPath, "utf8").then(JSON.parse);
              modules.push({
                id: module.id,
                title: module.title,
                description: module.description,
                displayOrder: module.displayOrder,
                available,
                error: dataError,
                view,
                data,
              });
            }
            return { sessionId: active.recordId, modules };
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
              const store = new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: active.featureModules.map(item => ({ contract: item.contract, moduleDirectory: item.moduleDirectory })) });
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
            await writeFile(commonSettingsPath, `${JSON.stringify(active.commonSettings, null, 2)}\n`, "utf8");
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
            if (active.pending || !active.context.isIdle()) throw httpError(409, "Wait for the current Pi response before editing messages.");
            const index = active.messages.findIndex(message => message.sequence === sequence);
            if (index === -1) throw httpError(404, "Saved message was not found.");
            const previous = active.messages[index];
            const updated = reviseRecord(previous, { ...previous.data, content }) as RecordEnvelope;
            active.messages[index] = updated;
            await rewriteMessages();
            await updateMetadata();
            return {
              sessionId: active.recordId,
              openingId: active.openingId,
              playerName: active.playerName,
              messages: recordsToWebMessages(active.messages),
              busy: active.pending || !active.context.isIdle(),
            };
          },
          deleteMessage: async (sequence: number) => {
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "There is no active saved chat to edit.");
            if (active.pending || !active.context.isIdle()) throw httpError(409, "Wait for the current Pi response before deleting messages.");
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
            return {
              sessionId: active.recordId,
              openingId: active.openingId,
              playerName: active.playerName,
              messages: recordsToWebMessages(active.messages),
              busy: active.pending || !active.context.isIdle(),
            };
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

            return {
              sessionId: active.recordId,
              openingId: active.openingId,
              playerName: active.playerName,
              messages: recordsToWebMessages(active.messages),
              busy: !active.context.isIdle(),
            };
          },
          selectOpening: async (opening: any) => {
          if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
          if (active.openingId) {
            return {
              sessionId: active.recordId,
              openingId: active.openingId,
              playerName: active.playerName,
              messages: recordsToWebMessages(active.messages),
              busy: active.pending || !active.context.isIdle(),
            };
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
          });
          await updateMetadata();
          return {
            sessionId: active.recordId,
            openingId: active.openingId,
            playerName: active.playerName,
            messages: recordsToWebMessages(active.messages),
            busy: !active.context.isIdle(),
          };
          },
          submitInput: async (content: string) => {
          if (!active?.openingId) throw httpError(409, "Select an opening first.");
          if (active.pending || !active.context.isIdle()) throw httpError(409, "Pi is still processing the previous message.");
          for (const run of active.workflowEngine.snapshot()) {
            if (run.kind !== "turn-background" || ["completed", "failed", "cancelled"].includes(run.status)) continue;
            const workflow = await active.configStore.getWorkflow(run.workflowId);
            const blocking = workflow.nodes.some((node: any) => node.blockNextTurn && !["completed", "skipped", "failed", "cancelled"].includes(run.nodes[node.id]?.status));
            if (blocking) throw httpError(409, `Background workflow ${workflow.title} must finish before the next player turn.`);
          }
          await ensureActiveRecord();
          await cleanupArtifacts(active.sessionDirectory!, { type: "turn", turn: active.turn + 1 });
          active.turn += 1;
          active.pending = true;
          await appendMessage({
            sequence: active.messages.length,
            turn: active.turn,
            role: "user",
            kind: "message",
            content,
            createdAt: new Date().toISOString(),
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
            const workflowRunId = `workflow-${randomUUID()}`;
            rpRun.workflowRunId = workflowRunId;
            await active.workflowEngine.start(workflow, {
              id: workflowRunId,
              cardId: active.cardId,
              chatId: active.recordId,
              turn: active.turn,
              trigger: { type: "player-input" },
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
            await writeFile(commonSettingsPath, `${JSON.stringify(active.commonSettings, null, 2)}\n`, "utf8");
            await updateMetadata();
            return {
              sessionId: active.recordId,
              openingId: active.openingId,
              playerName: active.playerName,
              messages: recordsToWebMessages(active.messages),
              busy: active.pending || !active.context.isIdle(),
              settings: active.commonSettings,
            };
          },
          deleteUserProfile: async (playerName: string) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            const { settings, removed, activeChanged } = removeSavedUserProfile(active.commonSettings, playerName);
            active.commonSettings = settings;
            if (activeChanged) {
              active.playerName = settings.user.playerName;
              active.playerDescription = settings.user.description;
            }
            await writeFile(commonSettingsPath, `${JSON.stringify(active.commonSettings, null, 2)}\n`, "utf8");
            if (removed.avatar && !settings.user.savedProfiles.some(profile => profile.avatar === removed.avatar)) {
              await rm(resolveAvatarFile(commonSettingsDirectory, removed.avatar), { force: true }).catch(error => {
                console.warn(`Could not remove deleted player avatar ${removed.avatar}:`, (error as Error).message);
              });
            }
            await updateMetadata();
            return {
              sessionId: active.recordId,
              openingId: active.openingId,
              playerName: active.playerName,
              messages: recordsToWebMessages(active.messages),
              busy: active.pending || !active.context.isIdle(),
              settings: active.commonSettings,
              deletedPlayerName: removed.name,
            };
          },
          updateSystemSettings: async ({ fontSize }: { fontSize: number }) => {
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            active.commonSettings.system.fontSize = fontSize;
            await writeFile(commonSettingsPath, `${JSON.stringify(active.commonSettings, null, 2)}\n`, "utf8");
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
    return { entry, node, store: new RpDataStore({ sessionDirectory: active.sessionDirectory, modules: active.featureModules.map(module => ({ contract: module.contract, moduleDirectory: module.moduleDirectory })) }) };
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
      const result = await queryData(store, parameters, {
        capabilities: access.capabilities,
        views: access.views,
        runtimeLimit: 20,
        runtimeCharacters: 6000,
        nodeLimit: access.queryBudget?.maxRecords || 20,
        nodeCharacters: access.queryBudget?.maxCharacters || 6000,
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
      const result = await getDataRecord(store, parameters, { capabilities: access.capabilities, views: access.views });
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
      const matches = (await store.resolveIdentity(parameters.value)).filter((entry: any) => {
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
      const receipt = await executeDataBatch(store, batch, {
        access: node.moduleAccess,
        allowBestEffort: node.dataCommit?.allowBestEffort === true,
        context: { initiatorKind: "agent", initiatorId: node.agentId || node.id, workflowId: entry.workflow.id, workflowRunId: entry.run.id, nodeId: node.id, binding: { turn: entry.run.turn || 0, messageId: rpRun?.assistantMessageId || null } },
      });
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
  pi.on("before_agent_start", async event => {
    if (!active?.pending || !rpRun) return;
    if (active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) return;
    if (rpRun.phase !== "narrative" || event.prompt.trim() !== rpRun.submittedText.trim()) return;
    return {
      systemPrompt: [
        event.systemPrompt,
          rpRun.modelHeadPrompt,
          rpRun.nodeAgentPrompt,
        await fixedRpContext(active),
        messageRetrievalFixedContext(active),
        featureModuleFixedContext(active),
        rpRun.workflowNodePrompt,
      ].join("\n\n"),
    };
  });

  pi.on("context", async event => {
    if (!active?.pending || !rpRun) return;
    if (active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) return;

    if (rpRun.phase !== "narrative") return;

    let boundary = -1;
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const message = event.messages[index];
      if (message.role === "user" && messageText(message) === rpRun.submittedText.trim()) {
        boundary = index;
        break;
      }
    }
    if (boundary === -1) return;

    if (rpRun.contextContent === null) {
      const workflowRun = rpRun.workflowRunId
        ? active.workflowEngine.snapshot().find((run: any) => run.id === rpRun!.workflowRunId)
        : null;
      const workflowDefinition = workflowRun ? await active.configStore.getWorkflow(workflowRun.workflowId) : null;
      const narrativeNode = workflowDefinition?.nodes.find((node: any) => node.id === rpRun!.workflowNarrativeNodeId);
      const upstreamIds = narrativeNode
        ? new Set(narrativeNode.context.fromNodes.length ? narrativeNode.context.fromNodes : narrativeNode.dependsOn)
        : new Set();
      const upstreamOutputs = workflowRun && narrativeNode?.context.mode !== "fixed"
        ? Object.values(workflowRun.nodes).filter((state: any) => upstreamIds.has(state.id) && state.status === "completed" && state.output !== null)
        : [];
      rpRun.contextContent = [
        "# Web RP context for this turn",
        await buildDynamicProcessorContext(active, rpRun),
        await buildAutomaticContext(active, rpRun),
        upstreamOutputs.length ? `# Completed workflow-node outputs\n${JSON.stringify(upstreamOutputs, null, 2)}` : "",
      ].join("\n\n");
      await writeContextReceipt(active, rpRun);
    }
    const authoritativeContext = {
      role: "custom" as const,
      customType: "pi-rp-authoritative-context",
      content: rpRun.contextContent,
      display: false,
      details: {
        cardId: active.cardId,
        sessionId: active.recordId,
        userSequence: rpRun.submittedSequence,
      },
      timestamp: Date.now(),
    };

    return {
      messages: [
        authoritativeContext,
        event.messages[boundary],
        ...event.messages.slice(boundary + 1),
        ...(rpRun.modelTailPrompt ? [{
          role: "custom" as const,
          customType: "pi-rp-model-tail",
          content: rpRun.modelTailPrompt,
          display: false,
          details: { modelId: "workflow-selected" },
          timestamp: Date.now(),
        }] : []),
      ],
    };
  });

  pi.on("agent_end", async event => {
    if (!active?.pending || !rpRun) return;
    if (active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) return;
    if ((event as any).willRetry) return;
    const nodeUsage = tokenUsageFromMessages(event.messages, rpRun.phaseStartedAt || 0);
    const nodeProcessRecord = lastAgentExchange(event.messages, rpRun.phaseStartedAt || 0);
    if (rpRun.phase !== "narrative") return;
    const assistant = [...event.messages].reverse().find((message: any) => message.role === "assistant");
    const content = messageText(assistant);
    if (!content) return;
    rpRun.assistantContent = content;
    const assistantRecord = await appendMessage({
      sequence: active.messages.length,
      turn: active.turn,
      role: "assistant",
      kind: "message",
      content,
      createdAt: new Date().toISOString(),
    });
    if (!assistantRecord) return;
    rpRun.assistantMessageId = assistantRecord.id;
    await updateMetadata();
    const resolveNarrative = rpRun.resolveNarrative;
    rpRun.resolveNarrative = null;
    rpRun.rejectNarrative = null;
    resolveNarrative?.({ output: content, usage: nodeUsage, processRecord: nodeProcessRecord });
    rpRun.phase = "done";
  });

  pi.on("agent_settled", async () => {
    const settledRun = rpRun;
    if (!settledRun) return;
    let keepForWorkflowRetry = false;
    try {
      if (settledRun.rejectNarrative) {
        keepForWorkflowRetry = true;
        const rejectNarrative = settledRun.rejectNarrative;
        settledRun.resolveNarrative = null;
        settledRun.rejectNarrative = null;
        rejectNarrative(new Error("The narrative agent settled without producing a saved response."));
      }
      if (!active?.pending) return;
      if (active.cardId !== settledRun.cardId || active.recordId !== settledRun.recordId) return;
      await writeContextReceipt(active, settledRun);
      if (settledRun.baseModel && (active.context.model?.provider !== settledRun.baseModel.provider || active.context.model?.id !== settledRun.baseModel.id)) {
        await pi.setModel(settledRun.baseModel);
      }
    } finally {
      if (keepForWorkflowRetry) return;
      if (active?.cardId === settledRun.cardId && active.recordId === settledRun.recordId) {
        active.pending = false;
      }
      if (rpRun === settledRun) rpRun = null;
    }
  });

  pi.on("session_before_switch", stopBridge);
  pi.on("session_shutdown", stopBridge);
}
