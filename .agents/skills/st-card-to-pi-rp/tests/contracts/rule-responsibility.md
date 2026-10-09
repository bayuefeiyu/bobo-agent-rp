# 跨语言协议规则责任表（S3）

本文件回答一个问题：**同一条协议规则由哪一层负责校验**，以及各层采用哪个实现。

方案第 8 节要求"每类规则对应一份责任表"，并要求：

- 同一协议修改只需补充一份输入样例，即可同时验证两种实现；
- 各层无需执行的规则**显式标注**，而不是靠跳过变绿；
- 不要求各校验器输出完全相同的错误文本。

## 1. 两种实现与它们的分工

| 实现 | 位置 | 角色 |
| --- | --- | --- |
| 运行时归一化（JS） | `assets/pi-rp-runtime/.pi/lib/rp-*.mjs` | Play 与打包时**真正执行**的定义归一化：模块清单、工作流、数据契约、资源目录。 |
| 卡包校验器（Python） | `scripts/validate_card_pack.py` | 转卡与交付时的**静态校验**：除结构外还检查文件存在、组件注册、跨模块引用、来源与设计不变量。 |

两者都从同一份样例集消费：`tests/contracts/protocol-samples.json`。

- JS 侧：`tests/contracts/rp-contracts.test.mjs`
- Python 侧：`scripts/test_contract_samples.py`

## 2. 层次定义

| 层次标记 | 含义 | 谁执行 |
| --- | --- | --- |
| `runtime` | 只需要定义本身的规则（字段、类型、枚举、版本、节点组合、DAG） | 仅运行时归一化 |
| `cardpack` | 只有在卡包布局、文件系统与跨模块引用存在时才有意义的规则 | 仅 Python 校验器 |
| `runtime+cardpack` | 两侧都必须拒绝同一份输入 | 两侧 |

样例的 `layer` 字段即取自本表。JS 侧对 `layer == "cardpack"` 的样例显式跳过（并打印计入
"不适用"），不当作通过。

## 3. 规则责任表

### 3.1 结构契约（版本、字段、类型、枚举、组件归属、路径形式）

| 规则 ID | 规则 | 层次 | 权威实现 |
| --- | --- | --- | --- |
| `struct.module.schemaVersion` | 模块清单 `schemaVersion` 必须为 7 | runtime+cardpack | `rp-feature-modules.mjs` / `validate_card_pack.py` |
| `struct.module.fieldSet` | 模块清单必须使用 v7 精确字段集（多字段即拒绝） | runtime+cardpack | 同上 |
| `struct.module.kindFiles` | `data` 必须有 `dataContractFile`、`resource` 必须有 `resourceCatalogFile`、`hybrid` 两者都要 | runtime+cardpack | 同上 |
| `struct.module.surface` | 纯资源模块必须 `surface: background`；`frontend` 必须与 `frontendViewFile` 同时存在 | runtime+cardpack | 同上 |
| `struct.path.relative` | `dataContractFile`/`resourceCatalogFile`/`frontendViewFile`/`skillFile`/`agentFiles`/`workflowFiles` 必须是模块内相对路径 | runtime+cardpack | 同上 |
| `struct.workflow.schemaVersion` | 工作流 `schemaVersion` 必须为 4 | runtime+cardpack | `rp-workflows.mjs` / `validate_card_pack.py` |
| `struct.workflow.owner` | 工作流必须有 `ownerModuleId`，且 `id` 的模块前缀与之一致 | runtime+cardpack | 同上 |
| `struct.workflow.kindEnum` | `kind` 必须是 `foreground`/`turn-background`/`global-background`/`module-external`/`module-internal` | runtime+cardpack | 同上 |
| `struct.workflow.entryKind` | 入口种类可带触发、无需要求 `workflow-return` | runtime+cardpack | 同上 |
| `struct.workflow.callableKind` | 可调用工作流无触发、必须恰有一个 `workflow-return` | runtime+cardpack | 同上 |
| `struct.workflow.agentCallable` | 只有可调用工作流可声明 `agentCallable: true` | runtime+cardpack | 同上 |
| `struct.workflow.nodeTypeEnum` | 节点类型限 `agent`/`team`/`code`/`call`/`gate`/`join`/`workflow-return`/`turn-finalize` | runtime+cardpack | 同上 |
| `struct.workflow.nodesRequired` | 工作流至少一个节点 | runtime+cardpack | 同上 |
| `struct.datacontract.schemaVersion` | 数据契约 `schemaVersion` 必须为 1 | runtime+cardpack | `rp-data-contracts.mjs` / `validate_card_pack.py` |
| `struct.datacontract.moduleId` | 数据契约 `moduleId` 必须等于所属模块 | runtime+cardpack | 同上 |
| `struct.datacontract.fieldSet` | 数据契约只允许 `schemaVersion`/`moduleId`/`collections`/`capabilities` | runtime+cardpack | 同上 |
| `struct.catalog.schemaVersion` | 资源目录 `schemaVersion` 必须为 1 | runtime+cardpack | `rp-resource-catalog.mjs` / `validate_card_pack.py` |
| `struct.catalog.moduleId` | 资源目录 `moduleId` 必须等于所属模块 | runtime+cardpack | 同上 |
| `struct.catalog.documentFields` | 每篇文档必须使用 16 个精确字段 | runtime+cardpack | 同上 |
| `struct.catalog.choiceGroup` | `readPolicy: choice` 必须且只能声明 `selectionGroup` | runtime+cardpack | 同上 |
| `reject.unsupportedVersion` | 当前支持版本以外的输入必须被拒绝，不提供旧版本解析 | runtime+cardpack | 两侧 |

