// 配置目录装配的**唯一实现**（实施方案 S4）。
//
// 开发模式（无卡预览）与单卡游玩模式都必须调用这里的构造函数，只在"模块来源、文件读取、
// 作用域与权限"上不同。此前两处各有一份实现，并且已经产生真实差异：
//   - 卡侧把设置集合硬编码为 `settings`，而 `narrative-memory` 的设置放在 `support` 集合，
//     于是该模块在卡内永远只得到空默认值；
//   - 开发侧只读 `initialSnapshotFile`，不支持 `initialRecordsFile`；
//   - 两处都只按 recordId/recordType 取"第一条匹配"，不做精确的记录身份判定。
//
// 本模块因此按 frontend-view 的 `settings-form` 区域声明（collectionId / recordType /
// recordId）与 data-contract 的 storage 读取，不假定集合名，也不默认取数组第一条。

/** 工作流可编辑字段的声明。两种宿主共用同一份，不得各自实现。 */
export function workflowConfigFields(workflow) {
  const fields = [];
  if (workflow?.kind === "foreground") {
    fields.push({ path: "/turnContext/recentCompleteTurns", label: "最近完整正文回合数", type: "integer", minimum: 1, maximum: 50, help: "决定正文 Agent 和依赖正文快照的工作流可读取多少个最近完整回合；下一次工作流实例生效。" });
  }
  if (workflow?.defaults && typeof workflow.defaults === "object") {
    fields.push({ path: "/defaults/agentId", label: "默认 Agent", type: "agent", help: "节点没有单独指定 Agent 时使用；下一次工作流实例生效。" });
    fields.push({ path: "/defaults/modelId", label: "默认模型", type: "model", help: "节点和 Agent 都没有更高优先级模型时使用；下一次工作流实例生效。" });
  }
  for (let index = 0; index < (workflow?.nodes || []).length; index += 1) {
    const node = workflow.nodes[index];
    if (node?.type !== "agent") continue;
    fields.push({ path: `/nodes/${index}/agentId`, label: `${node.title || node.id} · Agent`, type: "agent", help: `${node.description || "Agent 节点"} 修改只影响之后启动的实例。` });
    fields.push({ path: `/nodes/${index}/modelId`, label: `${node.title || node.id} · 模型`, type: "model", help: "节点级模型覆盖，优先于工作流和 Agent 默认模型；下一次实例生效。" });
  }
  return fields;
}

/** 模块限定引用。两种宿主必须生成同一形式，否则覆盖会落在不同键上。 */
export function ownerQualifiedReference(kind, moduleId, componentId) {
  return `module/${moduleId}/${kind}/${String(componentId).split("/").at(-1)}`;
}

/** 组件目录项：Agent 与工作流共用同一 shape（工作流多一个 `fields`）。 */
export function componentEntry({ kind, moduleId, moduleTitle, value }) {
  return {
    key: ownerQualifiedReference(kind, moduleId, value.id),
    group: `模块 · ${moduleTitle || moduleId}`,
    moduleId,
    base: value,
    ...(kind === "workflow" ? { fields: workflowConfigFields(value) } : {}),
  };
}

/**
 * 解析一个 `settings-form` 区域的作者默认值。
 *
 * 契约要求：
 * - 集合身份来自区域声明（`collectionId`），**不假定集合名**；
 * - 两种初始化来源（`initialSnapshotFile` / `initialRecordsFile`）都支持；
 * - 记录选择必须明确：优先 `recordId`，其次 `recordType`；两者都无法唯一确定时报错，
 *   而不是静默取第一条。
 */
export async function resolveSettingsRegionDefaults({ region, contract, readDocument, label = "settings-form region" }) {
  const collection = contract?.collections?.[region?.collectionId];
  if (!collection) return { base: {}, source: null, reason: `${label}.collectionId ${String(region?.collectionId)} 不在数据契约中` };
  const storage = collection.storage || {};
  const snapshotFile = storage.initialSnapshotFile;
  const recordsFile = storage.initialRecordsFile;
  if (!snapshotFile && !recordsFile) {
    return { base: {}, source: null, reason: `${label} 的集合既没有 initialSnapshotFile 也没有 initialRecordsFile` };
  }

  // 快照集合：单个记录对象（或其 data）。
  if (snapshotFile) {
    const raw = await readDocument(snapshotFile);
    if (raw == null) return { base: {}, source: snapshotFile, reason: `${label} 的 initialSnapshotFile 不存在` };
    const records = Array.isArray(raw) ? raw : [raw];
    const selection = selectRecord(records.filter(Boolean), region, label);
    if (selection.error) return { base: {}, source: snapshotFile, reason: selection.error };
    if (!selection.record) return { base: {}, source: snapshotFile, reason: `${label} 在 initialSnapshotFile 中找不到声明的记录` };
    return { base: readDefaults(selection.record), source: snapshotFile, reason: null };
  }

  // 记录日志集合：必须是记录数组，且按 recordId/recordType 精确选择。
  const raw = await readDocument(recordsFile);
  if (raw == null) return { base: {}, source: recordsFile, reason: `${label} 的 initialRecordsFile 不存在` };
  if (!Array.isArray(raw)) return { base: {}, source: recordsFile, reason: `${label} 的 initialRecordsFile 必须是记录数组` };
  const selection = selectRecord(raw, region, label);
  if (selection.error) return { base: {}, source: recordsFile, reason: selection.error };
  if (!selection.record) return { base: {}, source: recordsFile, reason: `${label} 在 initialRecordsFile 中找不到声明的记录` };
  return { base: readDefaults(selection.record), source: recordsFile, reason: null };
}

