

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { renderCardText, renderCardTextValues } from "./rp-card-text.mjs";

import { latestCompletedTurn } from "./rp-turn-state.ts";

import { createSessionDataStore } from "./rp-session-data-store.ts";
import { getDataRecord, getDataRecordHistory, queryDataStable } from "./rp-data-query.mjs";

import { executeDataBatch } from "./rp-data-changes.mjs";
import { inspectDataImpact, inspectDataIntegrity } from "./rp-data-transactions.mjs";
import { dataValueAt } from "./rp-data-index.mjs";

import { applyFrontendSettingsValues, frontendRegion } from "./rp-module-frontend.mjs";
import { frontendPromptControls, loadPromptControls, promptSettingsFields, validatePromptSelections } from "./rp-prompt-controls.mjs";

import { normalizeModuleDisplaySettings, httpError, openLocalDocument } from "./rp-host-utils.ts";
import type { ActiveBridge, FeatureModule, ModuleDisplaySettings, RpDataStore } from "./rp-host-types.ts";
import type { HostSessionScope } from "./rp-host-session-scope.ts";

type Dependencies = {
  scope: HostSessionScope<ActiveBridge>;
  ensureFeatureModuleRecords: (target: ActiveBridge) => Promise<void>;
  activeDataStore: () => RpDataStore;
  requireFrontendModule: (moduleId: string) => FeatureModule;
  cardSettingsPath: string;
};
export function createModulesWebBridge({ scope, ensureFeatureModuleRecords, activeDataStore, requireFrontendModule, cardSettingsPath }: Dependencies) {
return {
listFeatureModules: async () => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (scope.requireCurrent().recordId && scope.requireChat().sessionDirectory) await ensureFeatureModuleRecords(scope.requireCurrent());
            const modules = [];
            const frontendModules = scope.requireCurrent().featureModules
              .filter(module => module.surface === "frontend")
              .sort((left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id));
            for (const module of frontendModules) {
              let data = null;
              let available = false;
              let dataError = "";
              if (scope.requireChat().sessionDirectory) {
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
                title: renderCardText(module.title, scope.requireCurrent().playerName, `${module.id} title`),
                description: renderCardText(module.description, scope.requireCurrent().playerName, `${module.id} description`),
                displayOrder: module.displayOrder,
                available,
                error: dataError,
                view: renderCardTextValues(module.view, scope.requireCurrent().playerName, `${module.id} frontend view`),
                data,
              });
            }
            return { sessionId: scope.requireCurrent().recordId, modules };
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
            return { opened: true, path: relative(scope.requireCurrent().context.cwd, path).replaceAll("\\", "/"), unsupportedDirectEdit: true };
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
            let controls: any = null;
            try {
              region = frontendRegion(module, regionId);
              if (!["settings-form", "prompt-controls"].includes(region.type)) throw new Error("Region does not expose settings.");
              if (region.type === "prompt-controls") {
                controls = await loadPromptControls(module.moduleDirectory, module.resourceCatalog, region.controlsFile);
                region = { ...region, fields: promptSettingsFields(controls) };
              }
            }
            catch (error) { throw httpError(400, (error as Error).message); }
            const store = activeDataStore();
            const state = await store.readCollection(moduleId, region.collectionId);
            const raw = state.records.find((item: any) => item.id === region.recordId && item.recordType === region.recordType);
            if (!raw) throw httpError(404, `Settings record ${region.recordId} was not found.`);
            const rendered = await getDataRecord(store, { moduleId, collectionId: region.collectionId, id: region.recordId, view: region.view }, { capabilities: [region.readCapability], views: [region.view] });
            if (controls) validatePromptSelections(controls, raw.data);
            return { record: rendered, values: Object.fromEntries(region.fields.map((field: any) => [field.path, dataValueAt(raw, `/data${field.path}`)])), ...(controls ? { controls: await frontendPromptControls(module.moduleDirectory, controls, (text: string) => renderCardText(text, scope.requireCurrent()!.playerName, "frontend prompt option")) } : {}) };
          },
