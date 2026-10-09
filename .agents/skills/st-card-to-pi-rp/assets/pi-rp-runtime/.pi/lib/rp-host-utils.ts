

import { execFile } from "node:child_process";

import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { Type } from "typebox";

import { resolveActiveForegroundWorkflow } from "./rp-config-store.mjs";

import { renderCardText } from "./rp-card-text.mjs";

import { normalizeWorkflowDefinition } from "./rp-workflows.mjs";

import { resolveCardChild } from "./rp-card-content.ts";
import { buildConfigCatalog } from "./rp-config-catalog.mjs";
import { playerProfileContext } from "./rp-transcript-display.ts";

import { createImageExecutionGuard } from "./rp-image-execution-guard.ts";

import { recordToWebMessage } from "./rp-turn-state.ts";

import { narrativeSourceLabel } from "./rp-narrative-source.mjs";

import type { RecordEnvelope, ActiveBridge, FeatureModule, ModuleDisplaySettings } from "./rp-host-types.ts";
export const imageExecutionGuard = createImageExecutionGuard();

export function normalizeModuleDisplaySettings(value: any, modules: FeatureModule[]): ModuleDisplaySettings {
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
    ? [...new Set<string>(value.hidden.filter((id: unknown): id is string => typeof id === "string" && validIds.has(id)))]
    : [];
  return { order, hidden };
}

export function toolParameters(parameters: Record<string, any>, required: readonly string[]) {
  const requiredFields = new Set(required);
  const properties = Object.fromEntries(
    Object.entries(parameters).map(([name, schema]) => [name, requiredFields.has(name) ? Type.Unsafe(schema) : Type.Optional(Type.Unsafe(schema))]),
  );
  return Type.Object(properties, { additionalProperties: false });
}

export function avatarExtension(mimeType: string) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  throw httpError(400, "Avatar must be a PNG, JPEG, or WebP image.");
}