/**
 * 按 recordId 优先、recordType 其次精确选择。
 *
 * 返回 `{record}`、`{record: null}`（确实没有）或 `{error}`（**歧义**）。
 * 歧义必须由调用方报告，不能静默取第一条——那会把"选错了记录"变成看不出来的错误。
 */
function selectRecord(records, region, label) {
  if (!records.length) return { record: null, error: null };
  if (typeof region?.recordId === "string" && region.recordId) {
    const byId = records.filter((item) => item?.id === region.recordId);
    if (byId.length === 1) return { record: byId[0], error: null };
    if (byId.length > 1) return { record: null, error: `${label} 的 recordId ${region.recordId} 在该集合中出现多次，无法确定唯一记录` };
    return { record: null, error: `${label} 找不到指定的 recordId ${region.recordId}` };
  }
  if (typeof region?.recordType === "string" && region.recordType) {
    const byType = records.filter((item) => item?.recordType === region.recordType);
    if (byType.length === 1) return { record: byType[0], error: null };
    if (byType.length > 1) return { record: null, error: `${label} 的 recordType ${region.recordType} 匹配到 ${byType.length} 条记录，且 recordId 无法唯一确定，拒绝静默取第一条` };
  }
  return { record: null, error: null };
}

function readDefaults(record) {
  return record?.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
}

/**
 * 生成一个模块的目录项。
 *
 * `defaults` 为作者默认值时，`overrides` 是配置方案覆盖层；调用方必须**分别持有**两者，
 * 不能把有效值再当成默认值返回。
 */
export async function moduleCatalogEntry({ module, readDocument }) {
  const view = module.view ?? null;
  const contract = module.contract ?? null;
  const regions = (view?.regions || []).filter((region) => region?.type === "settings-form");

  const fields = [];
  const defaults = {};
  const problems = [];
  const seenFieldPaths = new Map();

  for (const region of regions) {
    const resolved = await resolveSettingsRegionDefaults({ region, contract, readDocument, label: `module ${module.id} region ${region.id}` });
    if (resolved.reason) problems.push(resolved.reason);
    // 同一字段路径在多个区域重复出现时记录来源，避免"平铺字段互相覆盖"被静默接受。
    for (const field of region.fields || []) {
      const previous = seenFieldPaths.get(field.path);
      if (previous && previous !== region.id) {
        problems.push(`字段 ${field.path} 同时出现在区域 ${previous} 与 ${region.id}；两者的集合/记录身份必须明确区分`);
        throw new Error(`模块 ${module.id} 的字段 ${field.path} 在区域 ${previous} 与 ${region.id} 中冲突，无法生成无歧义配置`);
      }
      seenFieldPaths.set(field.path, region.id);
      fields.push({ ...field, help: field.help || region.description || module.description, applyMode: "new-session", regionId: region.id });
    }
    Object.assign(defaults, resolved.base);
  }

  return {
    id: module.id,
    title: module.title || module.id,
    description: module.description || "",
    base: defaults,
    fields,
    problems,
  };
}

/**
 * 构造完整配置目录。
 *
 * @param {object} options
 * @param {Array<object>} options.modules 已经过模块注册表/契约归一化的模块对象（含 contract、view）。
 * @param {(relativePath: string, module: *) => Promise<*>} options.readModuleDocument
 *        读取模块内相对路径的 JSON；返回 null 表示不存在。`module` 是宿主自己的模块对象形状
 *        （开发侧是模块清单，卡侧是 FeatureModule），本模块只把它透传回调用方，不使用其结构。
 * @param {() => Promise<Array<object>>} [options.listAgents] 提供 Agent 目录项 base 的宿主实现。
 * @param {() => Promise<Array<object>>} [options.listWorkflows] 提供工作流目录项 base 的宿主实现。
 * @param {boolean} [options.includeRuntimePolicy] 是否包含运行策略（单卡模式需要，开发预览也需要）。
 * @param {() => Promise<any>} [options.getRuntimePolicy]
 */
export async function buildConfigCatalog({ modules, readModuleDocument, listAgents, listWorkflows, includeRuntimePolicy = false, getRuntimePolicy }) {
  const agents = [];
  const workflows = [];

  if (typeof listAgents === "function") {
    for (const item of await listAgents()) {
      agents.push(componentEntry({ kind: "agent", moduleId: item.moduleId, moduleTitle: item.moduleTitle, value: item.base ?? item.effective }));
    }
  }
  if (typeof listWorkflows === "function") {
    for (const item of await listWorkflows()) {
      workflows.push(componentEntry({ kind: "workflow", moduleId: item.ownerModuleId ?? item.moduleId, moduleTitle: item.moduleTitle, value: item.base ?? item }));
    }
  }

  const moduleEntries = [];
  for (const module of modules) {
    moduleEntries.push(await moduleCatalogEntry({
      module,
      readDocument: (relativePath) => readModuleDocument(relativePath, module),
    }));
  }

  const catalog = { schemaVersion: 1, agents, workflows, modules: moduleEntries };
  if (includeRuntimePolicy && typeof getRuntimePolicy === "function") {
    catalog.runtimePolicy = await getRuntimePolicy();
  }
  return catalog;
}
