# 项目最终核对验收报告

日期：2026-09-13。依据：[已确认实施方案](M:/ai/SillyTavern/bobo-agent-rp/PROJECT-REVIEW-IMPLEMENTATION-PLAN.md)。

后续处理：[修复实施方案](M:/ai/SillyTavern/bobo-agent-rp/PROJECT-REVIEW-REPAIR-IMPLEMENTATION-PLAN.md)已经确认并实施；修复后的结论见[修复最终验收报告](M:/ai/SillyTavern/bobo-agent-rp/PROJECT-REVIEW-REPAIR-ACCEPTANCE-2026-09-14.md)。本报告保留为修复前基线。

## 结论

**本次总验收不通过，不能将全部方案标为完成。** 共确认 14 项缺陷或实施缺口，另有两项验收标准尚缺交付证据。主要阻断点在真实工作流组合、必要输入交付、生图恢复和业务序号查询。此前“所有方案已经实施”的表述应以本报告纠正。

验收范围是根目录开发源、公共运行时/Web 模板、全局模块及相应测试。没有修改已有卡片、安装运行时、`play/` 或 session；没有调用真实模型和 ComfyUI。下面的运行证据来自真实公共函数、实际工作流定义及模拟数据/服务；明确说明了为隔离缺陷而调整的测试条件。

## 实际测试结果

- 公共运行时、Web 与全局模块现有 JavaScript 测试：147/147 通过。
- 使用桌面应用提供的实际 Python 可执行文件执行 `unittest discover`：首次 16 项中 1 项失败。失败源于测试仍把 `workflowCalls` 当作字符串数组。已将断言调整为兼容字符串和对象的实际目标列表，保留原本业务断言；复验 16/16 通过。
- 叙事机械生成副本同步检查、`git diff --check` 通过。
- 此前“13 项 Python 测试通过”的记录缺少有效运行依据，予以撤回；本次记录以实际 Python 运行输出为准。
- 补充验收探针复现了下述失败。现有测试通过不意味着这些未覆盖的业务组合路径正常。

本次修改了上述过时测试断言，并更新验收与状态文档。下面业务缺陷仍待修复，没有把已知失败项改写为通过。

## 逐项结果

| 原问题 | 验收结果 | 主要依据 |
|---|---|---|
| R01 | 目录复制与入口机制通过基础验证；完整链路待复验 | 嵌套目录、实际触发登记测试通过；V01/V08 影响实际使用链路 |
| R02 | 配置与工具校验通过 | 文档工作区 Agent 的 read 配置、运行前检查已有测试；未启动真实 SDK 模型会话 |
| R03 | 按确认保留 | 未要求新增维护目标白名单或严格语义控制 |
| R04 | 不通过 | V05/V06，同操作恢复仍可能重复生成或重新调用 Agent |
| R05 | 部分完成 | 两模块目录已放行；缺发布清单完整性检查，见补充验收缺口 |
| R06 | 不通过 | V02/V08/V09，存在必要历史遗漏和重复参数交付 |
| R07 | 参数校验及读取入口通过基础验证；完整调用链未通过 | V01；归一化测试未覆盖真实同名顶层/模块组合 |
| R08 | 部分完成 | 时间线单集合读取已实现；V10 的实体关联请求仍预读全目录 |
| R09 | 不通过 | V03/V04；另有独立准备节点仍串行 |
| R10 | 不通过 | V07，业务 sequence 与 envelope sequence 混淆 |
| R11 | 部分完成 | 机械函数已共享；V11 的字段/schema/审核校验未统一 |
| R12 | 不通过 | V05，提交响应不确定和 submitted 保存失败未安全恢复 |
| R13 | 不通过 | V09，专用文档之外仍重复传入完整 request |
| R14 | 部分完成 | 同 revision 的确认失败重放通过；V14 的内容版本机制未落实 |
| R15 | 不通过 | V02，有效预算未实际交付 Agent；没有增加新的硬性查询次数限制 |
| R16 | 部分完成 | 根索引和部分指导已整理；V02/V09 导致规则不可达或重复维护 |
| R17 | 不通过 | V02/V12，既有必要输入被漏掉，也仍复制无关文档 |
| R18 | 不通过 | 固定批次包装已共享；V13 会把提交失败报告为 committed |

## 缺陷明细

### V01 · P1：顶层与模块同名时，子调用被误计入顶层实例

位置：[rp-workflow-engine.mjs:111](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflow-engine.mjs:111)。

实例数量按 `workflow.id` 比较，没有区分顶层工作流和模块所属域。实际顶层生图入口与模块内部工作流都叫 `agent-image-generation`。父流程已经运行，启动内部流程时便占用了其 `maxConcurrentInstances: 1` 名额。

