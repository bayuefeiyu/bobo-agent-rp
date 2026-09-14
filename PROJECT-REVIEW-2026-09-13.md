# 项目审查报告

审查日期：2026-09-13。对象：当前工作树，包括未提交及未跟踪的根目录开发内容。

本报告供开发决策使用。先读问题总表，再按编号查看证据、影响及处理方向。P1 表示优先修复的功能、范围控制或发布缺陷；P2 表示已确认的可靠性、冗余和维护问题；P3 表示较低优先级的机械工作简化。建议不等于已获准实施，本轮没有修改实现，也没有向基础设施升级台账登记条目。

审查覆盖公共数据与工作流运行时、Web 执行桥接、五个全局模块、主要工作流模板和开发/交接文档。未读取或修改 `play/` 中的卡片、设置和会话。由于未执行真实模型、真实 ComfyUI 或重新转卡的端到端链路，关于实际模型表现、耗时与 token 节省不作量化结论。

## 问题总表

共确认 **18 项：P1 5 项、P2 12 项、P3 1 项**。其中“重复实现”指公共机械过程重复，不建议合并近场、广域、导演和记忆的业务职责。

| 编号 | 优先级 | 问题 | 主要对应审查重点 |
|---|---|---|---|
| R01 | P1 | 文档工作区快照只冻结目录索引，遗漏索引引用的内容 | 数据传递正确性 |
| R02 | P1 | 记忆检索 Agent 必须读文档，却没有 `read` 工具 | 一般正确性、流程 |
| R03 | P1 | 维护提交不校验用户指定的目标记录范围 | 范围控制、可代码化校验 |
| R04 | P1 | 生图两层去重含义不一致，修改要求仍可能被判重复 | 重复实现、正确性 |
| R05 | P1 | 近场、广域模块源被 Git 忽略，正常发布会遗漏 | 发布完整性 |
| R06 | P2 | 旧入口透传完整历史，绕过模块已经完成的输入筛选 | 数据传递冗余 |
| R07 | P2 | 调用参数存在多种形状，接口声明没有成为有效约束 | 数据结构、重复方案 |
| R08 | P2 | 参考快照先全库读取，再按请求筛选 | 数据处理冗余 |
| R09 | P2 | 归档、压缩还没判断是否需要运行，就生成完整参考快照 | 流程冗余 |
| R10 | P2 | 分页与目录映射重复，部分调用遗漏分页处理 | 重复实现、完整性 |
| R11 | P2 | 近场、广域机械流程和 schema 几乎逐份复制 | 重复实现、结构冗余 |
| R12 | P2 | 生图执行与状态记录在模块和 Web 中各实现一套 | 重复实现、恢复一致性 |
| R13 | P2 | 生图 Agent 输入重复携带剧情和技术字段 | 数据传递冗余 |
| R14 | P2 | 导演来源捕获没有稳定幂等 ID，确认失败后会重复捕获 | 数据冗余、可代码化去重 |
| R15 | P2 | 记忆设置与运行时默认值存在分离的控制来源 | 数据结构冗余、配置正确性 |
| R16 | P2 | 交接指导散落且已有版本冲突，部分说明位于内容之后 | 文档首部说明与重复指导 |
| R17 | P2 | 文档传递缺少消费节点投影，机器副本和整套目录被重复搬运 | 数据传递、结构冗余 |
| R18 | P3 | Agent 仍负责协议外壳和可确定的操作排序 | 可用代码完成的工作 |

## 优先修复的问题

### R01：文档目录快照遗漏正文

**证据：** [pi-rp-web.ts:1163](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:1163) 将 `document-set` 的 `workspaceDocuments.path` 设为 `<目录>/DOCUMENTS.md`，同时保留 `kind: directory`。前置调用和正文结束时，又将这组对象直接交给快照器（同文件第 1319、1463 行）。[rp-workspace-snapshot.mjs:56](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-snapshot.mjs:56) 按 `path` 实际指向的文件复制，并根据文件系统类型将其登记成 `file`。

**复现：** 在临时目录建立 `DOCUMENTS.md → lore.md`，用执行桥接实际生成的描述 `{path: "…/DOCUMENTS.md", kind: "directory"}` 调用快照器。结果只冻结一个索引文件，`lore.md` 未复制，原相对引用也失去对应目录。

