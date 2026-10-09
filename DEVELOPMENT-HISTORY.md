# 开发历史记录

本文件保存从 [PROJECT_STATUS.md](PROJECT_STATUS.md) 移出的长篇实施历史：逐批次的缺陷修复、
当时的验证计数与实机取证记录。

**这是历史记录，不是当前规范。** 其中的协议版本号（例如 "Module v6" / "Workflow v3"）、
测试计数与"已完成 / 未完成"结论，都只描述**该条目日期当时**的状态，不代表当前实现。当前
能力、当前限制和当前验证结果一律以 [PROJECT_STATUS.md](PROJECT_STATUS.md) 为准；协议规范以
[`design-pi-rp-data/references/protocol.md`](.agents/skills/design-pi-rp-data/references/protocol.md) 为准。

条目按时间倒序保留原文与原始日期，未做改写。

---

## 2026-10-08 功能模块统一组织与交付

正文、生图、记忆、导演及场景叙事的 Agent、入口/子工作流、节点提示词、运行脚本与专属资源统一留在所属 `global-modules/<id>/`。转卡完整复制到 `features/<id>/`，不再展开成卡根的 Agent、工作流或模块提示词目录。功能模块是最小组织和交付单元，但可以依赖其他模块。固定静态资料库仍作为内置资源模块交付。

采用 Module v7 与 Workflow v4：manifest 显式登记 `agentFiles`、`workflowFiles`，所有工作流声明 `ownerModuleId`；`promptFile`、`entryFile` 为模块相对路径，运行时 ID 为 `module/component`，配置方案使用精确的模块归属键。入口工作流保留前台/后台、触发、阻塞语义；可调用子工作流保留权限、返回、锁与提交边界。公共引擎、工具、系统和模型前后置保留公共维护；跨模块 `prompt-templates` 仅在转卡时按选项展开。

正文模块完整拥有 `narrative-writer`、两套前台工作流、最近故事准备及拨档组合。未选提示词源与草稿仍隔离，正文选中要求与普通静态准则同级交付，导演选中要求按对应 Agent 过滤后装配。修正了记忆/生图前端入口与完整组件引用的路由、配置和运行状态显示。

验证通过：运行时、全局模块和 Web 共 420/420；打包/模板同步回归 6/6；校验器单元 15/15；Skill 合约 4/4；真实资产正反例、发布引用、模板一致性、TypeScript/JavaScript 语法与 diff 检查通过。未同步 `play/`、已有卡或会话；未执行真实模型或 ComfyUI 生成。下方较早记录的协议版本保留其历史含义。

## 2026-10-08 导演拨档要求

世界叙事统筹升级为 hybrid 源包，新增“主角待遇”五档和固定末项“其他要求”两档。默认额外要求由创作者/转卡者填写、可留空，玩家自定义独立保存。全部档位资源独立于正文静态资料；文档内 `director-only` 注释按真实 Agent ID 标注专用块，组合时保留通用与当前专用内容的穿插顺序。

公共运行时将本次选中要求冻结在工作流中，普通导演调用与团队成员均按各自 Agent 身份过滤，作为普通文本追加到既有 Agent 提示词消息。正文和记忆检索 Agent 不接收导演要求，未选档位与草稿不进入工作区。转卡、导入、资源和标记校验规则已更新。源码回归与隔离浏览器验证通过；未同步到已有卡或会话，未执行真实模型推演。

## 2026-10-08 正文创作要求拨档模块

原高级记忆正文任务中的字数、语言、部分扩写已摘出：字数四档、语言两档、扩写三档，按夏瑾系列已有整理原文及字数变量句式提供，初始800-1500/中文/部分扩写。源模板迁入独立拨档区；扩写明确不加自定义，共用控件新增 allowCustom=false 支持。正文任务不再保留冲突的固定条款。

正文拨档末尾新增“其他要求”，只有默认/自定义两档，初始默认；作者或转卡者的默认文档可留空，玩家草稿独立保存。仅所选内容追加到同级静态《创作要求》，转卡和扩展规则同步保留固定末项。

新增可选项目通用模块 `narrative-controls`，在现有前端模块栏默认置顶。叙事节奏、抢话方式的六份原文从普通静态模板移入独立档位资源区，完整资源随转卡保留；末档自定义，默认不追加。标准和高级记忆正文模板先按冻结的聊天设置组合《创作要求》，再与普通静态资料在同一目录、同一层级交付，正文 Agent 无需直接读取档位源。转卡 Skill、模块导入文档、发布清单及公共运行时同步规则已更新。

模块、统一数据、工作流、Web 和转换打包回归通过；隔离浏览器验证了桌面/窄屏拨档、自定义草稿、预览隔离、刷新保留、保存及冲突。未同步到 `play/`、已有卡或会话，未执行真实模型正文生成。

## 2026-09-20 Seraphina 项目回归

以 `play/cards/seraphina` 为测试卡，卡包校验为 `0 warning(s)`；根目录运行时 `291/291`、全局模块 `80/80`、Web `6/6`、校验器单元 `15/15`、Skill 合约 `4/4`，发布清单和故事机制同步检查通过。卡内确定性流程（资料导出、两轮归档、空库与非空库检索）`27/27`。本次未执行真实模型或 ComfyUI 生成。

