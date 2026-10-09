// 宿主侧的生图适配器（实施方案 S7）。
//
// 职责边界：
//   - **模块拥有**：模块 ID、集合名、能力名、授权声明、内部执行文件路径与加载方式
//     （见 `global-modules/comfy-image-generation/runtime/web-api.mjs`）。
//   - **宿主拥有**：通用连接/HTTP 传输、鉴权、会话身份、通用数据服务与工作流启动
//     （即本文件接收的那些能力）。
//
// 宿主因此不再直接拼"生图专属集合名"或"内部执行文件路径"；它只说
// "给我这个模块的数据门面 / 执行实现"，由模块决定怎么做。
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FeatureModule } from "./rp-host-types.ts";
import type { createWebDataAccess as makeWebDataAccess } from "./rp-image-execution-guard.ts";

type ImageWebApi = typeof import("../../../../../../../global-modules/comfy-image-generation/runtime/web-api.mjs");
type WebAccessOptions = Parameters<typeof makeWebDataAccess>[0];
type FacadeOptions = Omit<WebAccessOptions, "access"> & { webApi: ImageWebApi; createWebDataAccess: typeof makeWebDataAccess };

/**
 * 加载生图模块的稳定入口 `runtime/web-api.mjs`。
 *
 * 与内部执行实现不同，入口本身**不**需要每请求重载：它是声明式常量与纯函数装配，
 * 不含会话状态。因此按模块目录缓存，避免每次操作都重新解析模块图。
 */
const apiCache = new Map<string, ImageWebApi>();

export async function loadImageWebApi(moduleDirectory: string, importModule: (url: string) => Promise<ImageWebApi> = (url) => import(url)) {
  const cached = apiCache.get(moduleDirectory);
  if (cached) return cached;
  // 用 join 而不是字符串拼接：模板拼接在 Windows 上会产生混合分隔符甚至相对路径片段。
  const url = pathToFileURL(join(moduleDirectory, "runtime", "web-api.mjs")).href;
  const api = await importModule(url);
  apiCache.set(moduleDirectory, api);
  return api;
}

/** 仅供测试：清空入口缓存，使替身与真实实现互不污染。 */
export function resetImageWebApiCache() {
  apiCache.clear();
}

/**
 * 模型数据门面：集合名与授权声明全部来自模块入口。
 *
 * 原实现里 `store.readCollection("comfy-image-generation", "requests")` 这类调用在宿主中
 * 出现了 7 次，把模块的数据布局写死在公共 bridge 里。这里收成一处，
 * 宿主只说"读这个模块的请求集合"。
 */
export function createImageDataFacade({ webApi, createWebDataAccess, store, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn }: FacadeOptions) {
  const accessFor = (access: WebAccessOptions["access"]) => createWebDataAccess({ store, access, queryData, getDataRecord, executeDataBatchOrThrow, currentTurn });
  const read = (access: WebAccessOptions["access"], collectionId: string) => webApi.readWebRecords(accessFor(access), collectionId);

  return {
    /** settings 集合（生图偏好）。 */
    readSettings: () => read(webApi.ACCESS.preferencesConfigure, webApi.COLLECTIONS.settings),
    /** requests 集合。 */
    readRequests: () => read(webApi.ACCESS.requests, webApi.COLLECTIONS.requests),
    /** renders 集合。 */
    readRenders: () => read(webApi.ACCESS.requests, webApi.COLLECTIONS.renders),
    /** 交给模块执行实现的受控数据服务（形状与原先传入的 `data` 一致）。 */
    dataFor: (access: WebAccessOptions["access"]) => accessFor(access),
  };
}

/**
 * 加载生图模块内部执行实现。
 *
 * 宿主原先直接拼 `resolve(module.moduleDirectory, "runtime", "image-execution.mjs")`，
 * 把模块内部文件布局写进了公共 bridge。现在由模块入口决定路径与加载方式。
 */
export async function loadImageExecution(webApi: ImageWebApi, moduleDirectory: string, cacheKey: string) {
  return webApi.loadExecution({ moduleDirectory, cacheKey, pathToUrl: (path: string) => pathToFileURL(path).href });
}

/**
 * 生图模块的**身份**。这是公共宿主唯一需要知道的生图专属字符串。
 *
 * 为什么只留这一个：宿主必须能在已装载的模块里"找到生图模块"，而模块目录是**运行期**从
 * 卡片清单的 `feature_modules` 解析出来的（开发期指向 `global-modules/`，打包后指向卡内
 * 由 `module.json` 决定的位置）。因此宿主不能在编译期静态导入模块常量——那样在卡包里会
 * 解析到别处。宿主只按身份查找，其余细节（集合名、能力名、recordType、授权声明、内部执行
 * 文件路径）一律在运行期向模块入口询问。
 */
const IMAGE_MODULE_ID = "comfy-image-generation";

/** 按身份在已装载模块中查找生图模块；未装载时返回 null（方案 §12 第 6 条）。 */
export function findImageModule(featureModules: FeatureModule[]) {
  return (featureModules || []).find((module) => module?.id === IMAGE_MODULE_ID) || null;
}

/**
 * 取出一个操作所需的全部模块侧信息。
 *
 * 返回 `null` 表示模块未装载——调用方据此按"能力不可用"处理，而不是抛错，
 * 使宿主其余功能不受影响。
 */
export async function resolveImageModuleContext(featureModules: FeatureModule[]) {
  const module = findImageModule(featureModules);
  if (!module?.moduleDirectory) return null;
  const webApi = await loadImageWebApi(module.moduleDirectory);
  return { module, moduleDirectory: module.moduleDirectory, webApi };
}