使用两个实际工作流定义，通过真实 `RpWorkflowEngine` 和模拟节点执行器启动，结果为 `awaiting-model-choice`，错误为 `Workflow agent-image-generation reached its instance limit.`，提示词 Agent 尚未启动。具有相同命名模式的其他入口也需要一并检查。

处理要求：实例计数、实例身份和恢复身份使用包含所属模块的规范工作流身份；补实际入口到模块的集成回归，不能只用不同 ID 的简化测试。

### V02 · P1：启用上游输出白名单后，记忆工作流未补齐声明

位置：[pi-rp-web.ts:1150](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:1150)，以及记忆模块各 Agent 节点的 `metadata`。

公共执行器只把 `metadata.nodeOutputInputs` 列出的返回值写入文档工作区，并对文档工作区 Agent 关闭上游原始值内联。但现有记忆 Agent 节点均没有声明该字段，相关生产节点又没有导出对应文件：

- `archive-checklist` 缺 `prepare-archive` 的选定剧情和来源资料；`archive-model` 还缺一级归档清单。
- 范围修复的两个 Agent 同样缺 `prepare-range` 结果与一级清单。
- `maintenance-model` 缺准备好的目标记录；`memory-retrieval` 缺 `prepare-retrieval.effectiveBudget`。
- `plan-compression` 只收到时间线，缺准备结果里的当前目标条数等必要控制信息。

因此“预算同时交给 Agent 和组装代码”“归档 Agent 收到指定范围剧情”目前并不成立。仅声明 `context.fromNodes` 已不足以交付这些内容。

处理要求：逐消费者生成包含必要字段和首部指导的文档，或显式声明经过裁剪的上游输出；增加最终 Agent 提示及工作区内容的集成断言，防止再次以清空资料实现降冗余。

### V03 · P1：压缩无需执行时，真实节点完成钩子反而报错

位置：[prepare-compression.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/prepare-compression.mjs)，[rp-data-node-runtime.mjs:49](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-node-runtime.mjs:49)。

压缩关闭或低于阈值时不生成快照，但节点仍声明快照为必需 `workspaceHandoff`。`registerNodeArtifacts` 可以跳过不存在的文件，随后 `finalizeNodeData` 会拒绝缺失的交接输出。

将实际压缩准备结果传入真实完成钩子，复现：`route: skip`，同时抛出 `Required workspace handoff output snapshot is missing.`。现有跳过测试没有接入此钩子，因此没有发现问题。

处理要求：使资格判断与有条件资料交接在协议上相容，保留“不需要时不准备资料”的要求；覆盖关闭、低于阈值和正常执行三个分支的真实完成钩子。

### V04 · P1：模块调用丢失触发来源，自动任务被当作手动任务

位置：[rp-workflow-engine.mjs:359](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflow-engine.mjs:359)，[rp-workflows.mjs:589](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs:589)。

创建子工作流时没有传递触发语义，`createWorkflowRun` 默认为 `manual`。记忆归档与压缩准备代码又以 `run.trigger.type === "manual"` 判断是否放宽自动条件。

真实引擎探针中，父触发设为 `after-workflow`，子流程观察到 `manual`。因此自动归档可能绕过冷却批量条件，允许手动触发的压缩也可能绕过阈值。探针仅重命名父 ID 来隔离 V01，没有改动触发或调度代码。

处理要求：显式传递原始触发语义或专门的业务调用模式；覆盖自动/手动入口经过一层及多层模块调用后的行为。

### V05 · P1：ComfyUI 已接收但本地 submitted 未保存时，会重新入队

位置：[rp-comfyui.mjs:182](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui.mjs:182)，[image-execution.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/image-execution.mjs)。

当前只在 `/prompt` 成功返回并解析后调用 `onSubmitted`。若服务器已经接收而响应丢失，或者 `onSubmitted` 的本地写入失败，持久状态仍是 pending，错误分支将其改为 failed。下次重试清空任务标识并再次调用 generate。

模拟服务器已接收、submitted 写入失败，两次执行同一请求得到 `serverQueueCount: 2`，两次本地结果均为 `failed`、`promptId: null`。这与已完成结果写入失败的现有成功恢复测试是不同故障窗口。

处理要求：在可能产生远端副作用前持久化可恢复的任务身份和阶段；保留不确定状态，并用原任务身份查询历史/队列。只有明确没有接收或确认失败时才允许重新提交。补响应丢失、响应解析失败、submitted 写入失败测试。