**影响：** 前置/后置导演及使用正文快照的故事节点可能看到资料目录，却读不到静态设定、事件时间线和近期故事正文。动态调用结果按目录路径登记，表现又与静态上游文档不同，进一步形成两种传递语义。

**处理方向：** 分开保存“传递根目录”和“阅读入口”，快照复制前者，索引展示后者；增加从实际桥接描述到下游读取相对路径的集成测试。

### R02：记忆检索 Agent 无法读取必需文档

**证据：** [检索 Agent 配置:6](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/agents/narrative-memory-retriever/agent.json:6) 要求读取 `WORKSPACE-DOCUMENTS.md`、完整目录及 `retrieval.md`，但工具只有 `rp_data_query/get/resolve`，没有 `read`。检索工作流启用了 `documentWorkspace`，普通上游资料不再内联。[pi-rp-web.ts:1421](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:1421) 按 Agent 白名单生成实际工具集。

**影响：** 文件已正确交付时，Agent 仍无法通过工具阅读；可能额外查询重建目录，或者在缺少完整资料的情况下匹配记录。这不是模型能力问题。

**处理方向：** 补齐所需文件读取权限，并校验所有“要求读取工作区文档”的 Agent 与实际工具集是否一致。

### R03：维护范围只在提示词中约束，提交端没有执行

**证据：** [prepare-maintenance.mjs:6](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/prepare-maintenance.mjs:6) 接受 `maintenanceRequest.targetIds`；[commit-maintenance.mjs:4](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/commit-maintenance.mjs:4) 直接校验并提交 Agent 批次，没有核对这些 ID，也不将 `taskType` 转成允许的操作集合。该节点对多个 collection 有维护权限。

**复现：** 用户目标为 `entity-A`，模拟 Agent 输出对现存 `entity-B` 的 `retract`，revision 正确。当前提交函数成功将 B 的撤回送入模拟 `data.submit`，没有拒绝。

**影响：** Agent 理解偏差可以扩展用户指定的维护范围。统一数据服务能检查 collection、动作和 revision，却不知道本次用户只授权了 A。

**处理方向：** 提交前由代码核对目标白名单和任务允许动作；确需连带修改时，先形成显式的关联修改范围。不能仅依赖提示词“不扩大范围”。

### R04：生图去重键存在实际语义漂移

**证据：** [Web 生图入口:2015](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:2015) 的去重键包含 `userDirection`，但[模块执行器:18](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/persist-and-render.mjs:18) 只使用 `chatId/imageTarget/profileIds/trigger`，不包含额外要求、参考内容或 profile 内容版本。模块只要查到同键请求就退出，不区分之前是否成功。

**复现：** 相同剧情、配置和触发条件下，将要求从 `daylight` 改为 `night scene`，模块产生完全相同的键；存在旧请求时两者都返回 `duplicate: true`。

**影响：** 用户改变要求仍可能无法生成；旧请求失败后再次发起也可能被旧记录挡住。去重检查位于提示词 Agent 之后，重复请求仍先消耗一次模型调用。

**处理方向：** 明确区分请求重放、用户重新生成和内容相同；让入口与模块共用一个请求身份方案，并在 Agent 前做可确定的重复判断。

### R05：两个完整模块不会进入常规 Git 发布

**证据：** [.gitignore:12](M:/ai/SillyTavern/bobo-agent-rp/.gitignore:12) 忽略 `global-modules/*`，后续只放行 ComfyUI、记忆、导演三个模块，没有放行近场和广域。`git check-ignore -v` 已确认两者的 `module.json` 命中该规则；README、项目状态和工作流已经引用它们。

**影响：** 普通 `git add`、提交、clone 不会带上这两套源文件；本地检查正常，发布后的模块集合却不完整。基于默认 `rg --files` 的清单和验证也容易漏掉它们。

**处理方向：** 完善发布白名单，并验证“文档宣称的模块、磁盘模块、可提交模块、测试覆盖模块”一致。

## 冗余、重复实现与边界问题

### R06：完整历史通过旧入口重复进入模块上下文