export function resolveAvatarFile(settingsDirectory: string, avatar: string) {
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

export async function fixedRpContext(active: ActiveBridge) {
  const sections = [
    "# Fixed card context",
    renderCardText(active.stableCardContext, active.playerName, "fixed_context"),
    playerProfileContext(active.playerName, active.playerDescription),
  ];
  return sections.filter(Boolean).join("\n\n");
}

export function featureModuleFixedContext(active: ActiveBridge) {
  if (active.featureModules.length === 0 || !active.sessionDirectory) return "";
  return [
    "# Card feature-module routing",
    ...active.featureModules.map(module => {
      return [
        `## ${renderCardText(module.title, active.playerName, `${module.id} title`)} (${module.id})`,
        renderCardText(module.skillDescription, active.playerName, `${module.id} skill description`),
        `Module skill: ${relative(active.context.cwd, module.skillPath).replaceAll("\\", "/")}`,
        module.contract
          ? `Collections: ${Object.keys(module.contract.collections).join(", ")}. Use rp_data_query/rp_data_get only within the current workflow node's granted capabilities.`
          : `Static resource catalog: ${module.resourceCatalogPath ? relative(active.context.cwd, module.resourceCatalogPath).replaceAll("\\", "/") : "none"}. Access it only through the module's workflows.`,
      ].filter(Boolean).join("\n");
    }),
  ].join("\n\n");
}

export function messageRetrievalFixedContext(active: ActiveBridge) {
  if (!active.messageSkillPath) return "";
  return [
    "# Card message-record retrieval skill",
    `Skill: ${relative(active.context.cwd, active.messageSkillPath).replaceAll("\\", "/")}`,
    renderCardText(active.messageSkillDescription, active.playerName, "message retrieval skill description"),
    "Read this skill before using rp_message_query.",
  ].join("\n");
}

export function authoritativeTranscript(active: ActiveBridge, messages: RecordEnvelope[]) {
  if (messages.length === 0) return "No prior conversation messages are stored.";
  return messages.map(record => {
    const message = recordToWebMessage(record);
    const speaker = message.role === "user" ? active.playerName : active.cardName;
    const kind = message.kind === "opening" ? "authored opening" : `turn ${message.turn}`;
    return `[${record.id} | ${speaker} | ${kind} | ${narrativeSourceLabel(record.metadata?.narrativeSource)}]\n${message.content}`;
  }).join("\n\n");
}

export function recentCompletedTurnContext(active: ActiveBridge, beforeTurn: number, limit = 5) {
  const eligible = active.messages.filter(message => message.binding.turn < beforeTurn);
  const completedTurns = [...new Set(eligible.filter(message => message.data.role === "assistant").map(message => message.binding.turn))].slice(-limit);
  return authoritativeTranscript(active, eligible.filter(message => completedTurns.includes(message.binding.turn)));
}

export function unresolvedWorkflowCalls(workflow: any, featureModules: any[]): string[] {
  const resolved = new Set<string>();
  for (const module of featureModules || []) {
    for (const candidate of module.workflows || []) resolved.add(candidate.id);
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

export async function resolveActiveWorkflowId(configStore: any, cardSettings: { settings: Record<string, any> }): Promise<string> {
  const topLevel = await configStore.listWorkflows();
  return resolveActiveForegroundWorkflow(topLevel, cardSettings.settings.activeWorkflowId);
}

export async function readOrCreateJson<T>(path: string, fallback: T): Promise<T> {
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

export function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

export function mergeConfigValue(base: any, override: any): any {
  if (!override || typeof override !== "object" || Array.isArray(override)) return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = mergeConfigValue(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}

export async function activeConfigCatalog(target: ActiveBridge) {
  // 目录装配只有一份实现（rp-config-catalog.mjs）。本函数只负责提供两件宿主专属的东西：
  // 模块对象（含归一化的 contract/view）与"如何读取模块内文件"。作用域与存储仍各自独立。
  const agents = (await target.configStore.listAgents()).map((item: any) => ({ moduleId: item.moduleId, moduleTitle: item.moduleTitle, base: item.base }));
  const workflows = (await target.configStore.listWorkflows()).map((workflow: any) => ({ ownerModuleId: workflow.ownerModuleId, moduleTitle: workflow.moduleTitle, base: workflow }));
  const readModuleDocument = async (relativePath: string, module: FeatureModule) => readFile(resolve(module.moduleDirectory, relativePath), "utf8").then(JSON.parse).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  return buildConfigCatalog({
    modules: target.featureModules,
    readModuleDocument,
    listAgents: async () => agents,
    listWorkflows: async () => workflows,
    includeRuntimePolicy: true,
    getRuntimePolicy: () => target.configStore.getRuntimePolicy(),
  });
}

export function applyModuleProfile(featureModules: FeatureModule[], profile: any) {
  if (!profile) return featureModules;
  return featureModules.map(module => ({
    ...module,
    workflows: module.workflows.map(workflow => {
      const qualified = `module/${module.id}/workflow/${workflow.id.split("/").at(-1)}`;
      const override = profile.workflowOverrides?.[qualified];
      if (!override) return workflow;
      const effective = normalizeWorkflowDefinition(mergeConfigValue(workflow, override));
      if (effective.id !== workflow.id || effective.ownerModuleId !== module.id) throw new Error("Configuration overrides cannot change component identity or ownership.");
      return effective;
    }),
  }));
}

export function resolveCardDirectory(cwd: string, card: string) {
  const cardsRoot = resolve(cwd, "cards");
  const target = card.includes("/") || card.includes("\\") ? resolve(cwd, card) : resolve(cardsRoot, card);
  const relation = relative(cardsRoot, target);
  if (!relation || relation.startsWith("..") || resolve(cardsRoot, relation) !== target) {
    throw new Error("The Web RP card must be a child of the project's cards directory.");
  }
  return target;
}

export function resolveSessionDirectory(root: string, sessionId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId)) throw httpError(400, "Session ID is invalid.");
  const target = resolve(root, sessionId);
  const relation = relative(root, target);
  if (!relation || relation.startsWith("..") || resolve(root, relation) !== target) {
    throw httpError(400, "Session path escapes the card session directory.");
  }
  return target;
}

export function imageMimeFromBytes(body: Buffer) {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function locateCardCover(cardDirectory: string, manifest: any) {
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

export function openBrowser(url: string) {
  try {
    if (process.platform === "win32") {
      execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], () => {});
    } else if (process.platform === "darwin") {
      execFile("open", [url], () => {});
    } else {
      execFile("xdg-open", [url], () => {});
    }
  } catch (error) {
    console.warn(`Could not open a browser for ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function openLocalDocument(path: string) {
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