发现一处项目测试布局问题：`rp-source-delivery.test.mjs` 用固定相对层级定位仓库根目录，复制到 `play/.pi/lib` 后误找 `M:\global-modules`，导致安装运行时测试 `290 pass / 1 fail`。根源测试现沿父目录查找发布清单和 `global-modules`，在源码与模拟安装布局均通过；独立安装且没有源码的环境会明确跳过该源码资产检查。此次只修改根目录源，没有同步 `play/.pi/lib` 中的旧测试副本。

旧实卡记录里的 `PUT /api/image-generation/preferences` 404 在当前隔离新会话未复现：真实 Pi Bridge 的开场为 201、生图状态为 200、偏好保存为 200。Web 模板增加了该 PUT 路由的回归断言。旧会话上的 404 成因仍未确定，不应把这次新会话结果当成旧会话修复或完整面板验收。

## 2026-09-19 Agent 产物交付源树改造

根目录权威运行时源、7 个运行时工作流中的 2 个普通 Agent 节点，以及 `global-modules` 工作流中的 16 个普通 Agent 节点，已改为文件/目录交付和独立节点结束。Agent 可以直接成稿、先写草稿再编辑，或直接交付草稿；JSON 先写入文件，交付失败后可在原文件上修改。工作流仍从正式路径或回读对象消费产物，普通节点默认不开放 bash，团队会议沿用原有协议。已通过运行时库、源模块、真实资产校验及离线 Pi 工具循环；尚未将改造传播到 `play/`、卡片或会话，尚无真实模型实卡验证。实施细节和验收范围见 `local-development-records/docs/AGENT-DELIVERY-IMPLEMENTATION-2026-09-19.md`。

## 2026-09-17 实卡缺陷项目级修复（P-01～P-09）

已完成实卡取证，本轮据 `local-development-records/docs/REAL-CARD-TEST-2026-09-17.md` 的九条复现证据实施项目级修复：**已完成实卡取证、项目修复已落地、关键全链路已在真实 Pi + 真实模型 + 真实 ComfyUI 上跑通并取证**。第三轮实机跨 9 个后台窗口完成开场→3 个回合→回合后链路→自动归档→深度推演→卡内出图与读图，共发现并修复 8 项「只有真实链路才会暴露」的缺陷（详见修复记录 §13）；仍未跑完的项已在文末逐条列出。此前的"全部测试通过"只代表单元与静态回归，不代表实卡可用；本段之后的历史记录保留为历史。

修复内容（逐项对应 RC 编号）：

| 项 | 修复 |
| --- | --- |
| P-01 / RC-01 | 近场叙事 Skill 补齐 YAML frontmatter；Skill 头部契约抽为 `rp-skill-contract.mjs`，运行时与卡包校验器共用同一组正反例，校验检查头部而非仅文件存在。 |
| P-02 / RC-02 | `rp_data_query`/`rp_data_get` 参数根改为真实 object schema（`rp-data-tool-schemas.mjs`），并把所有注册工具的 `parameters` 纳入回归编译检查；无文本时保留 provider 的 `stopReason`/`errorMessage`，工具 schema 被拒判为配置故障（`tool_schema_invalid`，不自动换模型）。 |
| P-03 / RC-03 | 工作流解析统一按 `ownerModuleId + workflowId`（`getModuleWorkflow`/`resolveOwnedWorkflow`）；面板重试与"保存为默认"按所有者写入 profile 或卡内模块覆盖层，不再把模块工作流复制成顶层工作流；恢复、重试、默认保存共用同一解析逻辑。 |
| P-04 / RC-04 | 近期故事导出改为单 operator 索引条件 + 返回记录过滤上界 + 完整分页；两份模块副本经同步脚本生成，回归使用真实 `RpDataStore` 与模块契约。 |
| P-05 / RC-05 | 冻结触发文档统一投递到消费节点工作区内的 `trigger/<documentId>`，call/code/Agent 读到同一受控副本；每次尝试重新校验投递哈希，被改写的副本与被篡改的基线都报错；上游删除后仍可读取。 |
| P-06 / RC-06 | 深度包装按实际启用的后置集成图映射 `story-context`，并新增 `metadata.storyContextSource`（`trigger` 必失败、`history` 仅开场/手动）；校验器逐条检查 `trigger.documents` 的 `fromNode`/`output`/作用域与 `triggerInputs` 映射；运行时投递失败时点名缺失产物。 |
| P-07 / RC-07 | profile 新增 `seedRange`（含来源说明），随快照冻结并纳入 digest；种子仍在 `renderId`+`attemptNumber` 上确定性派生，但映射进冻结范围；范围校验在入队前完成，越界种子直接 `comfy_pre_submit_failure`；历史中的 `node_errors` 按输出分支归属区分失败与警告。 |
| P-08 / RC-08 | 深度身份拆分为稳定 `operationId`（按触发回合派生）、外层 wrapper runId 与子 `currentChildRunId`；重启后重新接入原 invocation；共享 data-read-view 以全部活跃消费者为生命周期依据（`rp-data-read-view-lifecycle.mjs`），从持久状态重建引用图。 |
| P-09 / RC-09 | 深度 plan 只回复 JSON，由确定性 `materialize-report` 节点校验并落盘 `deep-report.json`，再经 handoff 交给 commit；commit 重新校验同一契约函数；报告 schema、`basisTurn` 与题材规则共用 `deep-report.mjs`。 |

同批诊断与失败处理：终结节点不再读取未产出的 narrative（点名源节点状态）；`requiredCalls` 让工作流显式声明必须取得的调用，缺失即失败并保留调用失败原因；`compose-memory` 按记录类型解析 `broad` 查询的合法状态，避免把模型合法输出判死；`rp-resource-catalog.test.mjs` 在源码与安装两种布局下都能解析模块路径。