**证据链：** [pi-rp-web.ts:1639](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:1639) 和第 1778 行将全部可见历史生成为 `frozenContext`；第 952 行的 `forwardPayload` 将整个 payload 复制进调用参数。归档、范围修复、维护、压缩、生图的顶层模板均开启它。模块 Agent 组装时，第 1232 行内联 `frozenContext`，第 1233 行又序列化包含它的整个调用参数；[rp-workspace-handoff.mjs:32](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-handoff.mjs:32) 还将参数写进 `CALL-INPUTS.md`。

**影响：** 即使归档代码已选好归档范围，或生图代码已选好最近几轮，Agent 仍收到完整历史，且在提示词中至少重复出现两种表示。长期会话中，这部分输入随总历史增长，而不受模块选定窗口控制。

**处理方向：** 用参数白名单组装取代整个 payload 透传。技术运行状态、用户业务参数、文档引用分别传递；已生成资料文档时仅传路径，不再次序列化内容。

### R07：模块调用协议容许未声明参数，生产者和消费者依赖隐式约定

**证据：** [normalizeWorkflowCallRequest:864](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs:864) 检查必填输入和输出名，但没有按声明拒绝额外参数，也没有普遍验证参数 `valueType`。例如生图接口只声明可选 `request` 对象，实际代码读取顶层 `profileIds/inputPolicy/customBrief`；来源捕获同时接受 `payload.captures` 和 `payload.request.captures`；故事代码又读取 `payload.call.arguments.assignment` 并回退到顶层。

**复现：** 向生图接口传入未声明的 `inputPolicy/customBrief/frozenContext`，规范化函数全部保留并接受。

**影响：** 接口文档无法完整说明真实输入，复制旧模板可以继续携带无关内容，参数改名或形状改变也缺乏统一报错位置。R06 的冗余正通过此处继续传播。

**处理方向：** 选定一种业务参数位置，完善接口声明与类型验证，将兼容转换集中在明确的一处边界。

### R08：筛选发生在全量读取之后

**证据：** [build-reference-snapshot.mjs:185](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/build-reference-snapshot.mjs:185) 无条件调用 `prepareCatalog`；后者在[第 33 行](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/prepare-catalog.mjs:33) 读取实体、关系、事件、认知、群体全部目录。仅请求某些 collection/ID 也先走这一步；实体 `related-records` 模式随后再发额外索引查询。

**复现：** 只请求 `timeline: {mode: "effective"}`，仍访问全部五个 collection。

**影响：** 精确请求没有减少上游读库和序列化成本；正文时间线、动态检索、归档等路径叠加后，会重复读取大量相同记录。

**处理方向：** 按请求计算必需 collection 和 ID，先索引筛选再组装。完整有效时间线仍应完整交付，不以截断剧情资料来解决处理冗余。

### R09：无任务时仍做昂贵准备，独立准备又被串行排列

**证据：** [归档工作流:25](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/workflows/narrative-memory-archive/workflow.json:25) 和[压缩工作流:25](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/workflows/narrative-memory-compression/workflow.json:25) 中，参考快照与 eligibility 检查均为无条件根节点，只有 Agent 带条件。压缩检查本身还读取一次全部事件。另一方面，前/后置导演的 `prepare-author-future` 依赖 `prepare-private`，前台静态资料准备也排在时间线之后，但这些导出没有数据依赖。

**影响：** 关闭功能、未到阈值或处于冷却时仍扫描/生成快照；有任务时，互不依赖的准备串行增加等待。Agent 的“无需归档则输出空结果”提示也与已有代码路由重复。

**处理方向：** 将轻量 eligibility 放在快照前，复用已经取得的有效事件投影；独立资料准备并行，保留必要的业务执行顺序。

### R10：分页与目录适配各自实现，并出现漏处理截断的路径

**证据：** [记忆 queryAll:1](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/lib/data-helpers.mjs:1) 与[导演 queryAll:1](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/runtime/lib/data.mjs:1) 的循环相同，却分别维护 `20/6000` 与 `500/500000` 默认分页参数；`catalogEntry` 和 `catalogResult` 又重复维护相同的中文 view 标签到内部字段映射。

