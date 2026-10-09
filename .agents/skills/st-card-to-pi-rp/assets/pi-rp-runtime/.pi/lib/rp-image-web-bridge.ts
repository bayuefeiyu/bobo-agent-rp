

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { createImageExecutionGuard, createWebDataAccess } from "./rp-image-execution-guard.ts";
import { createImageDataFacade, loadImageExecution, resolveImageModuleContext } from "./rp-image-adapter.ts";
import { latestCompletedTurn } from "./rp-turn-state.ts";

import { createSessionDataStore } from "./rp-session-data-store.ts";
import { getDataRecord, queryData } from "./rp-data-query.mjs";

import { executeDataBatchOrThrow } from "./rp-data-changes.mjs";

import type { ActiveBridge } from "./rp-host-types.ts";
type ImageBridgeDependencies = {
 getSession: () => ActiveBridge;
 ensureFeatureModuleRecords: (target: ActiveBridge) => Promise<void>;
 configStore: ActiveBridge['configStore'];
 httpError: (status: number, message: string) => Error;
 openLocalDocument: (path: string) => Promise<void>;
 imageExecutionGuard: ReturnType<typeof createImageExecutionGuard>;
};

export function createImageWebBridge({ getSession, ensureFeatureModuleRecords, configStore, httpError, openLocalDocument, imageExecutionGuard }: ImageBridgeDependencies) {
return {
getImageGeneration: async () => {
 const active = getSession();
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
            const image = await resolveImageModuleContext(active.featureModules);
            if (!image) return { available: false, sessionId: active.recordId, profiles: [], connections, preferences: null, requests: [], renders: [] };
            if (!active.sessionDirectory) return { available: true, sessionId: null, profiles, connections, preferences: null, requests: [], renders: [] };
            await ensureFeatureModuleRecords(active);
            const store = createSessionDataStore({ sessionDirectory: active.sessionDirectory, featureModules: active.featureModules });
            const imageData = createImageDataFacade({ webApi: image.webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active.turn });
            const [settings, requests, renders] = await Promise.all([
              imageData.readSettings(),
              imageData.readRequests(),
              imageData.readRenders(),
            ]);
            const requestSummaries = requests.records.map(image.webApi.requestSummary);
return { available: true, sessionId: active.recordId, profiles, connections, preferences: settings.records.find(item => item.id === image.webApi.COMPONENTS.preferencesRecordId) || null, requests: requestSummaries, renders: renders.records };
          },
saveImagePreferences: async (value: any) => {
 const active = getSession();
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before saving image preferences.");
            await ensureFeatureModuleRecords(active);
            const store = createSessionDataStore({ sessionDirectory: active.sessionDirectory, featureModules: active.featureModules });
            const prefs = await resolveImageModuleContext(active.featureModules);
            if (!prefs) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const prefsData = createImageDataFacade({ webApi: prefs.webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active.turn });
            const current = (await prefsData.readSettings()).records.find(item => item.id === prefs.webApi.COMPONENTS.preferencesRecordId);
            if (!current) throw httpError(404, "Image preferences record was not found.");
            const profiles = await active.comfyUi.profiles();
            const { next, batch } = prefs.webApi.preferenceUpdate(current, value, profiles, `image-preferences-${Date.now()}-${randomUUID()}`, `update-${randomUUID()}`);
 await prefsData.dataFor(prefs.webApi.ACCESS.preferencesConfigure).submit(batch);
return { saved: true, preferences: next };
          },
startImageGeneration: async (value: any) => {
 const active = getSession();
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "Start or resume a chat before generating an image.");
            const image = await resolveImageModuleContext(active.featureModules);
            if (!image) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const execution: any = await loadImageExecution(image.webApi, image.moduleDirectory, `web=${Date.now()}`);
            const operationId = typeof value.operationId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.operationId) ? value.operationId : randomUUID();
            const payload = execution.normalizeImageOperationIntent({ ...value, operationId });
            const store = createSessionDataStore({ sessionDirectory: active.sessionDirectory, featureModules: active.featureModules });
            const startData = createImageDataFacade({ webApi: image.webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active.turn });
            const existing = (await startData.readRequests()).records.find(item => item.id === `image-request-${operationId}`);
            if (existing) execution.assertImageOperationIntent(existing, payload, operationId);
            const workflow = await configStore.copyWorkflowToCard(image.webApi.COMPONENTS.entryWorkflow);
            const completedThrough = latestCompletedTurn(active);
            const run = await active.workflowEngine.start(workflow, { cardId: active.cardId, chatId: active.recordId, turn: completedThrough, visibleThroughTurn: completedThrough, trigger: { type: "manual" }, payload, reuseActive: true });
            return { accepted: true, runId: run.id };
          },
