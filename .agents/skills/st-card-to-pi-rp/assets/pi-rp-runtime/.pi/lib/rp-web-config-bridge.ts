

import { rename } from "node:fs/promises";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createRpConfigStore } from "./rp-config-store.mjs";
import { createConfigProfileStore } from "./rp-config-profiles.mjs";

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
  resolveConfiguredModel: (target: ActiveBridge, modelId: string, frozenOverride?: any) => Promise<{ profile: any; model: any; }>;
};
export function createConfigWebBridge({ manifest, scope, configToken, configProfiles, configStore, cardDirectory, ensureFeatureModuleRecords, context, resolveConfiguredModel }: Dependencies) {
return {
getConfigContext: async () => ({ mode: "play", scope: "card", ownerId: manifest.id, token: scope.requireCurrent()?.configToken || configToken }),
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
saveConfigModelSecret: async (profileId: string, modelId: string, value: any) => configProfiles.saveModelSecret(profileId, modelId, value.apiKey || ""),
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
            const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim().replace(/\/$/, "") : "";
            if (!baseUrl) throw httpError(400, "baseUrl is required.");
            const headers: Record<string, string> = { accept: "application/json" };
            const saved = value.modelId ? (await configStore.listModels({ includeSecrets: true })).find((item: any) => item.id === value.modelId) : null;
            const apiKey = typeof value.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : saved?.apiKey || "";
            if (apiKey) {
              if (value.api === "anthropic-messages") {
                headers["x-api-key"] = apiKey;
                headers["anthropic-version"] = "2023-06-01";
              } else headers.authorization = `Bearer ${apiKey}`;
            }
            const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw httpError(400, `Model list request failed: HTTP ${response.status}`);
            const payload: any = await response.json();
            const models = (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
              .map((item: any) => typeof item === "string" ? item : item?.id)
              .filter((id: unknown): id is string => typeof id === "string" && Boolean(id.trim()))
              .sort();
            return { models };
          },
testModel: async (value: any) => {
            const modelId = typeof value.modelId === "string" ? value.modelId : "";
            const { profile, model } = await resolveConfiguredModel(scope.requireCurrent()!, modelId);
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
getWorkflowPolicy: async () => configStore.getRuntimePolicy()
};
}