更实质的问题是，[故事发布器:13](M:/ai/SillyTavern/bobo-agent-rp/global-modules/local-scene-narrative/runtime/workflow/publish-story.mjs:13) 单次读取系列前 500 条就求最大业务序号；[故事准备器:22](M:/ai/SillyTavern/bobo-agent-rp/global-modules/local-scene-narrative/runtime/workflow/prepare-story-context.mjs:22) 单次查询后宣称提供完整系列并选择上一篇，均未处理 `nextCursor`。广域模块存在同样代码。

**影响：** 超过单页记录数或字符预算时，可能选择较旧的“上一篇”，或再次计算出已存在的业务序号。重复 helper 本身不意味着预算应统一成一个值，但分页完成条件应统一。

**处理方向：** 共用分页遍历和投影适配，预算由调用者配置；“最新一条/最大序号”使用对应排序和最小视图，要求完整系列时明确遍历分页。

### R11：近场和广域模块的机械代码与结构平行复制

**证据：** 两模块的 `prepare-story-context.mjs`、`validate-candidate.mjs`、`publish-story.mjs`、`export-recent-stories.mjs` 在逐份比较中，主要差异只有 module ID、record type、文案及 `scene/topicId`。两份 `story.schema.json` 的 SHA-256 完全相同；data contract 的存储、索引、view、动作主体也相同。入口示例：[近场候选校验:1](M:/ai/SillyTavern/bobo-agent-rp/global-modules/local-scene-narrative/runtime/workflow/validate-candidate.mjs:1)、[广域候选校验:1](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-scope-narrative/runtime/workflow/validate-candidate.mjs:1)。导演[审核组装器:15](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/runtime/workflow/assemble-reviewed-stories.mjs:15) 另有一份相似元数据校验。

**影响：** 字段、分页、目录格式、幂等和校验规则修复需要同步多份，R10 的问题已经在两模块中同时存在。

**处理方向：** 共用故事包校验、发布、目录导出和资源复制等机械函数，或从单一源生成可独立导入的副本并验证一致性。保留各模块的所有权、权限、Agent、素材、文风、场景/题材语义独立。

### R12：Web 重生成与模块生图各自维护执行状态机

**证据：** [persist-and-render.mjs:21](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/persist-and-render.mjs:21) 与[regenerateComfyRender:2041](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:2041) 都自行分配序号、组装请求和 render、创建批次、调用 ComfyUI、写 submitted/completed/failed。一个处在模块工作流中，另一个从 Web 启动独立异步任务。

**影响：** 两个入口的排序、并发和恢复策略会独立演变。两处还共享一个缺陷：submitted 已成功写入 revision 2 后，如果 completed 写入失败，catch 仍用 `expectedRevision: 1` 写 failed，错误处理会再冲突。

**处理方向：** 抽出统一的请求/render 创建和执行服务，由不同入口提供业务参数。状态更新使用实际状态/revision；重生成可以继续不调用 Agent，但应复用同一确定性执行链。

### R13：生图输入包含同一内容的两套字段

**证据：** [resolve-input.mjs:31](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/resolve-input.mjs:31) 同时返回 `referenceContext/imageTarget/userDirection`，以及包含同一三项文本的中文 `promptInput`；还将 `connectionId/digest/workflowDigest/profileRevision` 等执行字段和模型指导一起返回。工作流将整个对象传给提示词 Agent，未创建消费端投影。

**影响：** 剧情目标和参考文本在一次上游输入中直接重复；Agent 只需按 guide 写内容片段，却同时收到持久化和连接所需的技术元数据。模型指导位于 JSON 后部，也没有统一文档首部使用说明。

**处理方向：** 保留一份执行用对象，另由代码生成 Agent 专用文档：开头写参考/目标/输出格式说明，随后放 guide、目标、必要连续性资料；执行字段留给代码节点。

### R14：导演交接捕获失败重试会产生重复来源记录

**证据：** [capture-archive-outbox.mjs:4](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/integration/runtime/capture-archive-outbox.mjs:4) 未传 `captureId`；[capture-sources.mjs:9](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/capture-sources.mjs:9) 因而用子运行 ID 构造新记录。捕获成功后才单独确认 outbox；若确认失败，下一次仍读取 ready 项。作为对照，故事发布捕获已传 `memory-source-${candidateId}`。

