

import { rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { historyServiceManagement, historyConfiguration, narrativeHistoryStatus } from "./rp-narrative-history.mjs";
import { projectTranscript } from "./rp-transcript-projection.mjs";
import { createSessionDataStore } from "./rp-session-data-store.ts";
import { referenceBinding, referenceStatus, saveReferenceBinding, referenceSemanticManagement, browseReferenceDirectories } from "./rp-reference-library.mjs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createRpConfigStore } from "./rp-config-store.mjs";
import { createConfigProfileStore } from "./rp-config-profiles.mjs";
import { normalizeModelProfile } from "./rp-model-config.mjs";
import { discoverModelList } from "./rp-model-discovery.mjs";
import { isDashScope, streamDashScope } from "./rp-dashscope.mjs";

import { readFeatureModules } from "./rp-card-content.ts";

import { messageText } from "./rp-transcript-display.ts";

import { httpError, activeConfigCatalog, applyModuleProfile } from "./rp-host-utils.ts";
import type { ActiveBridge } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  manifest: any;
  scope: HostSessionScope<ActiveBridge>;
  configToken: string;
  configProfiles: ReturnType<typeof createConfigProfileStore>;
  configStore: ReturnType<typeof createRpConfigStore>;
  cardDirectory: string;
  ensureFeatureModuleRecords: (target: ActiveBridge) => Promise<void>;
  context: ExtensionContext;
  pi: Pick<ExtensionAPI, "registerProvider" | "unregisterProvider">;
  resolveConfiguredModel: (target: ActiveBridge, modelId: string, frozenOverride?: any) => Promise<{ profile: any; model: any; }>;
};
export function createConfigWebBridge({ manifest, scope, configToken, configProfiles, configStore, cardDirectory, ensureFeatureModuleRecords, context, pi, resolveConfiguredModel }: Dependencies) {
async function connectionKey(value: any) {
  if (typeof value.apiKey === "string" && value.apiKey.trim()) return value.apiKey.trim();
  if (value.profileId && value.modelId) return configProfiles.getModelSecret(value.profileId, value.modelId);
  const saved = value.modelId ? (await configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === value.modelId) : null;
  return saved?.apiKey || "";
}
return {
historyServiceManagement: async (operation: string, value: any) => {
  if (operation !== "status") return historyServiceManagement(operation, value);
  const target = scope.requireCurrent();
  const configuration = await (await historyConfiguration()).publicSettings();
  if (!target?.sessionDirectory || !target.featureModules.some(module => module.id === "narrative-controls")) return { configuration, sessionAvailable: false };
  const store = createSessionDataStore({ sessionDirectory: target.sessionDirectory, featureModules: target.featureModules });
  const settings = (await store.readCollection("narrative-controls", "settings")).records.find((record: any) => record.id === "narrative-history-settings")?.data;
  const provider = target.transcriptProvider;
  const messages = projectTranscript((await store.readCollection(provider.moduleId, provider.collectionId)).records, store.module(provider.moduleId).contract, provider);
  const workflow = await configStore.getWorkflow(target.activeWorkflowId);
  return { sessionAvailable: true, ...(await narrativeHistoryStatus(target.sessionDirectory,messages,settings,workflow.turnContext?.recentCompleteTurns ?? 5)) };
},
getReferenceLibrary: async () => ({ ...(await referenceStatus()), root: (await referenceBinding())?.root || "" }),
saveReferenceLibrary: async (value: any) => saveReferenceBinding(value),
browseReferenceDirectories: async (value: any) => browseReferenceDirectories(value),
referenceSemanticManagement: async (operation: string, value: any) => referenceSemanticManagement(operation, value),
getConfigContext: async () => ({ mode: "play", scope: "card", ownerId: manifest.id, token: scope.requireCurrent()?.configToken || configToken, modelSecretCopy: true }),
authorizeConfigMutation: async (value: unknown) => {
            if (value !== (scope.requireCurrent()?.configToken || configToken)) throw httpError(403, "Configuration session token is invalid.");
            return true;
          },
getConfigCatalog: async () => activeConfigCatalog(scope.requireCurrent()!),
listConfigProfiles: async () => configProfiles.list(),
getConfigProfile: async (profileId: string) => profileId === "builtin" ? {
            schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "builtin", name: "内置默认", builtin: true,
            models: await configStore.listModels(), agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {},
            compatibility: { moduleProtocol: 7, workflowProtocol: 4 },
          } : configProfiles.get(profileId),
createConfigProfile: async (value: any) => {
            const seed = value.seedFromId === "builtin" ? {
              schemaVersion: 1, kind: "pi-rp-config-profile", scope: "card", id: "builtin", name: "内置默认",
              models: await configStore.listModels(), agentOverrides: {}, workflowOverrides: {}, moduleOverrides: {},
              compatibility: { moduleProtocol: 7, workflowProtocol: 4 },
            } : value.seedFromId ? await configProfiles.exportProfile(value.seedFromId) : null;
            return configProfiles.create({ id: value.id, name: value.name, description: value.description, seed });
          },
saveConfigProfile: async (value: any) => {
            const saved = await configProfiles.save(value);
            const listing = await configProfiles.list();
            if (scope.requireCurrent() && listing.activeProfileId === saved.id) {
              scope.requireCurrent().featureModules = applyModuleProfile(await readFeatureModules(cardDirectory, manifest.feature_modules), await configProfiles.getActive());
              await ensureFeatureModuleRecords(scope.requireCurrent());
              scope.requireCurrent().workflowEngine.policy = await configStore.getRuntimePolicy();
            }
            return saved;
          },
renameConfigProfile: async (profileId: string, value: any) => configProfiles.rename(profileId, value.name),
duplicateConfigProfile: async (profileId: string, value: any) => configProfiles.duplicate(profileId, value),
deleteConfigProfile: async (profileId: string) => configProfiles.remove(profileId),
importConfigProfile: async (value: any) => configProfiles.importProfile(value.profile, { id: value.id, name: value.name }),
exportConfigProfile: async (profileId: string) => configProfiles.exportProfile(profileId),
saveConfigModelSecret: async (profileId: string, modelId: string, value: any) => value.sourceModelId
  ? configProfiles.copyModelSecret(profileId, value.sourceModelId, modelId)
  : configProfiles.saveModelSecret(profileId, modelId, value.apiKey || ""),
activateConfigProfile: async (profileId: string) => {
            const result = await configProfiles.activate(profileId);
            if (scope.requireCurrent()) {
              scope.requireCurrent().featureModules = applyModuleProfile(await readFeatureModules(cardDirectory, manifest.feature_modules), await configProfiles.getActive());
              await ensureFeatureModuleRecords(scope.requireCurrent());
              scope.requireCurrent().workflowEngine.policy = await configStore.getRuntimePolicy();
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
discoverModels: async (value: any) => {
            return discoverModelList({baseUrl:value.baseUrl,api:value.api,apiKey:await connectionKey(value)});
          },
testModel: async (value: any) => {
            const modelId = typeof value.modelId === "string" ? value.modelId : "";
            let profile: any, model: any, apiKey: string | undefined;
            let temporaryProvider: string | undefined;
            try {
            if (value.modelProfile) {
              profile = normalizeModelProfile({ ...value.modelProfile, id: value.modelProfile.id || "draft-model" });
              const baseUrl = typeof value.modelProfile.baseUrl === "string" ? value.modelProfile.baseUrl.trim() : "";
              apiKey = await connectionKey(value) || undefined;
              if (baseUrl) {
                temporaryProvider = `rp-test-${randomUUID()}`;
                pi.registerProvider(temporaryProvider, { name: profile.name, baseUrl, api: profile.api || "openai-completions", apiKey,
                  ...(isDashScope(profile.api)?{streamSimple:streamDashScope}:{}),
                  models: [{ id: profile.model, name: profile.name, reasoning: profile.thinking !== "off", input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: profile.contextWindow, maxTokens: profile.maxOutputTokens }],
                } as any);
                model = context.modelRegistry.find(temporaryProvider, profile.model);
              } else model = context.modelRegistry.find(profile.provider, profile.model);
            } else ({ profile, model } = await resolveConfiguredModel(scope.requireCurrent()!, modelId));
            if (!model) throw httpError(400, "The selected model is unavailable.");
            const startedAt = Date.now();
            const response: any = await context.modelRegistry.complete(model, {
              systemPrompt: "This is an API connectivity smoke test. Reply briefly.",
              messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
            }, { maxTokens: Math.min(profile?.maxOutputTokens || 64, 64), signal: AbortSignal.timeout(30000), ...(value.modelProfile ? { apiKey } : {}) } as any);
            if (response.stopReason === "error") throw httpError(400, response.errorMessage || "Model test failed.");
            return { ok: true, elapsedMs: Date.now() - startedAt, reply: messageText(response), provider: response.provider, model: response.model };
            } finally { if (temporaryProvider) pi.unregisterProvider(temporaryProvider); }
          },
listAgents: async () => ({ agents: await configStore.listAgents() }),
getWorkflowPolicy: async () => configStore.getRuntimePolicy()
};
}