### 3.2 运行时语义（默认值归一化、调用权限、DAG、节点约束）

| 规则 ID | 规则 | 层次 | 权威实现 |
| --- | --- | --- | --- |
| `runtime.workflow.dag` | 节点依赖必须指向已声明节点，且不得自依赖 | runtime | `rp-workflows.mjs` |
| `runtime.workflow.nodeConstraints` | 节点级 `outputs` 作用域/保留期/种类、`turn-finalize` 的 narrative 必须指向已声明输出 | runtime | `rp-workflows.mjs` |
| `runtime.workflow.capability` | 节点只能调用自己 `workflowCalls` 明列的入口；Agent 只看到 `agentCallable` 入口 | runtime | `rp-workflows.mjs` / 调度器 |
| `runtime.datacontract.normalize` | 索引、视图、能力与动作的默认值与合法值归一化 | runtime | `rp-data-contracts.mjs` |
| `runtime.catalog.normalize` | 阅读策略、权威性、适用阶段的枚举与缺省值 | runtime | `rp-resource-catalog.mjs` |

**说明**：这些规则在 Python 侧**部分重复实现**（校验器也要拒绝悬空依赖等）。归入 `runtime`
的样例只由运行时断言；若将来 Python 侧也纳入同一条规则，应把该样例的 `layer` 改为
`runtime+cardpack`，而不是新增一份重复样例。

### 3.3 卡包关系（文件存在、组件注册、跨模块引用、数据访问声明）

| 规则 ID | 规则 | 层次 | 权威实现 |
| --- | --- | --- | --- |
| `cardpack.module.fileExists` | 清单声明的每个文件必须存在于卡内 | cardpack | `validate_card_pack.py` |
| `cardpack.component.registered` | 每个 Agent/工作流/节点入口/提示词必须被所属模块登记，且 `ownerModuleId` 匹配 | cardpack | 同上 |
| `cardpack.reference.crossModule` | 跨模块引用必须指向已被引入的模块与已登记组件 | cardpack | 同上 |
| `cardpack.dataAccess.declared` | 节点数据访问必须由模块数据契约的能力声明支持 | cardpack | 同上 |
| `cardpack.skill.frontmatter` | Skill 文档头部必须满足约定字段 | cardpack | 同上 |
| `cardpack.trigger.inputsDeclared` | 脚本出现的 `trigger/<id>` 必须在 `metadata.triggerInputs` 声明 | cardpack | 同上 |
| `cardpack.writeCapability.viewCoverage` | 持有写能力的节点必须至少有一个视图覆盖该记录类型全部必填字段 | cardpack | 同上 |

