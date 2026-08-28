import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  buildCatalog,
  createRecordEnvelope,
  formatCatalog,
  formatRecords,
  normalizeRetrievalPolicy,
  parseRecordLines,
  reviseRecord,
  selectRecords,
  toRecordLines,
  validateRecordEnvelope,
} from "../lib/rp-records.mjs";
import {
  applyVariableOperations,
  createVariableDraft,
  mergeVariableState,
  projectVariableState,
  renderVariableTemplates,
  sameVariableState,
  updateVariableDraft,
  variableValueAt,
} from "../lib/rp-variables.mjs";
import {
  runContextProcessor,
  validateContextProcessorDefinition,
} from "../lib/rp-context-processors.mjs";

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
  schemaVersion: 1;
  code: { profile: "default" | "custom"; selector: Record<string, any> };
  agent: { mode: "disabled" | "append" | "override"; fallback: "code"; onNotTriggered: "code" | "empty"; maxRecords: number };
  catalog: { codeProfile: "default"; agentMode: "disabled" | "append" | "override" };
};

type ModuleStorage = {
  schemaVersion: 2;
  kind: "record-log" | "snapshot" | "hybrid";
  contextSource: "records" | "snapshot";
  records: null | { file: string; initialFile: string; schemaFile: string };
  snapshot: null | { file: string; initialFile: string; schemaFile: string };
  catalogFile: string;
  retrievalPolicyFile: string;
  engine: null | { kind: "variables"; configFile: string };
};

type VariableRuntime = {
  schemaVersion: 1;
  schemaPath: string;
  defaultInitialPath: string;
  openingInitialPaths: Record<string, string>;
  bindingsPath: string;
  bindings: Record<string, { path?: string; paths?: string[]; shape: "scalar" | "object" | "subtree"; missing: "error" | "omit" | "empty" }>;
  normalizePath: string | null;
  afterUpdatePath: string | null;
  alwaysForNarrative: string[];
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
  catalogUpdates: Array<Record<string, unknown>>;
  agentSources: string[];
  processorSelections: Array<{ id: string; include: string[]; error?: string }>;
  contextContent: string | null;
  phase: "narrative" | "variable-update" | "done";
  assistantMessageId: string | null;
  variableModuleId: string | null;
  variableFinalized: boolean;
};

type FeatureModule = {
  id: string;
  title: string;
  description: string;
  surface: "frontend" | "background";
  contextOrder: number;
  displayOrder: number;
  view: { schemaVersion: 1; regions: unknown[] };
  viewPath: string;
  moduleDirectory: string;
  storage: ModuleStorage;
  retrievalPolicy: RetrievalPolicy;
  skillPath: string;
  skillDescription: string;
  initialRecords: RecordEnvelope[];
  initialSnapshot: RecordEnvelope | null;
  variable: VariableRuntime | null;
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
    "Apply this player profile before loading or interpreting the single-card primary character profile. Preserve player agency: this profile defines stable identity and authored traits, not unchosen actions, thoughts, feelings, or consent.",
  ].join("\n\n");
}

function activeVariableModule(active: ActiveBridge) {
  return active.featureModules.find(module => module.variable) || null;
}

async function currentVariableRecord(active: ActiveBridge, module: FeatureModule) {
  if (!active.sessionDirectory || !module.storage.snapshot) return null;
  return readFile(resolve(active.sessionDirectory, "modules", module.id, module.storage.snapshot.file), "utf8")
    .then(text => validateRecordEnvelope(JSON.parse(text)) as RecordEnvelope)
    .catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
}

async function fixedRpContext(active: ActiveBridge) {
  const module = activeVariableModule(active);
  const record = module ? await currentVariableRecord(active, module) : null;
  const render = (text: string) => module?.variable && record
    ? renderVariableTemplates(text, record.data.state, module.variable.bindings)
    : text;
  return [
    "# Fixed card context",
    render(active.stableCardContext),
    playerProfileContext(active.playerName, active.playerDescription),
    "# Primary card character profiles",
    render(active.primaryCharacterContext) || "No dedicated primary-character profile is defined for this card.",
  ].join("\n\n");
}

function featureModuleFixedContext(active: ActiveBridge) {
  if (active.featureModules.length === 0 || !active.sessionDirectory) return "";
  return [
    "# Card feature modules (fixed routing rules)",
    "Feature-module data is part of this chat's persistent state. Modules appear here in the card author's context order; frontend display choices never change this order, and background modules follow frontend modules. Every module prompt is owned by its module skill. Read the module skill before interpreting, querying, or changing its records. Do not edit display specifications or binding metadata.",
    ...active.featureModules.map(module => {
      const sessionModulePath = relative(active.context.cwd, resolve(active.sessionDirectory!, "modules", module.id)).replaceAll("\\", "/");
      return [
        `## ${module.title} (${module.id})`,
        `Session module directory: ${sessionModulePath}`,
        `Module skill: ${relative(active.context.cwd, module.skillPath).replaceAll("\\", "/")}`,
        `Retrieval mode: code=${module.retrievalPolicy.code.profile}; agent=${module.retrievalPolicy.agent.mode}`,
        module.variable ? `Narrative fixed variable references: ${module.variable.alwaysForNarrative.length ? module.variable.alwaysForNarrative.join(", ") : "none"}. Other variables are queried by exact binding or JSON Pointer according to the module skill. The post-narrative update task always receives the complete effective variable state.` : "",
        module.skillDescription,
      ].filter(Boolean).join("\n");
    }),
  ].join("\n\n");
}

