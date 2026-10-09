// 节点数据访问的冻结读原语（S5 批次 3）。
//
// 职责：给定一次工作流运行与数据 store，构造**受该运行冻结边界约束**的读取能力。
// 它不持有宿主状态、不写文件；依赖通过参数注入，因此可以脱离真实会话目录测试
// （见 rp-node-data-access.test.mjs）。
//
// 关键不变量：run 声明了 dataReadViewId 时，读取**必须**走该冻结视图；没有时只能按
// visibleThroughTurn / readSnapshotAt 的边界读。**不得退化为读取最新值。**
//
// 从 `../extensions/pi-rp-web.ts` 的闭包中搬出，逻辑与文案未改写；只去掉了闭包缩进，
// 并把两个读视图函数改为可注入参数（默认值即原实现）。
import { readDataReadViewCollection, resolveDataReadViewIdentity } from "./rp-data-read-view.mjs";
import { createSessionDataStore } from "./rp-session-data-store.ts";
// 纯类型导入：编译后不产生运行期引用，因此不与宿主形成循环依赖。
import type { FeatureModule, RpDataStore } from "./rp-host-types.ts";

export { currentDataNode, nodeDataAccess, requireCurrentAgentTool, resolveWorkflowIdentity, workflowDataReadAccess };

/**
 * 解析当前数据工具调用所属的节点。
 *
 * 只接受**窄接口**：会话目录、功能模块、一个按 runId 读取运行的访问器，以及当前 run 的 id 与节点 id。
 * 不接收整个宿主会话对象——那等于给出一个可任意修改所有状态的入口，方案 10 步骤 3 明确禁止。
 */
function currentDataNode({ sessionDirectory, featureModules, getRun, workflowRunId, narrativeNodeId }: {
  sessionDirectory?: string | null;
  featureModules: FeatureModule[];
  getRun: (runId: string) => any;
  workflowRunId?: string | null;
  narrativeNodeId?: string | null;
}) {
  if (!sessionDirectory || !workflowRunId) throw new Error("RP data tools require an active workflow node.");
  const entry = getRun(workflowRunId);
  const node = entry?.workflow?.nodes?.find((item: any) => item.id === narrativeNodeId);
  if (!entry || !node) throw new Error("The active RP workflow node is unavailable.");
  return { entry, node, store: createSessionDataStore({ sessionDirectory, featureModules }) };
}

/**
 * 节点的模块访问授权：节点必须显式声明对 `moduleId/collectionId` 的访问。
 *
 * 这是"授权资料交接和工作区白名单不扩大"的第一道闸门：没有声明就抛错，不回退到任何默认权限。
 */
function nodeDataAccess(node: any, moduleId: string, collectionId: string) {
  const access = node.moduleAccess?.find((item: any) => item.moduleId === moduleId && item.collectionId === collectionId);
  if (!access) throw new Error(`The current node has no access to ${moduleId}/${collectionId}.`);
  return access;
}

/**
 * 当前节点是否被授权使用某个 Agent 工具。
 *
 * 参数顺序与原宿主一致：`(entry, node, toolName, getAgent)`。
 * 原来通过闭包读 `active.configStore`，现在改为显式传入 `getAgent` 能力。
 */
async function requireCurrentAgentTool(
  entry: any,
  node: any,
  toolName: string,
  getAgent: (agentId: string) => Promise<{ effective?: { tools?: string[] } }>,
) {
  const agentId = node.agentId || entry.workflow.defaults?.agentId;
  if (!agentId) throw new Error(`The current workflow node has no Agent authorized for ${toolName}.`);
  const agent = (await getAgent(agentId)).effective;
  if (!agent?.tools?.includes(toolName)) throw new Error(`Agent ${agentId} is not authorized to use ${toolName}.`);
  return agent;
}

function workflowDataReadAccess(run: any, store: RpDataStore, batchIds: string[] = run.inheritedDataReadBatchIds || [], readCollection: typeof readDataReadViewCollection = readDataReadViewCollection) {
  if (run.dataReadViewId) {
    return {
      readCollection: (moduleId: string, collectionId: string) => readCollection({
        sessionDirectory: store.sessionDirectory,
        store,
        viewId: run.dataReadViewId,
        batchIds,
        moduleId,
        collectionId,
      }),
    };
  }
  return { visibleThroughTurn: run.visibleThroughTurn, visibleThroughTime: run.readSnapshotAt };
}

function resolveWorkflowIdentity(run: any, store: RpDataStore, value: string, batchIds: string[] = run.inheritedDataReadBatchIds || [], resolveIdentity: typeof resolveDataReadViewIdentity = resolveDataReadViewIdentity) {
  return run.dataReadViewId
    ? resolveIdentity({ sessionDirectory: store.sessionDirectory, store, viewId: run.dataReadViewId, batchIds, value })
    : store.resolveIdentity(value);
}