recoverImageGeneration: async (requestId: string) => {
 const active = getSession();
            if (!active?.recordId || !active.sessionDirectory) throw httpError(409, "Start or resume a chat before recovering image generation.");
            const image = await resolveImageModuleContext(active.featureModules);
            if (!image) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const store = createSessionDataStore({ sessionDirectory: active.sessionDirectory, featureModules: active.featureModules });
            const recoverData = createImageDataFacade({ webApi: image.webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active.turn });
            const requestState = await recoverData.readRequests();
            const renderState = await recoverData.readRenders();
            const request = requestState.records.find(item => item.id === requestId);
            if (!request) throw httpError(404, "Image request was not found.");
            const renders = image.webApi.recoverableRenders(renderState.records, requestId);
            if (!renders.length) return { accepted: false, requestId, reason: "no-recoverable-renders" };
            const operationId = request.data.dedupeKey;
            const activeRun = active.workflowEngine.snapshot().find((run: any) => run.payload?.operationId === operationId && run.status === "awaiting-recovery");
            if (activeRun) {
              const recovered = await active.workflowEngine.recover(activeRun.id);
              return { accepted: true, requestId, runId: recovered.id, mode: "workflow" };
            }
const execution: any = await loadImageExecution(image.webApi, image.moduleDirectory, `recover=${Date.now()}`);
            const access = image.webApi.ACCESS.requests;
            const data = createWebDataAccess({ store, access, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active?.turn || 0 });
            imageExecutionGuard.run(requestId, () =>
              execution.executeImageOperation({ data, services: { comfy: active.comfyUi }, requestId, renders }));
            return { accepted: true, requestId, mode: "render-recovery" };
          },
saveComfyConnection: async (value: any) => getSession().comfyUi.saveConnection(value),
testComfyConnection: async (connectionId: string) => getSession().comfyUi.testConnection(connectionId),
saveComfyProfileOverride: async (profileId: string, value: any) => getSession().comfyUi.saveProfileOverride(profileId, value.prompt || value),
openComfyProfileDocument: async (profileId: string, target: unknown) => {
 const active = getSession();
            if (!active) throw httpError(409, "This Web page belongs to a closed Pi session.");
            const profile = (await active.comfyUi.profiles([profileId]))[0];
            if (!profile) throw httpError(404, "ComfyUI profile was not found.");
            // 模块身份经适配器解析，宿主不再自行按 id 查找（见 rp-image-adapter.ts 的说明）。
            const image = await resolveImageModuleContext(active.featureModules);
            if (!image) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const paths: Record<string, string> = { profile: resolve(profile.directory, "profile.json"), workflow: resolve(profile.directory, "workflow.api.json"), guide: resolve(image.moduleDirectory, "skill", "guides", profile.guideId, "SKILL.md") };
            if (typeof target !== "string" || !paths[target]) throw httpError(400, "Document target must be profile, workflow, or guide.");
            await readFile(paths[target], "utf8"); await openLocalDocument(paths[target]);
            return { opened: true, path: relative(active.context.cwd, paths[target]).replaceAll("\\", "/") };
          },
getComfyRenderImage: async (renderId: string, outputIndex: number, preview: unknown) => {
 const active = getSession();
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before viewing generated images.");
            const store = createSessionDataStore({ sessionDirectory: active.sessionDirectory, featureModules: active.featureModules });
            const renderCtx = await resolveImageModuleContext(active.featureModules);
            if (!renderCtx) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const renderData = createImageDataFacade({ webApi: renderCtx.webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active.turn });
            const render = (await renderData.readRenders()).records.find(item => item.id === renderId);
            if (!render) throw httpError(404, "Image render record was not found.");
            const output = render.data.outputs?.[outputIndex];
            if (!output) throw httpError(404, "Image output was not found.");
            const cleanPreview = typeof preview === "string" && /^(webp|jpeg);\d{1,3}$/.test(preview) ? preview : null;
            return active.comfyUi.view({ connectionId: render.data.connectionId, output, preview: cleanPreview });
          },
regenerateComfyRender: async (renderId: string, contentPrompt: string, scope: "current" | "all", operationId: string) => {
 const active = getSession();
            if (!active?.sessionDirectory) throw httpError(409, "Start or resume a chat before regenerating images.");
            const store = createSessionDataStore({ sessionDirectory: active.sessionDirectory, featureModules: active.featureModules });
            const regenCtx = await resolveImageModuleContext(active.featureModules);
            if (!regenCtx) throw httpError(409, "The ComfyUI feature module is not loaded.");
            const regenData = createImageDataFacade({ webApi: regenCtx.webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active.turn });
            const requestState = await regenData.readRequests();
            const renderState = await regenData.readRenders();
            const source = regenCtx.webApi.regenerationSource(requestState.records, renderState.records, renderId, contentPrompt, scope);
 if (!source) throw httpError(404, "Source image request or render was not found.");
 const { request: sourceRequest, render: sourceRender, profileIds, ordinal, editedContentPrompts, derivedFrom } = source;
 const profiles = await active.comfyUi.profiles(profileIds);
 if (!profiles.length) throw httpError(409, "The adapted profile is no longer available.");
 const image = regenCtx;
 const execution: any = await loadImageExecution(image.webApi, image.moduleDirectory, `web=${Date.now()}`);
            const access = image.webApi.ACCESS.requests;
            const data = createWebDataAccess({ store, access, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn: active?.turn || 0 });


            const definition = execution.buildImageOperation({ operationId, ordinal, source: sourceRequest.data, profiles, contentPrompts: editedContentPrompts, chatFolder: sourceRender.data.chatFolder, services: { comfy: active.comfyUi }, derivedFrom, intent: { operationId, profileIds, inputPolicy: { kind: sourceRequest.data.sourceKind }, userDirection: sourceRequest.data.userDirection, derivedFrom, editedContentPrompts } });
            const ensured = await execution.ensureImageOperation({ data, definition });
            imageExecutionGuard.run(definition.requestId, () =>
              execution.executeImageOperation({ data, services: { comfy: active.comfyUi }, requestId: definition.requestId, renders: ensured.renders }));
            return { accepted: true, requestId: definition.requestId, renderIds: ensured.renders.map((item: any) => item.id) };
          }
};
}
