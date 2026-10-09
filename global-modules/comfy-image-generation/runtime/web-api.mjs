// 生图模块的稳定语义入口（实施方案 S7）。
//
// 设计目标：**公共宿主不再知道**模块 ID、集合名、能力名、recordType 与内部执行文件路径。
// 这些细节由模块自己拥有并在此声明；宿主只通过本文件导出的能力调用模块语义。
//
// 本文件是模块的公开边界，因此：
//   - 不导出内部实现（如 `image-execution.mjs` 的路径）；
//   - 只暴露"宿主需要的语义操作"，而不是让宿主自己拼记录；
//   - 保持可测试：接受的依赖都通过参数注入（不读取全局状态）。

/** 模块身份与数据布局。宿主**不得**再重复书写这些字符串。 */
export const MODULE_ID = "comfy-image-generation";

export const COLLECTIONS = Object.freeze({
  settings: "settings",
  requests: "requests",
  renders: "renders",
});

/** 数据能力名。宿主只把它们透传给数据服务，不自行判断。 */
export const CAPABILITIES = Object.freeze({
  preferencesRead: "image.preferences.read",
  preferencesConfigure: "image.preferences.configure",
  requestsPrepare: "image.requests.prepare",
  rendersExecute: "image.renders.execute",
});

/**
 * 各集合的操作所需授权声明。
 *
 * 对应原先散落在宿主里的三段 `access` 字面量。放在这里之后，
 * "哪个操作需要哪个能力/视图"由模块定义，宿主不再复制。
 */
export const ACCESS = Object.freeze({
  preferences: [{ moduleId: MODULE_ID, collectionId: COLLECTIONS.settings, capabilities: [CAPABILITIES.preferencesRead], views: ["rp"] }],
  /** 偏好写入需要 configure 能力（读取用 preferences）。 */
  preferencesConfigure: [{ moduleId: MODULE_ID, collectionId: COLLECTIONS.settings, capabilities: [CAPABILITIES.preferencesConfigure], views: ["maintenance"] }],
  requests: [
    { moduleId: MODULE_ID, collectionId: COLLECTIONS.requests, capabilities: [CAPABILITIES.requestsPrepare], views: ["maintenance"] },
    { moduleId: MODULE_ID, collectionId: COLLECTIONS.renders, capabilities: [CAPABILITIES.rendersExecute], views: ["maintenance"] },
  ],
});

export const RECORD_TYPES = Object.freeze({ preferences: "image.preferences", request: "image.request", render: "image.render" });

// Web 操作需要完整数据；普通 Agent 的 rp 投影仍保持原授权，不扩大其可见字段。
const RECORD_VIEW_FIELDS = Object.freeze({ settings: "设置", requests: "请求", renders: "生成记录" });