新增/更新的运行时与模块文件：`rp-skill-contract.mjs`、`rp-data-tool-schemas.mjs`、`rp-model-failures.mjs`、`rp-comfyui-seed.mjs`、`rp-comfyui-diagnostics.mjs`、`rp-data-read-view-lifecycle.mjs`、`deep-operation-identity.mjs`、`deep-report.mjs`、`materialize-deep-report.mjs` 及其回归测试。

本轮验证：运行时库 `248 pass / 1 fail`（唯一失败是 `rp-team-runtime.test.mjs` 自带管道子进程的用例，属已知沙箱限制）、全局模块 `71/71`、Web `6/6`、真实资产自校验全部通过（含新增 6 项触发文档检查与 5 项 Skill 头部检查）、校验器单元 `15/15`、Skill 合约 `4/4`、46 个工作流定义归一化通过、故事机制同步检查通过、扩展 esbuild 转译通过。`check_release_manifest.mjs` 与 `test_validate_card_pack.py` 原生运行仍受沙箱限制（见「已知边界」）。此前快照中的旧计数保留为历史记录。

隔离实机验证（真实 Pi + `deepseek/deepseek-v4-flash-vision-exp` + 真实 ComfyUI 0.34.0）已完成：Bridge 打开、开场导演初始化、turn 1 正文 `completed` 且落盘 627 字符、模块所有节点重试返回 202、卡内 `trigger/turn-context` 真实投递、重启后 3 个共享读视图被保留、以及「越界种子静默不出图 / 范围内种子产出并读取真实 PNG」的对照。实机还暴露并已修复三项旧缺陷：JSON 模式 Agent 回复只接受「以 JSON 开头」（开场导演因此每次尝试都失败）、重试的模块导出路径冲突、两份深度包装模板未声明脚本实际调用的 `begin-deep-operation`——最后一项此前会让回合后深度接入在任何模型调用前失败。**未完成**：回合后近场/广域候选→审核→发布→来源捕获→自动归档的完整链路、真实深度报告落盘与 team 深度中断恢复、卡内图片读取端点。原因是本环境单次前台命令上限 10 分钟（已实测），而单次模型调用常需 8–13 分钟，每 10 分钟必然打断一次调用；`Start-Process` 派生独立进程与 `child_process` 管道在本沙箱均不可用。逐项记录、绕行尝试与剩余限制见 `local-development-records/docs/PROJECT-REAL-CARD-REPAIR-RECORD-2026-09-17.md`。

**实卡可用性**：本条写于第三轮实机之前，其结论已被第三轮取代——回合后近场/广域链路、自动记忆归档、下一轮读取、真实深度推演与中断恢复、卡内出图与图片读取端点均已在真实环境上跑通并留有持久证据（见下方「第三轮补充」与修复记录 §14）。仍**未**跑完的是 team 模式真实深度运行、旧引擎遗留僵尸记录的清理，以及面板偏好保存端点（404）；在这些项完成前不应把该卡视为「全部路径均已验收」。

### 第二轮补充

整备隔离环境刷新卡内集成模板时，校验器当场拦下一次「看似刷新成功、实际深度接入已断」的安装：`director-post-with-narratives` 的 `post-director` 不再声明 `story-context`，深度包装的触发器仍指向它。校验器报 `trigger.documents.story-context.output must reference an output declared by director-post-with-narratives/post-director`——这正是 P-06 新增检查的目标。补声明属**转卡动作**（只有启用近场/广域编排的卡需要），已在 `IMPORT.md` 写明并加入施工工具，补完后同一张卡重新校验为 `0 warning(s)`。静态回归在本轮结束时保持全绿（运行时库 `255/1`、模块 `71/71`、Web `6/6`、真实资产自校验全部通过、校验器单元 `15/15`、Skill 合约 `4/4`、同步与 `git diff --check` 通过）。

### 第三轮补充（第二次实机运行）

整备后重跑开场链路，真实模型在**深度推演**上又暴露两项缺陷，均已修并回归：

- **深度报告契约强制模型自带 `schemaVersion`**：`plan` 节点的真实回复正好是文档约定的九个字段（正文 3468 字、1 个 active + 2 个 backup 题材），但没有 `schemaVersion`；旧契约要求它必须为 1，于是 `materialize-report` 判死、`commit` 变 `skipped`、子运行失败。`schemaVersion` 与 `basisTurn` 本就是运行时自己的标记，现改为「缺省即补写、显式矛盾才拒绝」。用**这次实机失败的真实回复**直接验证修复后的契约（accepted，`contentChars=3468`）并把归一化报告落盘取证。
- **失败处理读的是「视图投影」，让「记录失败」这一步自己失败**：失败补丁是 `{...value}` 展开的，而 `value` 来自 `deep-status` **视图**——该视图恰好不含 `lastTriggerWorldTime`/`lastCompletedWorldTime`（schema 必填）。`update` 携带整条记录数据，缺字段即被 schema 拒绝，`deep-state-current` 永远停在 `running`、操作清单不关闭——此后每一轮 wrapper 都判 `already-running`，深度推演再也不会启动，**失败记录变成永久卡死**。修正分两处：失败补丁改用完整视图 `deep-director` 读取（并保留「非持有者不得覆盖」判断），两份深度包装模板的 `deep-workbench` 访问补上 `deep-director` 视图——模块内所有写入节点本来都用完整视图，只有集成包装在用只读投影写记录。回归三层：测试夹具按模块自己的 `data-contract.json` **渲染视图**并按真实 schema 校验提交（夹具返回整条记录就会与缺陷一起「通过」），断言失败补丁必须保留世界时间的**真实值**；校验器新增通用规则「持有写能力的节点必须至少有一个视图覆盖该记录类型的全部必填字段」，`test_real_asset_validation.py` 补两份模板的正反例。两处都做了突变验证：改回窄视图时测试 7 pass/1 fail、校验器报 3 条 error，恢复即全绿。