updateModuleFrontendSettings: async (moduleId: string, regionId: string, value: any) => {
            const module = requireFrontendModule(moduleId);
            let region;
            let controls: any = null;
            try {
              region = frontendRegion(module, regionId);
              if (!["settings-form", "prompt-controls"].includes(region.type)) throw new Error("Region does not expose settings.");
              if (region.type === "prompt-controls") {
                controls = await loadPromptControls(module.moduleDirectory, module.resourceCatalog, region.controlsFile);
                region = { ...region, fields: promptSettingsFields(controls) };
              }
            }
            catch (error) { throw httpError(400, (error as Error).message); }
            if (!Number.isSafeInteger(value?.expectedRevision) || value.expectedRevision < 1) throw httpError(400, "expectedRevision must be a positive integer.");
            const store = activeDataStore();
            const state = await store.readCollection(moduleId, region.collectionId);
            const current = state.records.find((item: any) => item.id === region.recordId && item.recordType === region.recordType);
            if (!current) throw httpError(404, `Settings record ${region.recordId} was not found.`);
            let next;
            try {
              next = applyFrontendSettingsValues(region, current.data, value.values || {});
              if (controls) validatePromptSelections(controls, next);
            }
            catch (error) { throw httpError(400, (error as Error).message); }
            const receipt = await executeDataBatch(store, { protocolVersion: 1, batchId: `frontend-${moduleId}-${regionId}-${randomUUID()}`, status: "pending", commitPolicy: "atomic", operations: [{ operationId: `update-${randomUUID()}`, moduleId, collectionId: region.collectionId, recordType: region.recordType, action: "update", targetId: region.recordId, expectedRevision: value.expectedRevision, data: next }] }, { access: [{ moduleId, collectionId: region.collectionId, capabilities: [region.updateCapability], views: [region.view] }], context: { initiatorKind: "user", initiatorId: "web-module-frontend", binding: { turn: controls ? 0 : scope.requireCurrent()?.turn || 0, messageId: null }, sourceReferences: [] } });
            if (receipt.status !== "committed") throw httpError(receipt.results?.some((item: any) => item.code === "revision_conflict") ? 409 : 400, `Settings update failed: ${receipt.results?.[0]?.error || receipt.status}`);
            return { saved: true, receipt };
          },
inspectModuleFrontendIntegrity: async (moduleId: string, regionId: string) => {
            const module = requireFrontendModule(moduleId);
            let region;
            try { region = frontendRegion(module, regionId, "integrity-alerts"); }
            catch (error) { throw httpError(400, (error as Error).message); }
            if (!scope.requireCurrent()?.sessionDirectory) throw httpError(409, "Start or resume a chat before inspecting module integrity.");
            const result = await inspectDataIntegrity(scope.requireChat().sessionDirectory, {
              messages: scope.requireCurrent().messages,
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
              const currentRevisionByMessage = new Map(scope.requireCurrent().messages.map(message => [message.id, message.revision]));
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
              const eligibleLastTurn = Math.max(0, latestCompletedTurn(scope.requireCurrent()) - protectRecentTurns);
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
            if (!scope.requireCurrent()?.sessionDirectory) throw httpError(409, "Start or resume a chat before inspecting data impact.");
            const installed = scope.requireCurrent().featureModules.map(item => item.id);
            if (moduleId && !installed.includes(moduleId)) throw httpError(404, `Feature module ${moduleId} is not available.`);
            return inspectDataImpact(scope.requireChat().sessionDirectory, { messageId, revision, allowedModuleIds: moduleId ? [moduleId] : installed });
          },
openFeatureModuleDocument: async (moduleId: string, target: unknown) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            if (target !== "data" && target !== "definition") throw httpError(400, "Module document target must be data or definition.");
            const module = scope.requireCurrent().featureModules.find(item => item.id === moduleId && item.surface === "frontend");
            if (!module) throw httpError(404, "Feature module was not found in the Web interface.");
            let documentPath: string;
            if (target === "definition") {
              documentPath = resolve(module.moduleDirectory, "data-contract.json");
            } else {
              if (!scope.requireChat().sessionDirectory) throw httpError(409, "Select an opening or saved chat before opening module data.");
              await ensureFeatureModuleRecords(scope.requireCurrent());
              const store = createSessionDataStore({ sessionDirectory: scope.requireChat().sessionDirectory, featureModules: scope.requireCurrent().featureModules });
              const collections: Record<string, unknown> = {};
              for (const collectionId of Object.keys(module.contract.collections)) collections[collectionId] = await store.readCollection(module.id, collectionId);
              documentPath = resolve(scope.requireChat().sessionDirectory, "workspace", "public", "module-views", `${module.id}.json`);
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
              path: relative(scope.requireCurrent().context.cwd, documentPath).replaceAll("\\", "/"),
            };
          },
updateModuleDisplaySettings: async ({ order, hidden }: ModuleDisplaySettings) => {
            if (!scope.requireCurrent()) throw httpError(409, "This Web page belongs to a closed Pi session. Use the newest Web RP page.");
            scope.requireCurrent().cardSettings.settings.featureModules = normalizeModuleDisplaySettings({ order, hidden }, scope.requireCurrent().featureModules);
            await writeFile(cardSettingsPath, `${JSON.stringify(scope.requireCurrent().cardSettings, null, 2)}\n`, "utf8");
            return { card: scope.requireCurrent().cardSettings };
          }
};
}