**复现：** 模拟捕获调用成功、确认提交失败，再执行一次；相同 `dedupeKey` 的来源被调用捕获两次，两次都没有稳定 capture ID。实际子运行 ID 不同时会创建不同记录。

**影响：** 同一交接重复存储、重复传给归档 Agent。来源说明还要求 Agent 按 `dedupeKey` 去重，让可以由代码识别的重复进入语义归档流程。

**处理方向：** 由来源 module、记录 ID 和所需版本定义稳定 capture ID，在捕获端确定性去重；保留跨模块确认失败后的可重放性。语义相似但并非同一来源的记录，仍需要语义判断。

### R15：已保存设置与真正生效的预算不是同一来源

**证据：** [frontend-view.json:31](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/frontend-view.json:31) 暴露检索预算及自定义预算开关；[compose-memory.mjs:44](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/compose-memory.mjs:44) 却只使用调用 payload 或代码常量。检索工作流没有读取 support 设置的准备节点。压缩的 `initialTriggerEntryCount/initialTargetEntryCount` 又与 maintenance-state 初值各保存一份，现有准备逻辑只读后者。

**复现：** 标准 compose 路径只访问 knower-groups，不读取设置，返回的是 `STANDARD_RETRIEVAL_BUDGET`。搜索确认 `customBudgetInterfaceEnabled` 只在 schema、初始数据、前端和测试中出现，没有运行时代码消费。

**影响：** 设置表单中的某些修改不会改变实际行为。`initialInspectLimit/supplementalInspectLimit` 虽在预算对象中存在，实际候选查看次数也主要靠 Agent 遵守，工具入口没有按这两项累计计数。

**处理方向：** 在代码准备节点确定唯一有效配置，区分“建会话初值”和“当前阈值”，消除或接通无效设置；机械预算由工具包装层计数。业务上允许的完整目录可读性不应被此改动意外削弱。

### R16：指导重复且已有相互冲突的版本

**证据与表现：**

- [FOREGROUND-INTEGRATION.md:6](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/integration/FOREGROUND-INTEGRATION.md:6) 仍要求正文 Agent 自行整理导演输入目录，再传 `context`；当前[进阶正文模板](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/workflows/advanced-memory-rp/workflow.json) 与运行时却自动生成该快照，并拒绝调用者覆盖。
- [retrieval.md:30](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/skill/references/retrieval.md:30) 的自定义预算章节仍展示旧式结构化 `memory-retrieval-request`，与同文件开头及当前接口要求调用方提交自然语言清单不一致；`defaultBudget` 与实际读取的 `retrievalDefaults` 也不一致。
- [prepare-archive.mjs:74](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/prepare-archive.mjs:74) 生成的 context 先放早期正文、归档正文和外部内容，再放来源使用指导。部分核心流程说明散在 Agent prompt、workflow prompt、Skill 和 IMPORT/集成文档中，没有清晰区分消费指南与开发说明。

**影响：** Agent 或转卡开发者可能按旧说明重复整理资料，或发出被运行时拒绝的调用。接收者阅读交接文件时，无法先得到完整使用说明。

**处理方向：** 每种交接产物以首部说明或根 `DOCUMENTS.md` 为消费指南入口；调用提示只描述本节点任务及入口位置。机械签名由接口生成；开发文档解释接入，不重复维护另一套运行步骤。内容特有的知情范围、权威性和条件仍应就近保留。

### R17：同一套文档被传给不消费它的节点，机器表示也无条件随行

**证据：** [executeWorkflowNode:907](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:907) 对每个 Agent、code、call 节点均调用输入和触发文档 staging；[stageWorkflowCallInputs:14](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workspace-handoff.mjs:14) 将该子工作流的全部调用文档复制到每个节点工作区。导演的 prepare、commit、export 等代码节点因此也取得完整调用上下文；后置两条发布分支分别继承整个 reviewed 集合，实际各自只使用 local/world 子目录。