同时订正一条此前记录的错误结论：**10 分钟上限只作用于前台命令，后台作业没有该上限**（本轮实测后台驱动连续运行 23 分钟并被主动终止，另有 14 分钟作业正常跑完）。「每 10 分钟必然打断一次调用」不是环境必然，完整链路应作为**后台作业**启动，Runbook 已按此改写。

第三轮实机还暴露第三项缺陷（回合后近场/广域链路）：`director-post-with-narratives` 的 `dispatch-local` 在真实回合后失败，`create-story-candidate` 报 `ENOENT … dispatch-local/trigger/turn-context`，近场/广域候选与发布全部未发生。根因是 P-05 修复的漏网——触发文档现在只投递给**声明过** `metadata.triggerInputs` 的节点，而 `dispatch-story-candidate.mjs`/`run-story-review.mjs` 硬编码读取 `trigger/turn-context`，其所在节点却从未声明它（只有 `post-director` 声明了）。已给两个 dispatch 节点与 `review-candidates` 补声明，并新增通用校验规则「脚本里出现的 `trigger/<id>` 必须在 `metadata.triggerInputs` 中声明」（上线即精确命中这三个节点，修完全库为 0），`test_real_asset_validation.py` 补正反例，另加只读排查工具 `scan-trigger-inputs.mjs`。注意引擎在会话打开时缓存卡内工作流定义，**改定义后必须重启 Pi 才生效**，因此该修复在新一轮上验证。

第四项缺陷（自动记忆归档）：`narrative-memory-archive` 的 `commit-archive` 报 `narrative-memory time adapter is not configured for this card.`，归档停在 `lastArchivedTurn=0 / never`。根因是**转卡半配置**：本卡的 `config/time-system.json` 已完整写明时间规则（`day-N-since-rescue-v1`、`day-a/b` 定宽排序、含示例），但实现它的 `runtime/time-adapter.mjs` 仍是模块自带的抛错占位；静态检查与开场/正文链路都不报错，直到第一个 `memory.event` 需要派生 `sortValue` 时才在确定性 code 节点失败，模型看不到也无法修。已在验收卡内按卡自己的规格补实现，并新增校验规则「声明已配置时适配器不得仍是占位、两者 `timeRuleVersion` 必须一致」（对模块源模板的自洽未配置状态保持通过），`test_real_asset_validation.py` 补四个正反例，模块 `skill/references/time-openings-and-sources.md` 补上「声明与实现必须一起完成」及后果说明。

第五项缺陷（单模式深度清单泄漏）：turn 2 的深度链路全程成功后，`deep-report-current` 前进到 rev 2、`deep-state-current` 释放为 `idle`，但 `deep-operation-turn-2` 仍是 `running`——团队模式的提交会在同一原子批次里关闭清单，单模式的 `commit-deep-report` 只释放状态，而单模式包装从不调用 `finish-deep-operation`，该节点又拒绝关闭「状态已不再指向」的清单，于是**每次成功都会留下永久 `running` 的清单**（不阻塞后续回合，但工作台长期显示进行中，且无正常路径可关闭）。已让单模式提交在**同一批次**内追加清单关闭操作（仅当清单仍属本操作且为 `running`，重试不重写终态清单），回归断言第三个操作、终态与必填字段；`release-stuck-deep-operation.mjs` 同步扩展出「状态已不指向、清单仍 running」的收尾分支（按该回合是否已完成推导终态），本轮用它关闭了 `deep-operation-turn-2`。

第六项缺陷（重启恢复实例键）：一次被中断的子运行（世界频道候选）重启后 `retry` 返回 404、记录永远停在 `running`——宿主恢复时报 `Restored workflow instance key does not match its persisted input`。`multiple` 且无 `dedupeKey` 的工作流其实例键后缀是**随机 UUID**，而 `restore()` 用运行 id 重算，键永远对不上。已改为按持久化键复用后缀（`dedupeKey`/`single` 模式行为不变），回归在 `rp-workflow-engine.test.mjs`（改回旧算法实测转红）。

第七、八项缺陷（卡内图片链路，均为 P-07 的漏网）：① 运行时把 `seedRange`/`seedRangeVerified` 写进请求快照，但模块自己的 `image-request.schema.json` 是 `additionalProperties: false` 且没有这两个属性——**每次卡内图片请求都在到达 ComfyUI 前被自己的 schema 拒绝**；已补两个属性（不进 `required`，老记录仍可读）。② 成功出图后完成写入被子状态机拒绝：完成补丁带 `warnings`（RC-07 诊断产物），而 `render-state.mjs` 的转换白名单没有它，于是**每次成功 render 都停在 `submitted`、图片挂不到记录上**；已把 `warnings` 加入白名单与 render schema，报错改为列出具体越界字段，并新增「执行路径构造的完成补丁必须合法且字段都在 schema 中」的回归（改回旧白名单实测转红）。