### V06 · P2：已完成操作重放仍重新调用提示词 Agent

位置：[生图工作流](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/workflows/agent-image-generation/workflow.json)，[persist-and-render.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/persist-and-render.mjs)。

请求查询/复用只发生在 `generate-content-prompts` 之后，`resolve-input` 没有请求状态检查。顶层实例去重也只处理尚未结束的流程，重复到达时返回的是实例冲突，而不是已有运行结果。

隔离 V01 后，以相同 `operationId` 先后启动两次实际 DAG，模拟执行器记录到 `agentCalls: 2`。该探针验证调度顺序；持久化代码的现有请求检查位置进一步确认没有 Agent 前置短路。

处理要求：在调用提示词 Agent 之前复用已完成/执行中请求和已有提示词阶段；前端重发返回原任务或结果。保留用户明确新操作使用新 ID 的行为。

### V07 · P1：上一篇与下一个业务序号仍按错误字段排序

位置：[rp-data-index.mjs:101](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-index.mjs:101)，[故事数据助手](M:/ai/SillyTavern/bobo-agent-rp/global-modules/local-scene-narrative/runtime/lib/data.mjs:13)。

模块索引把 `/data/sequence` 命名为 `sequence`，但公共排序器遇到该名称会优先读取 envelope 的 `entry.sequence`。因此仅加 `sort: [{field: "sequence", order: "desc"}]` 并未解决原方案特别指出的区别。

用实际模块契约和公共排序器测试：业务 701 对应 envelope 1，业务 700 对应 envelope 2。查询首先返回业务 700，代码算出的下一序号是 701，正确结果应为 702。现有测试只断言发出了 `sequence` 排序请求，没有验证公共排序器的实际结果。

处理要求：对业务索引和 envelope 排序采用明确且不冲突的选择方式，并覆盖导入顺序、长系列及业务序号与 envelope 顺序不一致的情形。

### V08 · P1：前台最近回合未进入冻结上下文，深度导演缺显式剧情来源

位置：[pi-rp-web.ts:1229](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:1229)，[rp-workspace-snapshot.mjs](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-snapshot.mjs)，[深度导演工作流](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/workflows/deep-director-planning/workflow.json)。

前台最近完整回合通过 `recentContext` 内联进提示，自动快照仅复制登记的文档、当前输入和正文；`turnContext` 只保存回合数量配置，没有保存这些回合正文。标准准备节点也没有把最近聊天回合注册成文档。所以前置/后置快照并不完整包含正文 Agent 已取得的必要聊天资料。

深度导演提示仍要求依据“冻结剧情”，但接口只有 `triggerReasons`，没有剧情文档输入；其准备步骤只输出导演记录和作者未来资料。取消后台默认全历史之后，没有补上明确选择的冻结剧情入口。记忆检索只能补检索到的资料，不能保证提供尚未归档的近期完整回合。

处理要求：把需要共享的选定回合冻结为明确文档并接入所需节点，前台也从同一交付来源取得内容，避免增加内联/文件重复。保留固定提示及其他非聊天资料原有配置。

### V09 · P2：生图专用文档之外仍重复展开完整 request

位置：[rp-model-config.mjs 的 composeWorkflowNodeDynamicContext](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-model-config.mjs)，[rp-workspace-handoff.mjs](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-handoff.mjs)。

运行时向全部模块 Agent 内联 `JSON.stringify(run.arguments)`，`CALL-INPUTS.md` 又写一份参数；生图 request 本身包含 `customBrief/workflowOutput/userDirection/profileIds` 等内容。因此专用资料文档不能阻止重复交付。

调用实际输入准备、调用索引生成和动态提示组装函数，带唯一标记的目标与额外要求均出现于三个交付位置，结果为 `targetCopies: 3`、`directionCopies: 3`，提示中还出现 `profileIds`。

处理要求：按 Agent 节点需求明确选择参数，技术执行请求仅留给代码；目标、要求和阅读指导在可读资料首部保留唯一维护位置。

### V10 · P2：实体关联快照仍先预读全部五类目录

位置：[build-reference-snapshot.mjs:156](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/build-reference-snapshot.mjs:156)。

未指定 collections 时，先调用 `prepareCatalog` 读取五类集合，之后 related-records 分支才按索引查询并替换目录来源。recordIds 等筛选同样在全量读取后执行。

实际函数探针请求单个实体关联资料，记录到五次无过滤集合读取，随后又执行十次带索引查询。时间线单集合优化已生效，但 R08 的第二、三条尚未落实。

处理要求：实体关联和精确 ID 请求从开始就使用适当的已有索引/get 路径；保留有效时间线覆盖关系所需的全局计算边界。