此外，[build-reference-snapshot.mjs:200](M:/ai/SillyTavern/bobo-agent-rp/global-modules/narrative-memory/runtime/workflow/build-reference-snapshot.mjs:200) 无条件生成同时含目录/时间线数据的 `snapshot.json`。当前根源中的生产代码搜索未找到其读取者，主要下游读 Markdown，却仍递归携带这一机器副本。

**影响：** 多个节点重复做目录遍历、复制和存储；物理可读范围也大于实际任务需要。此处不能直接换算成 token 开销——文件进入工作区不等于 Agent 已读全部文件。

**处理方向：** 为节点声明所消费的输入或由代码生成最小子包；机器 JSON 按消费者需要导出。共享不可变工件时仍应保留显式授权、路径隔离和生命周期，而不是暴露父工作区。

### R18：协议外壳和固定排序仍由 Agent 生成

**证据：** 前置、后置、审核 Agent 均被要求输出完整 `protocolVersion/commitPolicy/batch` 结构；[commit-agent-batch.mjs:1](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/runtime/workflow/commit-agent-batch.mjs:1) 已自动补 batch ID、operation ID、status，却仍要求并检查 Agent 给出固定协议值。后置提示要求把 archive-outbox 操作排在 private-state 之前，代码只检查顺序，错误即失败。

**影响：** 模型承担重复协议拼装和机械排序，出错时会增加重试或人工检查。R14 的同来源去重、R15 的预算计数，也属于可以继续下沉到代码的工作。

**处理方向：** Agent 输出语义操作及必须判断的业务字段；代码统一添加固定外壳、稳定 ID、已明确且不存在依赖冲突的排序，并完成校验。不要据此取消归档事实提取、事件/认知区分、压缩语义分组或导演判断。

## 不应误删的合理结构

- 当前记忆正文组装已去掉 `derivedFacets/summaryOverLimit` 等维护字段，且限制视角由代码按知情范围过滤；检查中没有把它们误报成最终正文冗余。
- 导演采用“指导记录 + 发布清单 ID”并由代码生成 Markdown，已经避免 Agent 每轮重抄整份指导。
- 故事审核的 `accept-original` 由代码复制原稿，无需 Agent 重写；只在替换时要求完整替换稿，职责合理。
- 权威记录、历史版本、索引、审计和工作区快照有不同生命周期；不能仅因保存了相似信息就统一删除。
- 近场/广域业务分离，以及卡片导入后成为独立副本，是明确设计。适合统一的是它们的开发源和机械处理，不是取消隔离或自动同步已有卡。
- 两级归档和语义检索包含自然语言理解，不能仅因输出清单/JSON 就断言整个 Agent 可由普通代码替代。可以先为明确 ID、精确名称和已确认来源建立确定性通道，但仍需评估歧义处理和信息控制。

## 验证与局限

现有测试由有界子任务运行：公共 runtime **106/106**、全局模块 **23/23**、Web **6/6**、ComfyUI 适配工具 **2/2**，总计 **137/137 通过**。模块测试枚举包含被忽略目录，没有因默认 Git 过滤漏掉近场测试。

另执行了不调用模型/ComfyUI的临时复现：目录索引被当成快照文件、仅时间线仍读五类目录、维护目标越界被提交函数接受、不同生图要求产生同键、未声明参数被接受、outbox 确认失败重复捕获、检索组装未读取持久设置。所有持久化入口均使用模拟对象，没有改动真实会话数据。

测试通过并不覆盖以上边界。例如现有快照测试直接传目录路径，没有经过 Web 桥接将路径改为 `DOCUMENTS.md` 的步骤；模块准备函数测试也没有运行“顶层入口透传 → Agent 提示组装”的完整链。因此本次重点缺口是跨层集成与失败恢复覆盖，而非缺少更多相似单元测试。

未执行 Python 测试（当前 PATH 无 Python），未进行真实转卡、真实模型或真实 ComfyUI 的端到端验证；未量化长期会话的数据体积与 token 开销。本报告不是安全认证，也不声称穷尽所有缺陷。

建议先处理 R01—R05，再集中处理参数/工件交接（R06、R07、R13、R16、R17），随后统一分页、故事与生图机械实现并修复重复捕获及配置问题。这样可以在保留业务语义的前提下减少重复代码和无效 Agent 输入。