第九、十项缺陷（首次真实 team 深度推演暴露）：① 团队协作任务（`baseRetrieval`/`assistants`）的 `timeoutMs` 默认 **120 秒**，而一次真实记忆检索要数分钟——团队定义没声明该值时，**每次真实团队会议都会在必需基础检索上超时**（实机 `Required base retrieval failed: Assistance task timed out after 120000ms.`）；默认改为 600000 毫秒并在模板上显式声明 900000/600000，回归断言默认值可覆盖真实调用、显式值生效、非法值回退。② 检索匹配状态跨族即判死：模型把 `confirmed`（信息族状态）标在 `memory.entity` 匹配上，`compose-memory` 按查询 kind 取词表 → `Invalid match status confirmed for record type memory.entity.` → 整次检索与依赖它的团队会议一起失败，而模型看不到错误（与 RC-13 同类）；改为匹配声明了 `recordType` 时接受两族词表并集、词表外状态仍报错，回归双向覆盖。

**第三轮实机验收结论**：开场、四个回合的正文、记忆检索、近场/广域故事候选→审核→发布（广域还跑出了同系列第 2 篇）、来源捕获、**自动记忆归档**（两次推进到 `lastArchivedTurn=2/3`，事件带卡内适配器派生的 `sortValue`）、**下一轮读取已发布故事**、真实深度推演（single）与中断恢复（含**团队会议的恢复尝试**）、共享读视图跨重启、以及**卡内图片生成与图片读取端点**（`GET /api/image-generation/renders/<id>/images/0` → 200 / `image/png` / 1.3 MB / PNG 魔数，内容与请求一致）均已取证通过。
**team 链路的启动、身份与会议执行已取证**（`deep-operation-turn-5`、包装完成、`meeting` 节点产出真实发言与 17.6 KB 协调记录），并从中修掉两项真实缺陷（协作任务超时、匹配状态跨族判死）；但**完整跑完被模型账户余额阻塞**：会话记录中 9 次 `402 Insufficient Balance`，直接查询服务商 `/user/balance` 亦为 `is_available: false`、`total_balance: -0.39 CNY`（环境内 key 与 `~/.pi/agent/auth.json` 一致）。按用户决定，本轮不再继续该项；余额可用后重跑一个窗口即可（`plan-team-recover` 的恢复入口与 `set-deep-mode.mjs`/`set-deep-recommendation.mjs` 两个夹具工具已就绪）。此外仍未清理旧引擎遗留的一条僵尸运行记录，且面板偏好保存端点仍返回 404（前端用 PUT，本轮改以 `profileIds` 直接发起）。

工具与闸门更新：新增 `run-node-tests.ps1`（逐文件直接运行，绕开 `node --test` 的管道子进程 `EPERM`）与 `release-stuck-deep-operation.mjs`（在真实数据存储上执行模块**自己的** `finish-deep-operation` 节点实现来解除卡死操作，不手写补丁）；补上 `refresh-acceptance-assets.ps1` 漏同步的 `integration/`（旧脚本会留下旧包装代码，足以把已修缺陷误判为未修）；`deep-director-verify.mjs` 改为按集合自身存储类型读取（`deep-workbench` 是 snapshot 集合，此前只读 record log，永远报「无报告无状态」）。

当前静态回归：Node **43 文件 / 329 pass / 0 fail**（`rp-team-runtime` 需要子进程的那条按环境 `skip` 并注明原因）、隔离卡校验 `0 warning(s)`、故事机制同步无差异、校验器单元与 Skill 合约保持通过。第三轮实机重跑（开场 → 回合 1 → 回合后链路 → 回合 2 读取）正在进行，结果与本轮剩余限制见 `PROJECT-REAL-CARD-REPAIR-RECORD-2026-09-17.md`。


本地审查报告、实施记录、诊断工具、测试日志、结果快照和临时夹具已统一归档到被 Git 忽略的 `local-development-records/`，分别位于 `docs/`、`tools/`、`logs/`、`results/` 与 `temp/`。正式发布文档继续保留在仓库根目录。

## 2026-09-17 复核修复

根据 `local-development-records/docs/REVIEW-PACK-2026-09-16.md` 的独立复核，已修复六项边界缺陷：事务以最后写入的回执作为提交标记，未确认回滚的日志阻止同批次重放；默认前台工作流只从卡内候选解析；终态前台回合保证释放且禁止脱离原回合重试；Agent/模型配置解析失败进入节点确定性失败；每个正文 Agent 都单独校验必需调用；Web 面板不再为终态前台运行提供重试入口。对应协议、运行时说明和回归测试已同步更新。

本轮验证：运行时库 `211/211`、Web `6/6`、全局模块与组合 `50/50`、ComfyUI 工作流工具 `2/2`、校验器单元测试 `15/15`、Skill 合约 `4/4`、真实资产自校验全部通过；扩展 esbuild 转译、故事机制同步检查、发布清单和差异检查均通过。此前快照中的旧计数保留为历史记录。

更新时间：2026-09-16（第七轮：FIX-017 + 交接文档订正，缺陷清单 17 条全部实施）

当前分支：`main`

当前 `HEAD`：`368be97`（`feat: tell the panel where a node failure came from`）。工作树干净。

## 交接结论

### 本轮（全面审查 + 批次 1—4 + FIX-016/017）

