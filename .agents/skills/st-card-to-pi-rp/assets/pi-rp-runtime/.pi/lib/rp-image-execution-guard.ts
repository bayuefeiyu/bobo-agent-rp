// 生图操作的去重闸门与 Web 侧数据访问装配（S5 批次 7 / S7 前置）。
//
// 两处独立但相邻的重复：
//
// 1. **同一生图请求只能执行一次**。卡片前端可能在同一会话的多个页面、或"渲染恢复"与
//    "生成衍生图"两条路径上重复提交同一个 requestId。原实现用模块级 `Map` 记录在途任务，
//    两处各写一遍 `has`/`new Promise`/`finally(delete)` 的组合 —— 漏掉 `finally` 就会永久
//    卡住该 requestId，将来永远不再执行。这里收敛为一处，并让"被去重"可被显式断言。
//
// 2. **Web 侧的数据访问装配**（`constraints` + `data`）逐字重复了两次。

/**
 * 生图执行去重闸门。
 *
 * **作用域是模块级**，与原实现（模块级 `Map`）保持一致：去重是"同一 requestId 不得并发执行
 * 两次"，而不是"每个会话各自去重"。把它改成闭包级会**放宽**这个不变量，属于行为变更，
 * 因此这里保留模块级状态；实例只是同一份状态上的读写入口。
 */
const inFlightImageExecutions = new Map<string, Promise<unknown>>();

/**
 * 不接收任何会话状态：它只按 `requestId` 记住"在途任务"，因此可以独立测试。
 */
export function createImageExecutionGuard() {
  const inFlight = inFlightImageExecutions;
  return {
    /** 该 requestId 是否已有在途任务（供调用方给出不同的返回体）。 */
    alreadyRunning(requestId: string) {
      return inFlight.has(requestId);
    },
    /**
     * 启动任务；若该 requestId 已有在途任务则直接复用，不重复启动。
     *
     * `onError` 默认为 `console.error`：生图失败不应让页面收到未处理的 rejection。
     */
    run(requestId: string, start: () => Promise<unknown>, onError: (error: unknown) => void = console.error) {
      const existing = inFlight.get(requestId);
      if (existing) return existing;
      const task = start()
        .catch(onError)
        .finally(() => { inFlight.delete(requestId); });
      inFlight.set(requestId, task);
      return task;
    },
    /** 仅供测试：当前在途的 requestId。 */
    inFlightIds() {
      return [...inFlight.keys()];
    },
    /** 仅供测试：清空模块级在途状态，避免用例之间互相影响。 */
    reset() {
      inFlight.clear();
    },
  };
}

/**
 * 把 Web 请求带来的模块访问声明装配成数据读写能力。
 *
 * 两条路径（渲染恢复、生成衍生图）此前各自复制了同一段 `constraints` + `data`。
 * 这里保留原有的宽松预算（Web 侧由页面交互驱动，不套用节点查询预算），并保留
 * "提交者记为 user/web" 这一来源标注。
 */
export function createWebDataAccess({
  store,
  access,
  queryData,
  getDataRecord,
  executeDataBatchOrThrow,
  currentTurn,
}: {
  store: any;
  access: Array<{ moduleId: string; collectionId: string; capabilities: unknown; views: unknown }>;
  queryData: (store: any, request: any, constraints: any) => unknown;
  getDataRecord: (store: any, request: any, constraints: any) => unknown;
  executeDataBatchOrThrow: (store: any, draft: any, options: any) => unknown;
  currentTurn: number;
}) {
  const constraints = (collectionId: string) => {
    const item = access.find((candidate) => candidate.collectionId === collectionId);
    if (!item) throw new Error(`Web data access has no declaration for collection ${collectionId}.`);
    return { capabilities: item.capabilities, views: item.views, runtimeLimit: 1000, runtimeCharacters: 1000000, nodeLimit: 1000, nodeCharacters: 1000000 };
  };
  return {
    query: (request: any) => queryData(store, request, constraints(request.collectionId)),
    get: (request: any) => getDataRecord(store, request, constraints(request.collectionId)),
    submit: (draft: any) => executeDataBatchOrThrow(store, draft, {
      access,
      context: { initiatorKind: "user", initiatorId: "web", binding: { turn: currentTurn, messageId: null } },
    }),
  };
}