function messageRetrievalFixedContext(active: ActiveBridge) {
  if (!active.messageSkillPath) return "";
  return [
    "# Card message-record retrieval skill",
    `Skill: ${relative(active.context.cwd, active.messageSkillPath).replaceAll("\\", "/")}`,
    `Retrieval mode: code=${active.messagePolicy.code.profile}; agent=${active.messagePolicy.agent.mode}; catalog-agent=${active.messagePolicy.catalog.agentMode}`,
    active.messageSkillDescription,
    "Read this skill before querying message records or enriching their catalog.",
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

async function readContinuityContext(sessionDirectory: string | null) {
  if (!sessionDirectory) return "";
  const sections = [];
  for (const fileName of ["current-scene.md", "chronicle.md", "world-changes.md"]) {
    const content = await readFile(resolve(sessionDirectory, fileName), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    if (content.trim()) sections.push(`## ${fileName}\n${content.trim()}`);
  }
  return sections.join("\n\n");
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
  const fields = ["schemaVersion", "source", "code", "agent", "catalog"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) {
    throw new Error(`Retrieval policy ${expectedSource} must use the exact schemaVersion 1 field set.`);
  }
  if (value.schemaVersion !== 1 || value.source !== expectedSource) throw new Error(`Retrieval policy source must be ${expectedSource}.`);
  if (!value.code || !["default", "custom"].includes(value.code.profile)) throw new Error(`Retrieval policy ${expectedSource} has an invalid code profile.`);
  if (value.code.profile === "default" && Object.keys(value.code).length !== 1) throw new Error(`Default code policy ${expectedSource} must not define a selector.`);
  if (value.code.profile === "custom" && (Object.keys(value.code).length !== 2 || !value.code.selector || typeof value.code.selector !== "object")) {
    throw new Error(`Custom code policy ${expectedSource} requires exactly one selector.`);
  }
  if (value.code.profile === "custom") selectRecords([], value.code.selector);
  if (!value.agent || Object.keys(value.agent).length !== 4 || !["disabled", "append", "override"].includes(value.agent.mode) || value.agent.fallback !== "code" || !["code", "empty"].includes(value.agent.onNotTriggered) || !Number.isSafeInteger(value.agent.maxRecords) || value.agent.maxRecords < 1) {
    throw new Error(`Retrieval policy ${expectedSource} has an invalid agent policy.`);
  }
  if (!value.catalog || Object.keys(value.catalog).length !== 2 || value.catalog.codeProfile !== "default" || !["disabled", "append", "override"].includes(value.catalog.agentMode)) {
    throw new Error(`Retrieval policy ${expectedSource} has an invalid catalog policy.`);
  }
  return normalizeRetrievalPolicy(value, sourceKind) as RetrievalPolicy;
}

async function readVariableRuntime(moduleDirectory: string, configPath: string, moduleId: string): Promise<VariableRuntime> {
  const path = resolveFeatureModuleChild(moduleDirectory, configPath, `${moduleId}.engine.configFile`);
  const config = JSON.parse(await readFile(path, "utf8"));
  const fields = ["schemaVersion", "schemaFile", "initial", "bindingsFile", "hooks", "context"];
  if (!config || Object.keys(config).length !== fields.length || fields.some(field => !(field in config)) || config.schemaVersion !== 1) {
    throw new Error(`Variable runtime ${moduleId} must use the exact schemaVersion 1 field set.`);
  }
  if (!config.initial || Object.keys(config.initial).sort().join(",") !== "defaultFile,openingFiles" || !config.initial.openingFiles || typeof config.initial.openingFiles !== "object" || Array.isArray(config.initial.openingFiles)) {
    throw new Error(`Variable runtime ${moduleId} has an invalid initial-state specification.`);
  }
  if (!config.hooks || Object.keys(config.hooks).sort().join(",") !== "afterUpdateFile,normalizeFile") {
    throw new Error(`Variable runtime ${moduleId} has an invalid hooks specification.`);
  }
  if (!config.context || Object.keys(config.context).length !== 1 || !Array.isArray(config.context.alwaysForNarrative) || config.context.alwaysForNarrative.some((item: unknown) => typeof item !== "string")) {
    throw new Error(`Variable runtime ${moduleId} has an invalid context specification.`);
  }
  const schemaPath = resolveFeatureModuleChild(moduleDirectory, config.schemaFile, `${moduleId}.variable.schemaFile`);
  const defaultInitialPath = resolveFeatureModuleChild(moduleDirectory, config.initial.defaultFile, `${moduleId}.variable.initial.defaultFile`);
  await Promise.all([readFile(schemaPath, "utf8").then(JSON.parse), readFile(defaultInitialPath, "utf8").then(JSON.parse)]);
  const openingInitialPaths: Record<string, string> = {};
  for (const [openingId, openingFile] of Object.entries(config.initial.openingFiles)) {
    openingInitialPaths[openingId] = resolveFeatureModuleChild(moduleDirectory, openingFile, `${moduleId}.variable.initial.openingFiles.${openingId}`);
    await readFile(openingInitialPaths[openingId], "utf8").then(JSON.parse);
  }
  const bindingsPath = resolveFeatureModuleChild(moduleDirectory, config.bindingsFile, `${moduleId}.variable.bindingsFile`);
  const bindingsDocument = JSON.parse(await readFile(bindingsPath, "utf8"));
  if (bindingsDocument?.schemaVersion !== 1 || !bindingsDocument.bindings || typeof bindingsDocument.bindings !== "object" || Array.isArray(bindingsDocument.bindings)) {
    throw new Error(`Variable bindings ${moduleId} must contain schemaVersion 1 and a bindings object.`);
  }
  for (const [id, definition] of Object.entries(bindingsDocument.bindings) as Array<[string, any]>) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || !definition || !["scalar", "object", "subtree"].includes(definition.shape) || !["error", "omit", "empty"].includes(definition.missing)) {
      throw new Error(`Variable binding ${id} in ${moduleId} is invalid.`);
    }
    const hasPath = typeof definition.path === "string";
    const hasPaths = Array.isArray(definition.paths) && definition.paths.every((item: unknown) => typeof item === "string");
    if (hasPath === hasPaths) {
      throw new Error(`Variable binding ${id} must define exactly one of path or paths.`);
    }
  }
  for (const id of config.context.alwaysForNarrative) {
    if (!(id in bindingsDocument.bindings)) throw new Error(`Variable narrative binding is not defined: ${id}`);
  }
  const hookPath = (value: unknown, label: string) => value === null ? null : resolveFeatureModuleChild(moduleDirectory, value, label);
  return {
    schemaVersion: 1,
    schemaPath,
    defaultInitialPath,
    openingInitialPaths,
    bindingsPath,
    bindings: bindingsDocument.bindings,
    normalizePath: hookPath(config.hooks.normalizeFile, `${moduleId}.variable.hooks.normalizeFile`),
    afterUpdatePath: hookPath(config.hooks.afterUpdateFile, `${moduleId}.variable.hooks.afterUpdateFile`),
    alwaysForNarrative: [...config.context.alwaysForNarrative],
  };
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
    const moduleFields = ["schemaVersion", "id", "title", "description", "surface", "contextOrder", "displayOrder", "storageFile", "viewFile", "skillFile"];
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Feature module ${value} must be a JSON object.`);
    }
    const recordFields = Object.keys(record).sort();
    if (moduleFields.length !== recordFields.length || moduleFields.some(field => !recordFields.includes(field))) {
      throw new Error(`Feature module ${value} must use the exact schemaVersion 3 field set.`);
    }
    if (record.schemaVersion !== 3 || typeof record.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(record.id)) {
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
    const viewPath = resolveFeatureModuleChild(moduleDirectory, record.viewFile, `${record.id}.viewFile`);
    const storagePath = resolveFeatureModuleChild(moduleDirectory, record.storageFile, `${record.id}.storageFile`);
    const skillPath = resolveFeatureModuleChild(moduleDirectory, record.skillFile, `${record.id}.skillFile`);
    const [view, storage, skillText] = await Promise.all([
      readFile(viewPath, "utf8").then(JSON.parse),
      readFile(storagePath, "utf8").then(JSON.parse),
      readFile(skillPath, "utf8"),
    ]);
    if (view?.schemaVersion !== 1 || !Array.isArray(view.regions)) {
      throw new Error(`Feature module ${record.id} has an invalid view specification.`);
    }
    const storageFields = ["schemaVersion", "kind", "contextSource", "records", "snapshot", "catalogFile", "retrievalPolicyFile", "engine"];
    if (!storage || Object.keys(storage).length !== storageFields.length || storageFields.some(field => !(field in storage)) || storage.schemaVersion !== 2 || !["record-log", "snapshot", "hybrid"].includes(storage.kind) || !["records", "snapshot"].includes(storage.contextSource)) {
      throw new Error(`Feature module ${record.id} has an invalid storage specification.`);
    }
    if (storage.engine !== null && (!storage.engine || Object.keys(storage.engine).sort().join(",") !== "configFile,kind" || storage.engine.kind !== "variables")) {
      throw new Error(`Feature module ${record.id} has an invalid storage engine.`);
    }
    if (storage.engine?.kind === "variables" && (storage.kind !== "hybrid" || storage.contextSource !== "snapshot")) {
      throw new Error(`Variable module ${record.id} must use hybrid storage with snapshot context.`);
    }
    if ((storage.kind === "record-log" || storage.kind === "hybrid") && !storage.records) throw new Error(`Feature module ${record.id} requires records storage.`);
    if ((storage.kind === "snapshot" || storage.kind === "hybrid") && !storage.snapshot) throw new Error(`Feature module ${record.id} requires snapshot storage.`);
    if (storage.contextSource === "records" && !storage.records) throw new Error(`Feature module ${record.id} contextSource records is unavailable.`);
    if (storage.contextSource === "snapshot" && !storage.snapshot) throw new Error(`Feature module ${record.id} contextSource snapshot is unavailable.`);
    for (const stream of [storage.records, storage.snapshot].filter(Boolean)) {
      if (Object.keys(stream).length !== 3 || !["file", "initialFile", "schemaFile"].every(field => field in stream)) {
        throw new Error(`Feature module ${record.id} storage stream must contain exactly file, initialFile, and schemaFile.`);
      }
      for (const field of ["file", "initialFile", "schemaFile"]) {
        const child = resolveFeatureModuleChild(moduleDirectory, stream[field], `${record.id}.storage.${field}`);
        if (field === "schemaFile") await readFile(child, "utf8").then(JSON.parse);
      }
    }
    const catalogPath = resolveFeatureModuleChild(moduleDirectory, storage.catalogFile, `${record.id}.catalogFile`);
    const retrievalPolicyPath = resolveFeatureModuleChild(moduleDirectory, storage.retrievalPolicyFile, `${record.id}.retrievalPolicyFile`);
    const rawRetrievalPolicy = JSON.parse(await readFile(retrievalPolicyPath, "utf8"));
    const retrievalPolicy = runtimeRetrievalPolicy(rawRetrievalPolicy, `module:${record.id}`, storage.contextSource === "snapshot" ? "snapshot" : "module-records");
    const initialRecordValues = storage.records
      ? JSON.parse(await readFile(resolveFeatureModuleChild(moduleDirectory, storage.records.initialFile, `${record.id}.records.initialFile`), "utf8"))
      : [];
    if (!Array.isArray(initialRecordValues)) throw new Error(`Feature module ${record.id} initial records must be an array.`);
    const initialRecords = initialRecordValues.map((item: unknown) => validateRecordEnvelope(item) as RecordEnvelope);
    if (initialRecords.some(item => item.source !== `module:${record.id}`)) throw new Error(`Feature module ${record.id} initial record source is invalid.`);
    const initialSnapshot = storage.snapshot
      ? validateRecordEnvelope(JSON.parse(await readFile(resolveFeatureModuleChild(moduleDirectory, storage.snapshot.initialFile, `${record.id}.snapshot.initialFile`), "utf8"))) as RecordEnvelope
      : null;
    if (initialSnapshot && initialSnapshot.source !== `module:${record.id}`) throw new Error(`Feature module ${record.id} initial snapshot source is invalid.`);
    const variable = storage.engine?.kind === "variables"
      ? await readVariableRuntime(moduleDirectory, storage.engine.configFile, record.id)
      : null;
    void catalogPath;
    modules.push({
      id: record.id,
      title: record.title.trim(),
      description: record.description.trim(),
      surface: record.surface,
      contextOrder: record.contextOrder,
      displayOrder: record.displayOrder,
      view,
      viewPath,
      moduleDirectory,
      storage,
      retrievalPolicy,
      skillPath,
      skillDescription: parseSkillDescription(skillText, `${record.id}.skillFile`),
      initialRecords,
      initialSnapshot,
      variable,
    });
  }
  if (modules.filter(module => module.variable).length > 1) throw new Error("A card may define only one variable storage engine.");
  return modules.sort((left, right) => {
    const surfaceDifference = Number(left.surface === "background") - Number(right.surface === "background");
    return surfaceDifference || left.contextOrder - right.contextOrder || left.id.localeCompare(right.id);
  });
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
    for (const moduleId of definition.dependencies.modules) {
      if (!moduleIds.has(moduleId)) throw new Error(`Context processor ${definition.id} requires unknown feature module ${moduleId}.`);
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

async function locateCardCover(cardDirectory: string, manifest: any) {
  const candidates = [
    typeof manifest.cover === "string" ? manifest.cover : "",
    "cover.png", "cover.webp", "cover.jpg", "cover.jpeg",
    "source/original.png", "source/original.webp", "source/original.jpg", "source/original.jpeg",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = resolveCardChild(cardDirectory, candidate);
    if (!path) continue;
    try {
      const body = await readFile(path);
      const extension = extname(path).toLowerCase();
      const mimeType = extension === ".png" ? "image/png"
        : extension === ".webp" ? "image/webp"
          : "image/jpeg";
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

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let active: ActiveBridge | null = null;
  let rpRun: RpRun | null = null;

  function publicDraftDirectory(target: ActiveBridge) {
    if (!target.sessionDirectory) throw new Error("The active RP chat has no session directory.");
    return resolve(target.sessionDirectory, "draft");
  }

  function variableDraftPath(target: ActiveBridge) {
    return resolve(publicDraftDirectory(target), "variables.json");
  }

  async function resetPublicDraftDirectory(target: ActiveBridge) {
    const directory = publicDraftDirectory(target);
    const pending = await readFile(resolve(directory, "variables.json"), "utf8").then(JSON.parse).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (pending?.status === "pending") {
      throw httpError(409, "The previous variable update draft is unfinished. Run /rp-vars-resume in Pi and finish it before starting another RP turn.");
    }
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
  }

  async function schemaErrors(module: FeatureModule, state: unknown) {
    if (!module.variable) return [];
    const schema = JSON.parse(await readFile(module.variable.schemaPath, "utf8"));
    return Value.Errors(schema as any, state).map((error: any) => ({
      path: error.instancePath || "",
      attemptedValue: variableValueAt(state, error.instancePath || ""),
      currentValue: null,
      code: `schema_${error.keyword}`,
      message: error.message,
    }));
  }

  async function runVariableHook(path: string | null, exportName: string, args: unknown[]) {
    if (!path) return { state: args[exportName === "normalize" ? 0 : 1], errors: [] };
    const loaded = await import(`${pathToFileURL(path).href}?run=${Date.now()}-${randomUUID()}`);
    const hook = loaded[exportName] || loaded.default;
    if (typeof hook !== "function") throw new Error(`${path} must export ${exportName}().`);
    const result = await hook(...args.map(clone => structuredClone(clone)));
    if (result && typeof result === "object" && !Array.isArray(result) && "state" in result) {
      return { state: structuredClone(result.state), errors: Array.isArray(result.errors) ? result.errors : [] };
    }
    return { state: structuredClone(result), errors: [] };
  }

  async function initializeVariableModulesForOpening(target: ActiveBridge, openingRecord: RecordEnvelope) {
    if (!target.sessionDirectory) return;
    for (const module of target.featureModules.filter(item => item.variable)) {
      const runtime = module.variable!;
      const base = JSON.parse(await readFile(runtime.defaultInitialPath, "utf8"));
      const overlayPath = runtime.openingInitialPaths[target.openingId || ""];
      const overlay = overlayPath ? JSON.parse(await readFile(overlayPath, "utf8")) : {};
      let state = mergeVariableState(base, overlay);
      const normalized = await runVariableHook(runtime.normalizePath, "normalize", [state, { phase: "initialization", openingId: target.openingId }]);
      state = normalized.state;
      const errors = [...normalized.errors, ...await schemaErrors(module, state)];
      if (errors.length) throw new Error(`Variable initialization failed: ${JSON.stringify(errors)}`);
      const record = createRecordEnvelope({
        id: `variable-${randomUUID()}`,
        source: `module:${module.id}`,
        sequence: 0,
        binding: { messageId: openingRecord.id, turn: 0 },
        metadata: { recordType: "variable-snapshot", entityIds: [], tags: ["opening"] },
        data: { state, changedPaths: [], reasons: [], previousSnapshotId: null },
      }) as RecordEnvelope;
      const directory = resolve(target.sessionDirectory, "modules", module.id);
      await writeFile(resolve(directory, module.storage.records!.file), toRecordLines([record]), "utf8");
      await writeFile(resolve(directory, module.storage.snapshot!.file), `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await refreshSourceCatalog(target, `module:${module.id}`, [record]);
    }
  }

  async function beginVariableUpdate(target: ActiveBridge, run: RpRun, assistantRecord: RecordEnvelope) {
    const module = activeVariableModule(target);
    if (!module || !target.sessionDirectory) return false;
    const current = await currentVariableRecord(target, module);
    if (!current) throw new Error(`Variable module ${module.id} has no effective snapshot.`);
    const draft = createVariableDraft({
      turnId: `turn-${target.turn}`,
      moduleId: module.id,
      assistantMessageId: assistantRecord.id,
      userMessage: run.submittedText,
      assistantMessage: run.assistantContent,
      baseRecordId: current.id,
    });
    await mkdir(publicDraftDirectory(target), { recursive: true });
    await writeFile(variableDraftPath(target), `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    run.phase = "variable-update";
    run.assistantMessageId = assistantRecord.id;
    run.variableModuleId = module.id;
    run.contextContent = null;
    pi.sendMessage({
      customType: "pi-rp-variable-update-task",
      content: `The player-visible RP prose for turn ${target.turn} has been saved. Perform the card's post-narrative variable update task now. Read the variable module skill, inspect the complete effective state supplied by the authoritative update context, call rp_variable_update as many times as useful, then call rp_variable_finalize. Do not write another RP response.`,
      display: false,
      details: { cardId: target.cardId, sessionId: target.recordId, turn: target.turn, moduleId: module.id },
    }, { deliverAs: "followUp", triggerTurn: true });
    return true;
  }

  async function variableUpdateContext(target: ActiveBridge, run: RpRun) {
    const module = target.featureModules.find(item => item.id === run.variableModuleId && item.variable);
    if (!module || !target.sessionDirectory) throw new Error("The active variable update module is unavailable.");
    const record = await currentVariableRecord(target, module);
    const draft = JSON.parse(await readFile(variableDraftPath(target), "utf8"));
    return [
      "# Authoritative post-narrative variable update task",
      "The RP prose is already final and player-visible. Update persistent variables from that prose; do not continue or rewrite the story.",
      `Variable module skill: ${relative(target.context.cwd, module.skillPath).replaceAll("\\", "/")}`,
      `Public per-turn draft directory: ${relative(target.context.cwd, publicDraftDirectory(target)).replaceAll("\\", "/")}`,
      "This directory is shared by temporary task work and is cleared before the next RP turn. The variable draft remains pending across interruptions but is not effective context until rp_variable_finalize succeeds.",
      "The complete effective variable state is supplied below. Use the module skill for semantic update rules. Code reports only the variable operation and error that failed; infer any relationships yourself from the complete state and authored rules.",
      `## Current user message\n${draft.userMessage}`,
      `## Saved AI prose\n${draft.assistantMessage}`,
      `## Complete effective variable state\n${JSON.stringify(record?.data.state ?? {}, null, 2)}`,
      `## Existing draft operations\n${JSON.stringify(draft.operations || [], null, 2)}`,
    ].join("\n\n");
  }

  async function ensureFeatureModuleRecords(target: ActiveBridge) {
    if (!target.recordId || !target.sessionDirectory) return;
    for (const module of target.featureModules) {
      const moduleDirectory = resolve(target.sessionDirectory, "modules", module.id);
      await mkdir(moduleDirectory, { recursive: true });
      const binding = {
        schemaVersion: 1,
        cardId: target.cardId,
        sessionId: target.recordId,
        moduleId: module.id,
        storageKind: module.storage.kind,
      };
      await writeFile(resolve(moduleDirectory, "binding.json"), `${JSON.stringify(binding, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      if (module.storage.records) {
        const recordsPath = resolve(moduleDirectory, module.storage.records.file);
        await mkdir(resolve(recordsPath, ".."), { recursive: true });
        await writeFile(recordsPath, toRecordLines(module.initialRecords), { encoding: "utf8", flag: "wx" }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
      }
      if (module.storage.snapshot && module.initialSnapshot) {
        const snapshotPath = resolve(moduleDirectory, module.storage.snapshot.file);
        await mkdir(resolve(snapshotPath, ".."), { recursive: true });
        await writeFile(snapshotPath, `${JSON.stringify(module.initialSnapshot, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        });
      }
      const initialContextRecords = module.storage.contextSource === "snapshot" && module.initialSnapshot
        ? [module.initialSnapshot]
        : module.initialRecords;
      const catalogPath = resolve(moduleDirectory, module.storage.catalogFile);
      await mkdir(resolve(catalogPath, ".."), { recursive: true });
      await writeFile(catalogPath, `${JSON.stringify(buildCatalog(initialContextRecords), null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
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
    for (const module of target.featureModules) {
      const directory = resolve(target.sessionDirectory, "modules", module.id);
      let retainedRecords: RecordEnvelope[] | null = null;
      if (module.storage.records) {
        const path = resolve(directory, module.storage.records.file);
        const records = parseRecordLines(await readFile(path, "utf8")) as RecordEnvelope[];
        const retained = records.filter(record => !record.binding.messageId || !deletedMessageIds.has(record.binding.messageId));
        retainedRecords = retained;
        if (retained.length !== records.length) await writeFile(path, toRecordLines(retained), "utf8");
        if (module.storage.contextSource === "records") await refreshSourceCatalog(target, `module:${module.id}`, retained);
      }
      if (module.storage.snapshot) {
        const path = resolve(directory, module.storage.snapshot.file);
        const snapshot = validateRecordEnvelope(JSON.parse(await readFile(path, "utf8"))) as RecordEnvelope;
        if (snapshot.binding.messageId && deletedMessageIds.has(snapshot.binding.messageId) && module.initialSnapshot) {
          const replacement = module.variable && retainedRecords?.length ? retainedRecords.at(-1)! : module.initialSnapshot;
          await writeFile(path, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
          if (module.storage.contextSource === "snapshot") {
            await refreshSourceCatalog(target, `module:${module.id}`, [replacement]);
          }
        }
      }
    }
  }

  async function readModuleContextRecords(target: ActiveBridge, module: FeatureModule): Promise<RecordEnvelope[]> {
    if (!target.sessionDirectory) return [];
    await ensureFeatureModuleRecords(target);
    const directory = resolve(target.sessionDirectory, "modules", module.id);
    if (module.storage.contextSource === "records" && module.storage.records) {
      return parseRecordLines(await readFile(resolve(directory, module.storage.records.file), "utf8")) as RecordEnvelope[];
    }
    if (module.storage.contextSource === "snapshot" && module.storage.snapshot) {
      const snapshot = validateRecordEnvelope(JSON.parse(await readFile(resolve(directory, module.storage.snapshot.file), "utf8"))) as RecordEnvelope;
      return [snapshot];
    }
    return [];
  }

  async function readModuleProcessorData(target: ActiveBridge, module: FeatureModule) {
    if (!target.sessionDirectory) return { records: [], snapshot: null };
    await ensureFeatureModuleRecords(target);
    const directory = resolve(target.sessionDirectory, "modules", module.id);
    const records = module.storage.records
      ? parseRecordLines(await readFile(resolve(directory, module.storage.records.file), "utf8")) as RecordEnvelope[]
      : [];
    const snapshot = module.storage.snapshot
      ? validateRecordEnvelope(JSON.parse(await readFile(resolve(directory, module.storage.snapshot.file), "utf8"))) as RecordEnvelope
      : null;
    return { records, snapshot };
  }

  async function readSourceRecords(target: ActiveBridge, source: string, run: RpRun): Promise<RecordEnvelope[]> {
    if (source === "messages") return target.messages.filter(record => record.sequence < run.submittedSequence);
    if (!source.startsWith("module:")) throw new Error(`Unknown RP record source: ${source}`);
    const moduleId = source.slice("module:".length);
    const module = target.featureModules.find(item => item.id === moduleId);
    if (!module) throw new Error(`Unknown RP feature module: ${moduleId}`);
    return readModuleContextRecords(target, module);
  }

  function sourcePolicy(target: ActiveBridge, source: string): RetrievalPolicy {
    if (source === "messages") return target.messagePolicy;
    const module = target.featureModules.find(item => `module:${item.id}` === source);
    if (!module) throw new Error(`Unknown RP record source: ${source}`);
    return module.retrievalPolicy;
  }

  function sourceCatalogPath(target: ActiveBridge, source: string) {
    if (!target.sessionDirectory) throw new Error("The active RP chat has no session directory.");
    if (source === "messages") return resolve(target.sessionDirectory, "catalog", "messages.json");
    const module = target.featureModules.find(item => `module:${item.id}` === source);
    if (!module) throw new Error(`Unknown RP record source: ${source}`);
    return resolve(target.sessionDirectory, "modules", module.id, module.storage.catalogFile);
  }

  async function refreshSourceCatalog(target: ActiveBridge, source: string, records: RecordEnvelope[]) {
    if (!target.sessionDirectory) return buildCatalog(records);
    const path = sourceCatalogPath(target, source);
    await mkdir(resolve(path, ".."), { recursive: true });
    const existing = await readFile(path, "utf8").then(JSON.parse).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    const catalog = buildCatalog(records, existing);
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
      catalogUpdates: run.catalogUpdates,
      processors: run.processorSelections,
      unresolvedAgentSources: run.agentSources.filter(source => !run.agentQueries.some(query => query.source === source)),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(resolve(directory, `turn-${String(target.turn).padStart(6, "0")}.json`), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  }

  async function buildDynamicProcessorContext(target: ActiveBridge, run: RpRun) {
    if (target.contextProcessors.length === 0) return "";
    const requiredModuleIds = new Set<string>(target.contextProcessors.flatMap(processor => processor.definition.dependencies.modules as string[]));
    const moduleData: Record<string, unknown> = {};
    for (const moduleId of requiredModuleIds) {
      const module = target.featureModules.find(item => item.id === moduleId);
      if (!module) throw new Error(`Unknown context-processor module dependency: ${moduleId}`);
      moduleData[moduleId] = await readModuleProcessorData(target, module);
    }
    const variableModule = activeVariableModule(target);
    const variableRecord = variableModule ? await currentVariableRecord(target, variableModule) : null;
    const variableState = variableRecord?.data?.state ?? null;
    const available = {
      card: { id: target.cardId, name: target.cardName },
      turn: target.turn,
      currentInput: run.submittedText,
      openingId: target.openingId,
      player: { name: target.playerName, description: target.playerDescription },
      messages: target.messages.filter(record => record.sequence < run.submittedSequence),
      variables: variableState,
      modules: moduleData,
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
          const rendered = variableModule?.variable && variableRecord
            ? renderVariableTemplates(source, variableRecord.data.state, variableModule.variable.bindings)
            : source;
          content.push(`## ${fragment.title}\n${rendered.trim()}`);
        }
        sections.push([
          `# Dynamic card context: ${processor.id}`,
          processor.description,
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
    const sources = ["messages", ...target.featureModules.map(module => `module:${module.id}`)];
    for (const source of sources) {
      const records = await readSourceRecords(target, source, run);
      const policy = sourcePolicy(target, source);
      const featureModule = source.startsWith("module:")
        ? target.featureModules.find(module => `module:${module.id}` === source)
        : null;
      if (featureModule?.variable) {
        const snapshot = records.at(-1);
        const projection = snapshot
          ? projectVariableState(snapshot.data.state, { bindings: featureModule.variable.alwaysForNarrative }, featureModule.variable.bindings)
          : { selected: {}, missing: [] };
        run.automaticSelections[source] = snapshot ? [snapshot.id] : [];
        sections.push([
          `# Fixed narrative variable references: ${source}`,
          JSON.stringify(projection.selected, null, 2),
          projection.missing.length ? `Missing authored references: ${JSON.stringify(projection.missing)}` : "",
        ].filter(Boolean).join("\n"));
        if (policy.agent.mode !== "disabled") {
          run.agentSources.push(source);
          sections.push([
            `# Variable reference catalog: ${source}`,
            `Agent selection mode: ${policy.agent.mode}. Resolve this source once with rp_context_query. Use decision=select with exact projection.bindings or projection.paths when variables are relevant, or not_triggered when the module skill's authored activation condition did not occur.`,
            Object.entries(featureModule.variable.bindings).map(([id, definition]) => `${id}: ${JSON.stringify(definition)}`).join("\n") || "No named bindings are defined.",
          ].join("\n"));
        }
        continue;
      }
      const catalog = await refreshSourceCatalog(target, source, records);
      if (policy.agent.mode !== "override") {
        const selected = selectRecords(records, policy.code.selector).records as RecordEnvelope[];
        run.automaticSelections[source] = selected.map(record => record.id);
        sections.push(source === "messages"
          ? `# Authoritative editable Web RP history\n${authoritativeTranscript(target, selected)}`
          : `# Automatically selected records: ${source}\n${formatRecords(selected)}`);
      } else {
        run.automaticSelections[source] = [];
      }
      if (policy.agent.mode !== "disabled" || policy.catalog.agentMode !== "disabled") {
        if (policy.agent.mode !== "disabled") run.agentSources.push(source);
        sections.push([
          `# Record catalog: ${source}`,
          policy.agent.mode === "disabled" ? "Agent record selection is disabled; use only the automatically selected full records." : `Agent selection mode: ${policy.agent.mode}. You must resolve this source once with rp_context_query before writing the final RP response. Use decision=select with a deterministic selector, decision=success_empty when no record is required after inspection, or decision=not_triggered when the authored activation condition did not occur.`,
          policy.catalog.agentMode === "disabled" ? "" : `Catalog enrichment: ${policy.catalog.agentMode}. After reading exact records, follow the source's owning skill and use rp_catalog_update only when its authored catalog guidance applies.`,
          formatCatalog(catalog),
        ].join("\n"));
      }
    }
    const continuity = await readContinuityContext(target.sessionDirectory);
    if (continuity) sections.push(`# Persisted continuity records\n${continuity}`);
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
    await Promise.all([
      mkdir(commonSettingsDirectory, { recursive: true }),
      mkdir(avatarsDirectory, { recursive: true }),
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
      close: async () => {},
      url: "",
    };

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
                const moduleSessionDirectory = resolve(active.sessionDirectory, "modules", module.id);
                try {
                  const records = module.storage.records
                    ? parseRecordLines(await readFile(resolve(moduleSessionDirectory, module.storage.records.file), "utf8"))
                    : [];
                  const snapshot = module.storage.snapshot
                    ? validateRecordEnvelope(JSON.parse(await readFile(resolve(moduleSessionDirectory, module.storage.snapshot.file), "utf8")))
                    : null;
                  data = { records, snapshot };
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
            active.messages = active.messages.map((message, nextSequence) => ({ ...message, sequence: nextSequence }));
            active.turn = active.messages.reduce((maximum, message) => Math.max(maximum, message.binding.turn), 0);
            const deletedMessageIds = new Set(deleted.map(message => message.id));
            await pruneModuleRecords(active, deletedMessageIds);
            const pendingDraft = await readFile(variableDraftPath(active), "utf8").then(JSON.parse).catch(error => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw error;
            });
            if (pendingDraft?.assistantMessageId && deletedMessageIds.has(pendingDraft.assistantMessageId)) {
              await rm(variableDraftPath(active), { force: true });
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
          if (openingRecord) await initializeVariableModulesForOpening(active, openingRecord);
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
          await ensureActiveRecord();
          await resetPublicDraftDirectory(active);
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
            catalogUpdates: [],
            agentSources: [],
            processorSelections: [],
            contextContent: null,
            phase: "narrative",
            assistantMessageId: null,
            variableModuleId: null,
            variableFinalized: false,
          };
          try {
            pi.sendUserMessage(content);
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

  pi.registerTool({
    name: "rp_context_query",
    label: "Query RP context records",
    description: "Select exact RP message or module records from a runtime catalog. The agent decides what is needed; deterministic code performs the extraction and records a receipt.",
    parameters: Type.Object({
      source: Type.String({ description: "Record source: messages or module:<module-id>." }),
      decision: Type.Union([
        Type.Literal("select"),
        Type.Literal("success_empty"),
        Type.Literal("not_triggered"),
      ]),
      selector: Type.Optional(Type.Object({
        type: Type.Union([
          Type.Literal("all"),
          Type.Literal("latest"),
          Type.Literal("ids"),
          Type.Literal("range"),
          Type.Literal("around"),
          Type.Literal("latest_per_key"),
        ]),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
        ids: Type.Optional(Type.Array(Type.String())),
        fromSequence: Type.Optional(Type.Integer({ minimum: 0 })),
        toSequence: Type.Optional(Type.Integer({ minimum: 0 })),
        id: Type.Optional(Type.String()),
        before: Type.Optional(Type.Integer({ minimum: 0 })),
        after: Type.Optional(Type.Integer({ minimum: 0 })),
        path: Type.Optional(Type.String()),
        values: Type.Optional(Type.Array(Type.String())),
        limitPerKey: Type.Optional(Type.Integer({ minimum: 1 })),
      })),
      projection: Type.Optional(Type.Object({
        kind: Type.Literal("json-pointer"),
        paths: Type.Optional(Type.Array(Type.String())),
        bindings: Type.Optional(Type.Array(Type.String())),
      })),
    }),
    async execute(_toolCallId, parameters) {
      if (!active?.pending || !rpRun || active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) {
        throw new Error("rp_context_query is only available during an active Web RP turn.");
      }
      const source = parameters.source;
      const policy = sourcePolicy(active, source);
      const variableModule = source.startsWith("module:")
        ? active.featureModules.find(module => `module:${module.id}` === source && module.variable)
        : null;
      if (policy.agent.mode === "disabled") throw new Error(`Agent retrieval is disabled for ${source}.`);
      if (rpRun.agentQueries.some(query => query.source === source)) throw new Error(`rp_context_query already resolved ${source} for this turn.`);
      const records = await readSourceRecords(active, source, rpRun);
      const codeFallback = () => variableModule ? [] : selectRecords(records, policy.code.selector).records as RecordEnvelope[];
      let selected: RecordEnvelope[] = [];
      let status = "success";
      let error = "";
      try {
        if (parameters.decision === "not_triggered") {
          selected = policy.agent.onNotTriggered === "code" ? codeFallback() : [];
          status = policy.agent.onNotTriggered === "code" ? "not-triggered-code-fallback" : "not-triggered-empty";
        } else if (parameters.decision === "success_empty") {
          selected = [];
          status = "success-empty";
        } else {
          if (variableModule) {
            if (!parameters.projection || (!(parameters.projection.paths?.length) && !(parameters.projection.bindings?.length))) {
              throw new Error("Variable selection requires exact projection.paths or projection.bindings.");
            }
            const snapshot = records.at(-1);
            if (!snapshot) throw new Error("The variable module has no effective snapshot.");
            selected = [snapshot];
          } else {
            if (!parameters.selector) throw new Error("decision=select requires selector.");
            const result = selectRecords(records, parameters.selector, policy.agent.maxRecords);
            if (result.missing.length) throw new Error(`Requested record IDs were not found: ${result.missing.join(", ")}`);
            if (result.records.length === 0) throw new Error("The selector returned no records; use success_empty if an empty result is intentional.");
            selected = result.records as RecordEnvelope[];
          }
        }
      } catch (queryError) {
        selected = codeFallback();
        status = "failed-code-fallback";
        error = (queryError as Error).message;
      }
      if (policy.agent.mode === "append" && !variableModule) {
        const automatic = new Set(rpRun.automaticSelections[source] || []);
        selected = selected.filter(record => !automatic.has(record.id));
      }
      const queryReceipt = {
        source,
        mode: policy.agent.mode,
        decision: parameters.decision,
        selector: parameters.selector || null,
        projection: parameters.projection || null,
        status,
        error: error || null,
        selectedRecordIds: selected.map(record => record.id),
        queriedAt: new Date().toISOString(),
      };
      rpRun.agentQueries.push(queryReceipt);
      await writeContextReceipt(active, rpRun);
      const formatted = variableModule && selected.length
        ? JSON.stringify(projectVariableState(selected[0].data.state, parameters.projection || {}, variableModule.variable!.bindings), null, 2)
        : source === "messages" ? authoritativeTranscript(active, selected) : formatRecords(selected);
      return {
        content: [{ type: "text", text: [`RP context query: ${status}`, error ? `Reason: ${error}` : "", formatted].filter(Boolean).join("\n\n") }],
        details: queryReceipt,
      };
    },
  });

  pi.registerTool({
    name: "rp_variable_update",
    label: "Update RP variable draft",
    description: "Add, replace, or cancel exact variable operations in the current post-narrative draft. Calls are idempotent by operationId and do not change effective state until rp_variable_finalize succeeds.",
    parameters: Type.Object({
      moduleId: Type.String(),
      changes: Type.Array(Type.Object({
        action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("cancel")]),
        operationId: Type.String(),
        operation: Type.Optional(Type.Union([Type.Literal("set"), Type.Literal("delta"), Type.Literal("merge"), Type.Literal("append"), Type.Literal("remove")])),
        path: Type.Optional(Type.String()),
        value: Type.Optional(Type.Any()),
        reason: Type.Optional(Type.String()),
      }), { minItems: 1, maxItems: 100 }),
    }),
    async execute(_toolCallId, parameters) {
      if (!active?.pending || !rpRun || rpRun.phase !== "variable-update" || active.recordId !== rpRun.recordId) {
        throw new Error("rp_variable_update is only available during an active post-narrative variable update task.");
      }
      if (parameters.moduleId !== rpRun.variableModuleId) throw new Error(`The active variable module is ${rpRun.variableModuleId}.`);
      const path = variableDraftPath(active);
      const draft = JSON.parse(await readFile(path, "utf8"));
      const next = updateVariableDraft(draft, parameters.changes);
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return {
        content: [{ type: "text", text: `Variable draft now contains ${next.operations.length} operation(s). Continue the authored update workflow or call rp_variable_finalize when complete.` }],
        details: { draftId: next.id, operationCount: next.operations.length },
      };
    },
  });

  pi.registerTool({
    name: "rp_variable_finalize",
    label: "Validate and commit RP variables",
    description: "Concentrated code validation for the current variable draft. Failed variables remain pending for Agent correction; a successful result commits one complete snapshot bound to the saved AI message.",
    parameters: Type.Object({ moduleId: Type.String() }),
    async execute(_toolCallId, parameters) {
      if (!active?.pending || !rpRun || rpRun.phase !== "variable-update" || active.recordId !== rpRun.recordId || !active.sessionDirectory) {
        throw new Error("rp_variable_finalize is only available during an active post-narrative variable update task.");
      }
      const module = active.featureModules.find(item => item.id === parameters.moduleId && item.variable);
      if (!module || module.id !== rpRun.variableModuleId) throw new Error(`The active variable module is ${rpRun.variableModuleId}.`);
      const path = variableDraftPath(active);
      const draft = JSON.parse(await readFile(path, "utf8"));
      const current = await currentVariableRecord(active, module);
      if (!current) throw new Error("The variable module has no effective snapshot.");
      if (draft.baseRecordId !== current.id) throw new Error("The effective variable snapshot changed after this draft began. Restart the variable update task.");
      const applied = applyVariableOperations(current.data.state, draft.operations);
      if (applied.errors.length) {
        return {
          content: [{ type: "text", text: `Variable validation needs revision:\n${JSON.stringify(applied.errors, null, 2)}\nCorrect only the failed operations, then call rp_variable_finalize again.` }],
          details: { status: "needs_revision", errors: applied.errors },
        };
      }
      let state = applied.state;
      const context = { phase: "finalize", turn: active.turn, assistantMessageId: draft.assistantMessageId };
      const firstNormalize = await runVariableHook(module.variable!.normalizePath, "normalize", [state, context]);
      state = firstNormalize.state;
      const afterUpdate = await runVariableHook(module.variable!.afterUpdatePath, "afterUpdate", [current.data.state, state, context]);
      state = afterUpdate.state;
      const secondNormalize = await runVariableHook(module.variable!.normalizePath, "normalize", [state, context]);
      state = secondNormalize.state;
      const rawErrors = [...firstNormalize.errors, ...afterUpdate.errors, ...secondNormalize.errors, ...await schemaErrors(module, state)];
      const errors = rawErrors.map((error: any) => {
        const pointer = typeof error.path === "string" ? error.path : "";
        const operation = [...draft.operations].reverse().find((item: any) => item.path === pointer || (pointer && pointer.startsWith(`${item.path}/`)));
        return {
          ...(operation ? { operationId: operation.operationId } : {}),
          path: pointer,
          attemptedValue: variableValueAt(state, pointer),
          currentValue: variableValueAt(current.data.state, pointer),
          code: error.code || "hook_validation_failed",
          message: error.message || String(error),
        };
      });
      if (errors.length) {
        return {
          content: [{ type: "text", text: `Variable validation needs revision:\n${JSON.stringify(errors, null, 2)}\nUse the complete state and module skill to infer relationships. Correct only the failed operations, then finalize again.` }],
          details: { status: "needs_revision", errors },
        };
      }
      if (sameVariableState(current.data.state, state)) {
        await rm(path, { force: true });
        rpRun.variableFinalized = true;
        return { content: [{ type: "text", text: "Variable update finalized successfully; no effective values changed." }], details: { status: "no_changes" } };
      }
      const moduleDirectory = resolve(active.sessionDirectory, "modules", module.id);
      const recordsPath = resolve(moduleDirectory, module.storage.records!.file);
      const records = parseRecordLines(await readFile(recordsPath, "utf8")) as RecordEnvelope[];
      const changedPaths = [...new Set(draft.operations.map((item: any) => item.path))];
      const reasons = draft.operations.filter((item: any) => item.reason).map((item: any) => ({ operationId: item.operationId, path: item.path, reason: item.reason }));
      const record = createRecordEnvelope({
        id: `variable-${randomUUID()}`,
        source: `module:${module.id}`,
        sequence: records.length ? Math.max(...records.map(item => item.sequence)) + 1 : 0,
        binding: { messageId: draft.assistantMessageId, turn: active.turn },
        metadata: { recordType: "variable-snapshot", entityIds: [], tags: ["turn-update"] },
        data: { state, changedPaths, reasons, previousSnapshotId: current.id },
      }) as RecordEnvelope;
      await appendFile(recordsPath, `${JSON.stringify(record)}\n`, "utf8");
      const snapshotPath = resolve(moduleDirectory, module.storage.snapshot!.file);
      const temporaryPath = resolve(moduleDirectory, `.variable-snapshot-${Date.now()}-${process.pid}.tmp`);
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await rename(temporaryPath, snapshotPath);
      await refreshSourceCatalog(active, `module:${module.id}`, [record]);
      await rm(path, { force: true });
      rpRun.variableFinalized = true;
      return {
        content: [{ type: "text", text: `Variable update committed as one complete snapshot (${record.id}) bound to ${draft.assistantMessageId}.` }],
        details: { status: "committed", recordId: record.id, changedPaths },
      };
    },
  });

  pi.registerTool({
    name: "rp_catalog_update",
    label: "Update RP record catalog",
    description: "Add module-skill-guided Agent navigation metadata to exact RP catalog entries. Deterministic IDs, revisions, hashes, and fallback titles remain code-owned.",
    parameters: Type.Object({
      source: Type.String({ description: "Record source: messages or module:<module-id>." }),
      updates: Type.Array(Type.Object({
        recordId: Type.String(),
        title: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        summary: Type.Optional(Type.String()),
      }), { minItems: 1, maxItems: 50 }),
    }),
    async execute(_toolCallId, parameters) {
      if (!active?.pending || !rpRun || active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) {
        throw new Error("rp_catalog_update is only available during an active Web RP turn.");
      }
      const policy = sourcePolicy(active, parameters.source);
      if (policy.catalog.agentMode === "disabled") throw new Error(`Agent catalog updates are disabled for ${parameters.source}.`);
      const records = await readSourceRecords(active, parameters.source, rpRun);
      const catalog = await refreshSourceCatalog(active, parameters.source, records);
      const entries = new Map(catalog.entries.map((entry: any) => [entry.recordId, entry]));
      const applied: string[] = [];
      for (const update of parameters.updates) {
        const entry: any = entries.get(update.recordId);
        if (!entry) throw new Error(`Catalog record was not found: ${update.recordId}`);
        const generated: Record<string, unknown> = policy.catalog.agentMode === "append" && entry.generated
          ? { ...entry.generated }
          : {};
        if (typeof update.title === "string" && update.title.trim()) generated.title = update.title.trim().slice(0, 160);
        if (Array.isArray(update.tags)) generated.tags = [...new Set(update.tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 20);
        if (typeof update.summary === "string" && update.summary.trim()) generated.summary = update.summary.trim().slice(0, 500);
        if (Object.keys(generated).length === 0) throw new Error(`Catalog update for ${update.recordId} contains no usable generated fields.`);
        entry.generated = generated;
        applied.push(update.recordId);
      }
      await writeFile(sourceCatalogPath(active, parameters.source), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      const receipt = { source: parameters.source, mode: policy.catalog.agentMode, recordIds: applied, updatedAt: new Date().toISOString() };
      rpRun.catalogUpdates.push(receipt);
      await writeContextReceipt(active, rpRun);
      return { content: [{ type: "text", text: `Updated catalog navigation metadata for ${applied.length} record(s): ${applied.join(", ")}` }], details: receipt };
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

  pi.registerCommand("rp-vars-resume", {
    description: "Resume the active Web RP chat's interrupted variable-update draft",
    handler: async (_argumentsText, context) => {
      if (!active?.recordId || !active.sessionDirectory) {
        context.ui.notify("No active saved Web RP chat is available.", "warning");
        return;
      }
      await context.waitForIdle();
      const draft = await readFile(variableDraftPath(active), "utf8").then(JSON.parse).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!draft || draft.status !== "pending") {
        context.ui.notify("This chat has no pending variable-update draft.", "info");
        return;
      }
      const assistantIndex = active.messages.findIndex(message => message.id === draft.assistantMessageId);
      if (assistantIndex === -1) throw new Error("The pending variable draft's AI message no longer exists.");
      const userRecord = [...active.messages.slice(0, assistantIndex)].reverse().find(message => message.data.role === "user");
      active.pending = true;
      rpRun = {
        cardId: active.cardId,
        recordId: active.recordId,
        submittedText: draft.userMessage,
        submittedSequence: userRecord?.sequence ?? Math.max(0, assistantIndex - 1),
        assistantContent: draft.assistantMessage,
        automaticSelections: {},
        agentQueries: [],
        catalogUpdates: [],
        agentSources: [],
        processorSelections: [],
        contextContent: null,
        phase: "variable-update",
        assistantMessageId: draft.assistantMessageId,
        variableModuleId: draft.moduleId,
        variableFinalized: false,
      };
      pi.sendMessage({
        customType: "pi-rp-variable-update-task",
        content: "Resume the interrupted post-narrative variable update. Read the supplied complete state and module skill, inspect existing draft operations, correct or continue them, and finish with rp_variable_finalize.",
        display: false,
        details: { resumed: true, draftId: draft.id, moduleId: draft.moduleId },
      }, { deliverAs: "followUp", triggerTurn: true });
      context.ui.notify("Resuming the pending variable update.", "info");
    },
  });

  pi.on("before_agent_start", async event => {
    if (!active?.pending || !rpRun) return;
    if (active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) return;
    if (rpRun.phase === "variable-update") {
      return {
        systemPrompt: [
          event.systemPrompt,
          "# Active Web RP post-narrative task",
          "The player-visible response is already saved. This run performs only variable maintenance. Read the card-local variable skill, use rp_variable_update as many times as needed, and finish with rp_variable_finalize. Never create additional story prose in this phase.",
        ].join("\n\n"),
      };
    }
    if (rpRun.phase !== "narrative" || event.prompt.trim() !== rpRun.submittedText.trim()) return;
    return {
      systemPrompt: [
        event.systemPrompt,
        "# Active Web RP fixed context",
        "For this run, the fixed card and player context below is authoritative. The context event supplies deterministic dynamic fragments and only the records selected by the card's retrieval policies. Earlier Pi-session messages, summaries, tool results, and RP context are not authoritative for story continuity. For every agent-selectable source listed there, call rp_context_query exactly once before producing the final RP response.",
        await fixedRpContext(active),
        messageRetrievalFixedContext(active),
        featureModuleFixedContext(active),
        active.sessionDirectory ? `# Per-turn public draft directory\n${relative(active.context.cwd, publicDraftDirectory(active)).replaceAll("\\", "/")}\nTemporary work for any RP task may be written here. The runtime clears this directory before every new player turn; it is never persistent story state.` : "",
      ].join("\n\n"),
    };
  });

  pi.on("context", async event => {
    if (!active?.pending || !rpRun) return;
    if (active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) return;

    if (rpRun.phase === "variable-update") {
      const boundary = event.messages.findIndex((message: any) => message.customType === "pi-rp-variable-update-task");
      const authoritativeContext = {
        role: "custom" as const,
        customType: "pi-rp-variable-update-context",
        content: await variableUpdateContext(active, rpRun),
        display: false,
        details: { cardId: active.cardId, sessionId: active.recordId, turn: active.turn, moduleId: rpRun.variableModuleId },
        timestamp: Date.now(),
      };
      return { messages: [authoritativeContext, ...(boundary === -1 ? [] : event.messages.slice(boundary))] };
    }
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
      const submittedRecord = active.messages.find(record => record.sequence === rpRun!.submittedSequence);
      rpRun.contextContent = [
        "# Authoritative Web RP context for this turn",
        "Only the fixed context, deterministic dynamic fragments, the current player message, and the code- or agent-selected records in this block are authoritative. Continue from them without repeating prior text.",
        `Current delivered-turn binding: messageId=${submittedRecord?.id || "unknown"}; turn=${submittedRecord?.binding.turn ?? active.turn}. Module records established by this response must use this binding.`,
        await buildDynamicProcessorContext(active, rpRun),
        await buildAutomaticContext(active, rpRun),
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
      ],
    };
  });

  pi.on("agent_end", async event => {
    if (!active?.pending || !rpRun) return;
    if (active.cardId !== rpRun.cardId || active.recordId !== rpRun.recordId) return;
    if ((event as any).willRetry) return;
    if (rpRun.phase === "variable-update") {
      if (rpRun.variableFinalized) rpRun.phase = "done";
      return;
    }
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
    if (!await beginVariableUpdate(active, rpRun, assistantRecord)) rpRun.phase = "done";
  });

  pi.on("agent_settled", async () => {
    const settledRun = rpRun;
    if (!settledRun) return;
    try {
      if (!active?.pending) return;
      if (active.cardId !== settledRun.cardId || active.recordId !== settledRun.recordId) return;
      await writeContextReceipt(active, settledRun);
    } finally {
      if (active?.cardId === settledRun.cardId && active.recordId === settledRun.recordId) {
        active.pending = false;
      }
      if (rpRun === settledRun) rpRun = null;
    }
  });

  pi.on("session_before_switch", stopBridge);
  pi.on("session_shutdown", stopBridge);
}