对项目做过一次全面审查（恶性问题 + 游玩期提示词两条线），共立案 17 条缺陷与 21 条提示词条目，产物是被忽略的 `local-development-records/` 下两份清单：

- `PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`：缺陷清单，**17 条全部已实施**
- `PROJECT-REVIEW-PROMPT-CHECKLIST-2026-09-16.md`：提示词清单，21 条**全部已定稿并已实施**（A 组 7 条 + B 组 P-104 + C 组 1 条在 `8382e74` / `485082a` 落地；其余为 D/E 组的"保留/明确不做"与文末「待取证」清单，不是待办）

**已实施的 17 条**：

| 批次 | 条目 | 提交 |
| --- | --- | --- |
| 1 | FIX-001 / 002 / 005 / 006a / 012 / 013 / 014 | `d6b03b8` `a28da96` `ae33c4c` `7a655ed` `ec71465` `8382e74` `485082a` |
| 2 | FIX-011（调度器韧性） | `ef6c058` |
| 2 | FIX-003（终态失败释放回合）+ FIX-004（失败分类） | `316c2dc` `ceb9a57` |
| 3 | FIX-006b（编排依赖进闸门）+ FIX-007（设计约定降级 + 卡自声明不变量） | `c0ba68e` |
| 4 | FIX-008（失败批次重放）+ FIX-009（派生索引损坏）+ FIX-010（hybrid 删除复活） | `af16abe` |
| — | FIX-015（批次 1 引入的校验器回归） | `a1a7cbc` |
| — | FIX-016（提交被卡声明拒绝时的归类，FIX-004 判据的收尾） | `57a4ab8` |
| — | FIX-017（②③ 提交失败的面板措辞，原「选项 B」） | `368be97` |

其中四条是本轮之前完全未知的：

- **FIX-002**：两个前台工作流的代码节点入口写成运行时相对路径，而执行器只按卡片目录解析——**每张按文档转换的卡都会在第一回合失败**。
- **FIX-014**：`director-health-report` 对 `archive-outbox` 误用写能力，导致**任何安装世界叙事统筹模块的卡都无法通过校验**。由本轮新建的「真实模板自校验」回归**首次运行**抓出。
- **FIX-006a**：校验器只检查顶层工作流的调用目标，**模块工作流节点的错目标与悬空调用在校验期完全不可见**。
- **FIX-003**：前台工作流一旦真正进入终态 `failed`，回合占用永不释放且面板无取消入口——**一次确定性失败即卡死整个会话**。

**FIX-015 是批次 1 自己引入的回归**：卡内新增的入口/调用校验没有区分"卡"与"项目全局包源码树"，使 `validate-module.py` 报出 12 条假错误。批次 2 的验证扫描抓到，已修并补了源码树夹具回归。

**批次 3 的性质与其它批次不同**：不是修 bug，而是把校验器职责重新划分——协议/格式一致性与跨引用完整性保留为硬校验；对**卡的设计**的断言降级为 `design:` 警告，需要强制时由卡在 `manifest.design_invariants` 里自己声明（声明即校验、违反即错误）。编排性依赖（导演驱动叙事模块）从任何硬编码检查中移出，改为模块目录下的 `dependencies.json` 侧车记录 + 转卡闸门的两条路披露。

**批次 4 收尾数据层三条**：失败回执不再被当作幂等重放（重试终于能脱困）、派生索引损坏自愈并告警、hybrid 集合的删除不再被消息裁剪复活。三条都配了"在旧代码上反向失败"的探针。

**FIX-016 / FIX-017 是 FIX-004 判据的收尾**：模型答完之后、节点末数据提交被拒绝时，原先一律提示"换模型重试"。现在按**谁能修好**分三类——卡/模块的声明错（权限、未声明的动作、未允许 best-effort、缺处理器、处理器返回形状错）判为确定性；被**状态**（版本冲突、重复/缺失记录）或**模型自身产出**（schema 不合规、提交阶段故障）拒绝的保持模型路径（agent 节点重试会重新生成批次，自动重试有实际价值）。第二类虽然保留自动重试，但面板不再给模型选择器：节点新增 `failureCause`（`node_end_commit`）与 `failureCode`，前端**按来源、不按码**分支，显示普通"重试"与真实原因。来源用结构性标记而非码表，因为那些码来自数据层、文件系统与卡脚本三处，没有一份表能保持完整。

**尚未实施**：**无待办功能项**。两份清单剩余的是「后续待定稿」里未经逐行复核的候选（升级前必须先复核）与提示词清单的「待取证」位置清单（需要时才去读）。

**FIX-017 之后的新增未验证项**：`app.js` 的新分支没有自动化 UI 测试（本仓库 Web 测试只覆盖 markdown/backend/handoff/module-json），只经 `node --check` 与逐行核对；端到端需真实会话。

### 前序轮次

正文 Agent、模块工作流调用、卡片静态资料库、叙事记忆、ComfyUI 剧情生图及其公共基础设施已有代码实现。再次验收发现的 F01—F08、团队深度导演验收发现的 F01—F14、随后修复复核发现的 R1—R9，以及第二轮复核发现的 S1—S9，均已完成修复并通过自动验证。

真实模型、真实 ComfyUI 与重新转卡的端到端验证**仍未执行**。不要未经用户授权修改 `play/` 或执行真实付费模型/生图测试。

开始后续工作前依次阅读：

