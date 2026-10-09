// 卡内容装载：从卡目录读取并归一化功能模块、上下文处理器与检索策略（S5 批次 1）。
//
// 本模块只做"读取 + 校验 + 归一化"：接受已解析的卡目录绝对路径与原始 JSON 值，返回归一化结果。
// 它不持有会话状态、不访问宿主闭包、不写文件，因此可以独立测试（见同目录 rp-card-content.test.mjs）。
//
// 从 `../extensions/pi-rp-web.ts` 原样搬出，函数体与类型注解均未改写。
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { loadModuleComponents } from "./rp-module-registry.mjs";
import { normalizeDataContract } from "./rp-data-contracts.mjs";
import { normalizeResourceCatalog } from "./rp-resource-catalog.mjs";
import { normalizeModuleFrontendView } from "./rp-module-frontend.mjs";
import { assertLoadableSkill } from "./rp-skill-contract.mjs";
import { canonicalWorkflowRef } from "./rp-workflows.mjs";
import { normalizeRetrievalPolicy, selectRecords } from "./rp-records.mjs";
import { validateContextProcessorDefinition } from "./rp-context-processors.mjs";

// 宿主的类型定义用 import type 引入：这是纯类型导入，编译后不产生任何运行期引用，
// 因此不会与宿主形成循环依赖。这样"搬出的接口"与宿主始终同形，不需要复制一份声明。
import type { ContextProcessor, FeatureModule, RetrievalPolicy } from "./rp-host-types.ts";

export {
  readCardContextFile,
  readContextProcessors,
  readFeatureModules,
  readMessageRetrievalPolicy,
  readMessageRetrievalSkill,
  resolveCardChild,
  resolveFeatureModuleChild,
  runtimeRetrievalPolicy,
};

function resolveCardChild(cardDirectory: string, path: string) {
  const target = resolve(cardDirectory, path);
  const relation = relative(cardDirectory, target);
  if (!relation || relation.startsWith("..") || resolve(cardDirectory, relation) !== target) return null;
  return target;
}

async function readCardContextFile(cardDirectory: string, value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`${label} must be one relative file path.`);
  const path = resolveCardChild(cardDirectory, value);
  if (!path) throw new Error(`${label} path escapes the card directory: ${value}`);
  return `## ${value}\n${(await readFile(path, "utf8")).trim()}`;
}

function resolveFeatureModuleChild(moduleDirectory: string, path: unknown, label: string) {
  // 绝对路径必须在这里就拒绝：POSIX 绝对路径经 resolve 后恰好等于自身，相对关系仍成立，
  // 于是"越界"检查会放行它，只剩位置相关的错误文案。显式拒绝绝对路径才是正确的规则。
  if (typeof path !== "string" || !path || path.includes("\\") || isAbsolute(path)) throw new Error(`${label} must be a safe relative path.`);
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
    const components = await loadModuleComponents(resolve(modulePath, ".."));
    const record = components;
    if (ids.has(record.id)) throw new Error(`Duplicate feature-module id: ${record.id}`);
    ids.add(record.id);
    const moduleDirectory = resolve(modulePath, "..");
    const viewPath = record.frontendViewFile ? resolveFeatureModuleChild(moduleDirectory, record.frontendViewFile, `${record.id}.frontendViewFile`) : null;
    const contractPath = record.dataContractFile ? resolveFeatureModuleChild(moduleDirectory, record.dataContractFile, `${record.id}.dataContractFile`) : null;
    const resourceCatalogPath = record.resourceCatalogFile ? resolveFeatureModuleChild(moduleDirectory, record.resourceCatalogFile, `${record.id}.resourceCatalogFile`) : null;
    const skillPath = resolveFeatureModuleChild(moduleDirectory, record.skillFile, `${record.id}.skillFile`);
    const workflowPaths = record.workflowFiles.map((path: string) => resolveFeatureModuleChild(moduleDirectory, path, `${record.id}.workflowFiles`));
    const [view, rawContract, rawResourceCatalog, skillText, rawWorkflows] = await Promise.all([
      viewPath ? readFile(viewPath, "utf8").then(JSON.parse) : null,
      contractPath ? readFile(contractPath, "utf8").then(JSON.parse) : null,
      resourceCatalogPath ? readFile(resourceCatalogPath, "utf8").then(JSON.parse) : null,
      readFile(skillPath, "utf8"),
      Promise.all(workflowPaths.map((path: string) => readFile(path, "utf8").then(JSON.parse))),
    ]);
    const contract = rawContract ? normalizeDataContract(rawContract, record.id) : null;
    const resourceCatalog = rawResourceCatalog ? normalizeResourceCatalog(rawResourceCatalog, record.id) : null;
    const normalizedView = view && contract ? normalizeModuleFrontendView(view, contract) : { schemaVersion: 1, regions: [] };
    const workflows = components.workflows;
    for (const workflow of workflows) {
      if (workflow.ownerModuleId !== record.id) {
        throw new Error(`Feature module ${record.id} may own only module workflows whose ownerModuleId matches the module.`);
      }
    }
    const refs = workflows.map(canonicalWorkflowRef);
    if (new Set(refs).size !== refs.length) throw new Error(`Feature module ${record.id} declares duplicate workflow references.`);
    modules.push({
      agents: components.agents,
      id: record.id,
      moduleKind: record.moduleKind,
      title: record.title.trim(),
      description: record.description.trim(),
      surface: record.surface,
      contextOrder: record.contextOrder,
      displayOrder: record.displayOrder,
      basedOn: record.basedOn,
      contract,
      resourceCatalog,
      resourceCatalogPath,
      view: normalizedView,
      viewPath,
      moduleDirectory,
      skillPath,
      skillDescription: assertLoadableSkill(skillText, `${record.id}.skillFile`).description,
      workflows,
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
      if (!module.contract?.collections[query.collectionId]) throw new Error(`Context processor ${definition.id} requires unknown collection ${query.moduleId}/${query.collectionId}.`);
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
  const enabled = policy.agent.mode !== "disabled";
  if (!enabled && path === undefined) return { path: null, description: "" };
  if (typeof path !== "string") throw new Error("manifest context_skill is required when message Agent retrieval is enabled.");
  const skillPath = resolveCardChild(cardDirectory, path);
  if (!skillPath) throw new Error("manifest context_skill escapes the card directory.");
  const text = await readFile(skillPath, "utf8");
  return { path: skillPath, description: assertLoadableSkill(text, "context_skill").description };
}
