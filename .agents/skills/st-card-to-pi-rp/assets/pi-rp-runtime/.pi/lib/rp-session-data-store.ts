// 按会话构造数据 store 的唯一装配点（S5 批次 4）。
//
// 此前宿主在 17 处各自 `new RpDataStore({ sessionDirectory, modules: dataModuleBindings(...) })`，
// 其中 15 处逐字相同。重复的代价是真实的：任何"该带哪些模块、要不要带初始覆盖"的改动都必须
// 在 17 个地方同时正确，漏掉一处就是一个静默的行为差异。
//
// 本模块把两件事收敛到一处：
//   1. 哪些模块参与数据层（`dataModuleBindings`：只取声明了数据契约的模块）；
//   2. 构造 store 时必须带上的会话与可选覆盖。
import { RpDataStore } from "./rp-data-store.mjs";

// 纯类型导入：编译后不产生运行期引用，因此不与宿主形成循环依赖。
import type { FeatureModule } from "./rp-host-types.ts";

/**
 * 数据模块绑定：只有声明了数据契约的模块参与数据层。
 * 资源模块没有契约，因此不得出现在绑定里（否则会伪造出空集合）。
 */
export function dataModuleBindings(modules: FeatureModule[]) {
  return modules
    .filter((module) => module.contract)
    .map((module) => ({ contract: module.contract, moduleDirectory: module.moduleDirectory }));
}

/**
 * 按会话构造数据 store。所有需要 store 的位置都必须经过这里。
 *
 * `initialOverrides` 与 `playerName` 是**可选**的：这里显式声明它们可选，否则 TypeScript 会把
 * "解构但无默认值"的参数推断为必填，从而在每个调用点报缺字段。
 */
export function createSessionDataStore({
  sessionDirectory,
  featureModules,
  initialOverrides,
  playerName,
}: {
  sessionDirectory: string;
  featureModules: FeatureModule[];
  initialOverrides?: Record<string, any>;
  playerName?: string | null;
}) {
  return new RpDataStore({
    sessionDirectory,
    modules: dataModuleBindings(featureModules),
    ...(initialOverrides === undefined ? {} : { initialOverrides }),
    ...(playerName === undefined ? {} : { playerName }),
  });
}