1. [README.md](README.md)：项目入口、使用方式与文档导航。
2. [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)：根源、安装运行时、卡片与 session 的独立修改边界。
3. [PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md](PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md)：公共能力的确认与实施台账。
4. 对应全局模块的 `IMPORT.md` 和模块 Skill。
5. 本轮两份清单（被忽略目录）：先读缺陷清单的「实施顺序约束」与「后续待定稿」，再读提示词清单的「判定纪律」。

---

## 历史验证快照

以下是从 `PROJECT_STATUS.md` 移出的逐批次验证记录，保留原日期与当时的计数。

## 验证快照（历史批次）

2026-09-16 完成 **FIX-017**（失败来源标记与面板措辞）：

- 引擎测试由 `47/47` 增至 `49/49`。两条新用例**在改动前都失败**：提交阶段失败标记 `failureCause: node_end_commit` + `failureCode`，而执行器自身的 provider 错误两者均为 `null`；重试后四个失败字段（`error`/`failureKind`/`failureCause`/`failureCode`）全部清空。
- 运行时库测试 `202/203`（唯一失败仍是自带管道子进程的用例）；模块与组合 `50/50`；Web `6/6`；校验器单元 `14/14`；真实资产自校验 39/39；`validate-module.py`、`sync --check`、`node --check app.js`、`git diff --check` 均通过。
- **未验证**：`app.js` 的新分支没有自动化 UI 测试（见「交接结论」末段）。

2026-09-16 完成 **FIX-016**（数据提交失败的归类收尾）：

- 引擎测试由 `45/45` 增至 `47/47`。新增两条：五个①码逐个断言 `failed + deterministic + attempts === 1`（**该用例在旧代码上失败**），五个②③码逐个断言 `awaiting-model-choice + model + attempts === 2`（自动重试确实保留；该用例修复前后都通过，锁的是"不要把线画过头"）。
- 运行时库测试 `200/201`（唯一失败仍是自带管道子进程的用例，属沙箱限制）；模块与组合 `50/50`；`git diff --check` 通过。
- 参考文档 `workflow-system.md` 补上"模型答完之后"的分类规则，与代码注释、锁定用例三处一致。

2026-09-16 完成**批次 4** 修复（FIX-008 / 009 / 010）：

- 运行时库测试 `198/199`（本次 +5 条数据层回归；唯一失败仍是自带管道子进程的用例，属沙箱限制）。
- **五个新回归都先在旧代码上反向失败**（旧代码 `pass 13 / fail 4`，修复后 `pass 17 / fail 0`，另有一条"partial 回执照旧重放"的正向断言始终通过），符合本项目"历史缺陷探针在旧行为断言处必须失败"的验收纪律。
- 回归覆盖定稿四条：同内容重试重新执行、`committed`/`partial` 仍幂等重放且冲突仍被拒、`commit` 阶段失败后重放以冲突暴露（用"先落盘再抛错"的包装 `commit` 构造）、派生索引损坏自愈并告警且权威文件仍报错、hybrid 初始记录删除后不再被裁剪复活。
- 一份**探针写错**的教训已记入清单：FIX-010 的第一版用例在旧代码上也能通过（`delete` 会同时清理 history），真正复活的只有**卡内初始快照记录**；修正后的用例才在旧代码上失败。
- 协议文档同步：`design-pi-rp-data/references/protocol.md` 的提交策略段落写明"哪些回执可重放、唯一边界的后果、派生数据与权威数据的容错差别"；两份 `validation.md` 的运行时用例表同步补齐。

2026-09-16 完成**批次 3** 修复（FIX-006b / FIX-007）：

- 真实资产自校验扩到 **39 项断言**：新增 16 项设计约定/不变量用例（未声明只警告、声明后成错误、随发布资产零额外警告、四类声明自洽负例）与 2 项依赖侧车一致性用例。
- 校验器单元测试 `14/14` 通过（本轮新增 1 个不变量形状用例，并把导演模块断言改为 warning）。**该套件在本沙箱默认跑不动**——沙箱拒绝在被接管的临时目录内部建目录——因此新增了 `local-development-records/tools/run-validator-unit-tests.py`，把 `TemporaryDirectory` 换成工作区实现后执行原用例，见「已知边界」第 5 条。
- 运行时库测试 `193/194`（唯一失败为自带管道子进程的用例，属沙箱限制）；模块与组合测试 `50/50`（含导演定向 `18/18`）；Web 测试 `6/6`；`node --check public/app.js`、`sync_story_mechanics.mjs --check`、`git diff --check` 通过。
- 校验器的三分读法（error / `design:` warning / 声明的不变量）在回归里各有正负例；`validate-module.py` 现在也会打印模块自身的警告。
- **未执行**：`check_release_manifest.mjs`（沙箱禁止其内部 `git check-ignore`），以及真实卡转换中的端到端验证——即"改名后的前台工作流不再被模板断言误伤"只经实现与用例覆盖，未在真实转换里跑过。

逐项实施记录见被忽略的 `local-development-records/docs/PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`。

2026-09-16 完成**批次 2** 修复（FIX-003 / 004 / 011）并随后修掉批次 1 引入的 FIX-015：