/** @returns {Promise<{records:Array<{id:string,recordType:string,revision:number,data:Record<string,any>}>}>} */
export async function readWebRecords(data, collectionId) {
  const records = [];
  const seen = new Set();
  let cursor = null;
  do {
    const page = await data.query({ moduleId: MODULE_ID, collectionId, view: "maintenance", cursor });
    for (const item of page.items) {
      const value = item.value?.[RECORD_VIEW_FIELDS[collectionId]];
      if (!value || typeof value !== "object") throw new Error(`Invalid image ${collectionId} maintenance projection.`);
      records.push({ id: item.id, recordType: item.recordType, revision: item.revision, data: value });
    }
    if (page.truncated && !page.nextCursor) throw new Error("Image query budget cannot deliver a complete record.");
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Image query pagination repeated a cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { records };
}

export function requestSummary(record) {
  const { ordinal, sourceKind, triggerKind, promptState, selectedProfileIds, dedupeKey, createdAt } = record.data;
  return { ...record, data: { ordinal, sourceKind, triggerKind, promptState, selectedProfileIds, dedupeKey, createdAt } };
}

export function preferenceUpdate(current, value, profiles, batchId, operationId) {
  const valid = new Set(profiles.map(item => item.id));
  const selectedProfileIds = Array.isArray(value.selectedProfileIds)
    ? [...new Set(value.selectedProfileIds.filter(id => typeof id === "string" && valid.has(id)))] : [];
  const inputPolicy = value.inputPolicy && typeof value.inputPolicy === "object" ? value.inputPolicy : current.data.inputPolicy;
  const next = { selectedProfileIds, quickMode: value.quickMode === true, inputPolicy };
  return { next, batch: { protocolVersion: 1, batchId, status: "pending", commitPolicy: "atomic", operations: [{ operationId, moduleId: MODULE_ID, collectionId: COLLECTIONS.settings, recordType: RECORD_TYPES.preferences, action: "update", targetId: current.id, expectedRevision: current.revision, data: next }] } };
}

export function recoverableRenders(renders, requestId) {
  return renders.filter(item => item.data.requestId === requestId && ["pending", "submitting", "submitted"].includes(item.data.state));
}

export function regenerationSource(requests, renders, renderId, contentPrompt, scope) {
  const render = renders.find(item => item.id === renderId);
  const request = requests.find(item => item.id === render?.data.requestId);
  if (!render || !request) return null;
  const promptByGuide = new Map(request.data.contentPrompts.map(item => [item.guideId, item.content]));
  promptByGuide.set(render.data.guideId, contentPrompt);
  return {
    request, render,
    profileIds: scope === "all" ? request.data.selectedProfileIds : [render.data.profileId],
    ordinal: Math.max(0, ...requests.map(item => Number(item.data.ordinal || 0))) + 1,
    editedContentPrompts: [...promptByGuide].map(([guideId, content]) => ({ guideId, content })),
    derivedFrom: { sourceRequestId: request.id, sourceRenderId: render.id, scope },
  };
}

/**
 * 模块拥有的组件引用。
 *
 * `entryWorkflow` 是"启动一次生图"要复制到卡内的工作流引用；`preferencesRecordId` 是生图偏好
 * 那条记录在 `settings` 集合中的固定 id。两者都是模块的内部约定，宿主原先把字面量写在自己里。
 */
export const COMPONENTS = Object.freeze({
  entryWorkflow: "comfy-image-generation/agent-image-generation-entry",
  preferencesRecordId: "image-preferences",
});

/**
 * 模块内部执行入口的**模块相对路径**。
 *
 * 宿主原先直接拼 `resolve(moduleDirectory, "runtime", "image-execution.mjs")`，
 * 即把内部文件布局写进了公共 bridge。这里保留该路径的实现细节，由模块负责加载自己。
 */
const INTERNAL_EXECUTION_ENTRY = ["runtime", "image-execution.mjs"];

/**
 * 加载模块内部执行实现。
 *
 * 保留原有的**热加载**语义：使用带时间戳的 query 强制绕过模块缓存（原实现为
 * `?recover=${Date.now()}` / `?regenerate=...`）。`cacheKey` 由调用方给出，
 * 使同一操作类型在同一进程内获得稳定且可断言的加载 URL。
 */
export async function loadExecution({ moduleDirectory, cacheKey = "runtime", importModule = (url) => import(url), pathToUrl }) {
  const { join } = await import("node:path");
  const target = join(moduleDirectory, ...INTERNAL_EXECUTION_ENTRY);
  const url = `${pathToUrl(target)}?${cacheKey}`;
  return importModule(url);
}

/**
 * 从已装载的功能模块中解析本模块。
 *
 * 宿主原先在 4 处各自写 `featureModules.find(item => item.id === "comfy-image-generation")`
 * 并各自抛错。判定"模块是否可用"属于模块身份，不应由宿主重复书写。
 */
export function resolveImageModule(featureModules) {
  return (featureModules || []).find((module) => module.id === MODULE_ID) || null;
}