**为什么这些是卡包层**：它们需要真实的文件系统布局与模块互引用，运行时归一化看不到这些关系。
目前它们**没有共享样例**——覆盖它们的是 `test_real_asset_validation.py`（真实资产装配 + 正反例）
与 `test_validate_card_pack.py`（单元级）。方案第 8.5 节正是要求这两者互补：真实装配防止规范与
发布资产脱节，协议样例验证明确的拒绝条件。

### 3.4 转换要求（来源映射、资料完整性、设计不变量）

| 规则 ID | 规则 | 层次 | 权威实现 |
| --- | --- | --- | --- |
| `conversion.sourceMapping` | 每份静态资料必须保留完整来源映射与转换记录 | cardpack | `validate_card_pack.py`（provenance 检查） |
| `conversion.designInvariant` | 卡在 `manifest.design_invariants` 声明的设计不变量：声明即校验、违反即错误 | cardpack | `validate_card_pack.py` |
| `conversion.designWarning` | 未声明的设计断言降级为 `design:` 警告，不阻断 | cardpack | 同上 |

这些规则**不可共享给运行时**：运行时既不读 provenance，也不知道源卡。方案 8.6 要求它们保持
语言本地实现。

### 3.5 启动完整性（launch/lock、依赖版本、路径、文件清单与哈希）

| 规则 ID | 规则 | 层次 | 权威实现 |
| --- | --- | --- | --- |
| `launch.identity` | `manifest.id`、`runtime-lock.cardId`、`launch.cardId` 必须一致，schema 必须为 1 | cardpack | `validate-runtime-package.mjs` |
| `launch.engine` | `launch.engine` 必须是受支持的 Pi 包名、语义化版本，且 Node 主版本不低于 20 并与 lock 一致 | cardpack | 同上 |
| `launch.dependencies` | `lock.externalDependencies` 必须包含与 launch 声明一致的外部引擎 | cardpack | 同上 |
| `launch.inventory` | 必需运行文件必须在 `lock.files` 中登记；每个登记文件的哈希必须匹配 | cardpack | 同上 |
| `launch.pathSafety` | 登记路径不得越出卡目录、不得是符号链接 | cardpack | 同上 |

这一层的契约由 S2 的 `integration:runtime-package-fixture` 断言（合规夹具通过 + 篡改/删除被检出），
不进入 `protocol-samples.json`。

## 4. 已知的层间差异（明确记录，不当作缺陷）

1. **错误文本不同**：例如模块清单版本错误时，运行时输出 `Invalid feature module definition.`，
   校验器输出更具体的字段信息。方案明确不要求文本一致，因此样例只断言**接受/拒绝结论**与
   `ruleIds`，不断言任何实现的错误文案。
2. **运行时归一化更宽松的少数位置**：`Type.Union(ids.map(Type.Literal))` 这类由代码生成的枚举，
   运行时按实际调用处理；这属于实现细节，不影响本表的规则归属。
3. **卡包层规则在运行时层不适用**：JS 侧对 `layer == "cardpack"` 的样例显式标注不适用；当前
   样例集中没有纯 `cardpack` 样例，但机制已就位，避免将来"跳过即通过"。

## 5. 维护方式

修改协议时：

1. 改规范与两侧实现；
2. 在 `protocol-samples.json` 追加**一份**输入样例（含 `ruleIds`、`layer`、`expect`）；
3. 两侧测试自动同时覆盖；
4. 若两侧结论不一致，**不要**通过跳过样例或放宽断言来对齐——先判定哪一侧符合当前权威协议，
   按方案 8 的要求作出并记录决策，然后修正实现。