- 运行时库测试 `193/194`（唯一失败为 `rp-team-runtime.test.mjs` 中自带管道子进程的用例，属本沙箱限制，见「已知边界」第 5 条）；其中工作流引擎 `45/45`、工作流状态机 `31/31`。
- 根目录模块与组合测试 `50/50`；Web 测试 `6/6`；`node --check public/app.js` 通过；`git diff --check` 通过。
- 「真实模板自校验」扩到 **20 项断言**，新增独立源码树夹具 `local-development-records/temp/module-source-validation/`：6 个随项目发布的包在**没有卡清单**的布局下全部通过，并覆盖两类假错误的负例与“卡内缺模块脚本仍须报错”的正例。`validate-module.py` 恢复通过。
- 新增回归：终态失败释放回合（前端 `failureKind` 分支）、确定性失败分类（代码节点 / Agent 装配前 / 带码配置错误 / 真实 provider 错误）、派发标记逐次尝试重置、调度器 `onChange` 异常不再终止进程。
- 本批次**没有**任何端到端验证：真实 Pi 会话、真实模型与浏览器目视均未执行（见「已知边界」第 1 条）。

逐项实施记录见被忽略的 `local-development-records/docs/PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`。

2026-09-16 完成全面审查后的**批次 1** 修复（FIX-001 / 002 / 005 / 006a / 012 / 013 / 014）：

- 新建「真实模板自校验」回归 `scripts/test_real_asset_validation.py`：用真实资产拼装一张完整夹具卡（6 个模块 + 7 个运行时顶层工作流 + 3 个集成模板），在进程内调用校验器 CLI，覆盖各条目的正负例。**首次运行 15 项断言全部通过。**该脚本**随项目发布**，夹具建在被忽略目录 `local-development-records/temp/card-validation/`（不使用 `tempfile`，见「已知边界」第 5 条）。
- 该回归**首次运行即抓出 FIX-014**——此前无人发现，因为校验器从未与随项目发布的资产一起跑过。
- 模块测试 `6/6`；运行时库测试 `25/26`（唯一失败为上面那条沙箱限制）。
- 三个改动文件（`.ts` / `.mjs` / `.py`）语法检查通过；`.pi/workflow` 旧路径零残留引用。
- 本轮同时发现并修复了两处**只有把校验器与真实资产一起跑才会暴露**的缺陷：FIX-005（绑定字段白名单与前端区域类型落后于协议）与 FIX-014（`director-health-report` 误用写能力）。
- **该批次自身的回归在批次 2 才被发现**：FIX-002 / FIX-006a 的校验只在"卡"语境下成立，源码树自校验因此报了 12 条假错误（FIX-015）。

逐项实施记录见被忽略的 `local-development-records/docs/PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`。

2026-09-16 完成团队深度导演第二轮复核 S1—S9 的逐项修复与用户确认：

- 公共运行时库测试：`188/188` 通过；根目录模块与组合测试：`50/50` 通过，其中世界叙事统筹模块定向测试为 `18/18`。
- Web 测试：`6/6` 通过；Python 结构与 Skill 测试：`20/20` 通过；受影响 MJS 语法检查及 `git diff --check` 通过。
- 默认记忆检索契约、因果写后读取、operation 身份、结构化产物拒收、成功发布边界、失败用量、并发交付、最终产物证据和父子换模等待均有正式正向回归。
- `awaiting-child` 持久记录准确子运行并保留父运行锁和 operation；目标子节点换模完成后，进程内及重启恢复均会自动接回原父链，且不创建重复子运行。
- 历史 S1—S9 缺陷探针在对应旧行为断言处反向失败，证明九项旧缺陷不再复现。

逐项实施记录见被忽略的 `local-development-records/docs/TEAM-DEEP-DIRECTOR-SECOND-REPAIR-PROGRESS-2026-09-16.md`。

2026-09-15 完成团队深度导演修复复核 R1—R9 的修复与重新验收：

- 公共运行时库测试：`173/173` 通过；根目录模块与组合测试：`46/46` 通过，其中世界叙事统筹模块定向测试为 `14/14`。
- Web 测试：`6/6` 通过；转卡校验器 Python 测试：`13/13` 通过；Web `public/app.js` 语法检查及 `pi-rp-web.ts` Pi 离线扩展加载通过。
- 已覆盖当前权威状态读取、未提交包的来源修订复核、恢复等待保留 operation、交付快照权限、产物哈希、失败用量、重试池、秘书旁路异常和有效模型配置冻结。
- 补充验证了团队 SDK 会话尝试回退、恢复时输入基线不被重写，以及提交瞬间对来源 revision 的再次校验。
- 历史缺陷探针的 9 项“缺陷存在”断言现全部失败，逐项证明旧行为不再出现；正式正确性回归全部通过。`git diff --check` 通过。

修复重新验收记录见 `local-development-records/docs/TEAM-DEEP-DIRECTOR-REPAIR-RECHECK-ACCEPTANCE-2026-09-15.md`。

2026-09-15 完成团队深度导演 F01—F14 修复后的当前工作树复核：

- 公共运行时库测试：`166/166` 通过；根目录模块与组合测试：`44/44` 通过。
- 世界叙事统筹模块定向测试：`12/12` 通过；Web 测试：`6/6` 通过；转卡校验器 Python 测试：`13/13` 通过。
- 已覆盖四种团队人数形态、成员配置预检与冻结、精确资料边界、半轮恢复、不可变协调批次、助理重试与取消、低并发调度、事件日志恢复、跨回合冻结查询、短锁原子提交、逐成员模型重试和增量用量统计。
- `git diff --check` 通过。

未启动真实付费模型，也未修改 `play/`、现有卡或 session。真实模型会议的内容质量、provider 差异及重新转卡后的完整交互仍属于后续端到端验收。

2026-09-14 完成 F01—F08 修复后的当前工作树复核：