### V11 · P2：共用机械函数未覆盖字段结构和审核校验

位置：[故事机械规范源](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime/story-mechanics.mjs)，[审核组装器](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/runtime/workflow/assemble-reviewed-stories.mjs:9)，[同步脚本](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/create-pi-rp-feature-module/scripts/sync_story_mechanics.mjs)。

近场/广域四项机械流程已共享且生成副本一致。但审核组装器仍独立维护 `META_FIELDS` 和整套 metadata 校验，两模块 story.schema.json 仍为独立文件；同步脚本只处理 story-mechanics.mjs，没有生成或验证 schema。

处理要求：补共同故事字段的单一来源、审核侧复用及独立安装 schema 的生成/一致性检查。当前代码一致不能代替防止未来单边漂移的机制。

### V12 · P2：节点裁剪只覆盖模块调用文档，触发与上游目录仍全量复制

位置：[rp-workspace-snapshot.mjs 的 stageTriggeredDocuments](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-snapshot.mjs:131)，[导演叙事总流程](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/integration/workflows/director-post-with-narratives/workflow.json)。

`stageTriggeredDocuments` 对每个 agent/code/call 节点复制全部触发文档，没有按节点选择。`publish-local` 与 `publish-world` 又同时继承 `review-candidates` 导出的完整 reviewed 目录，包含两个频道的结果；后续子模块只取各自 package，并没有消除上一级已发生的冗余复制。

处理要求：补触发输入的显式节点范围，并把审核结果分别导出/选择给两个发布节点。提交节点不得附带整套前台冻结资料。

### V13 · P1：代码提交失败回执被报告为 committed，流程继续成功

位置：[commit-agent-batch.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/runtime/workflow/commit-agent-batch.mjs)，[故事发布机械实现](M:/ai/SillyTavern/bobo-agent-rp/global-modules/local-scene-narrative/runtime/lib/story-mechanics.mjs)。

公共数据服务可能返回 `status: failed` 的事务回执。导演提交代码未检查回执便返回 `committed: true`；故事发布和审核副作用提交也存在同类遗漏。节点没有通过 onNodeEnd 再提交，故完成钩子不会替这些直接 submit 调用检查回执。

向实际导演提交函数提供 revision_conflict 失败回执，结果同时包含 `committed: true` 和 `receipt.status: failed`。权限和版本校验虽然拒绝了写入，但工作流仍可能宣告成功并放行下游。

处理要求：共用确定性提交路径检查 failed/partial 等非成功结果，向工作流传播失败。不得刷新 expectedRevision 来绕过冲突；补实际回执语义的回归。

### V14 · P2：来源内容版本仅出现在模拟数据，真实 schema 不支持

位置：[capture-archive-outbox.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/integration/runtime/capture-archive-outbox.mjs:4)，[archive-handoff.schema.json](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/schemas/archive-handoff.schema.json)，[导演测试](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/runtime/test/module.test.mjs:99)。

捕获 ID 使用 `contentVersion || revision`，测试提供 `contentVersion: 2`；但真实 schema 为 additionalProperties:false 且没有 contentVersion，生产路径也没有内容版本派生。因此真实记录只能落回普通 revision，尚未实现“内容修订”和“单纯状态变化”的明确区分。现有确认失败后相同 revision 的重放路径成立，但不能证明完整版本语义。

处理要求：选择并实现有效的内容版本或内容摘要规则，明确排除技术确认字段，并使用真实数据契约验证内容修改与纯状态修改的捕获身份。

## 其他尚缺的验收交付

- R05：`.gitignore` 已放行近场与广域完整目录，但没有发现用于核对“项目声明模块与实际提交文件”的发布检查。未提交的工作区本身不是错误；缺的是方案要求的自动检查及漏模块用例。
- R09：前置/后置/深度导演的作者静态资料准备仍依赖私有资料准备完成。没有发现二者存在数据依赖的说明，也没有落实独立准备并行及消费者等待双方的对应验证。

## 后续修复与复验顺序

1. 先修 V01、V02、V03、V04、V13，恢复入口、输入、路由与成功/失败传播的可信性。
2. 修 V05、V06、V07、V08，覆盖任务重放、未知提交状态、业务序号和冻结资料完整性。
3. 完成 V09—V12、V14 及两项补充验收交付，再按原 R01—R18 标准复验。

复验须使用真实工作流定义，接入节点完成钩子、调用文档组装及公共数据排序/事务回执。保留模拟模型和 ComfyUI 服务即可验证上述确定性问题，不需要付费生成来证明修复有效。
