# PROJECT STATUS

更新时间：2026-09-16（第四轮：批次 3 修复后）

当前分支：`main`

当前 `HEAD`：`c0ba68e`（`fix: judge a card by its own design and disclose orchestration`）。工作树干净。

## 交接结论

### 本轮（全面审查 + 批次 1—3）

对项目做过一次全面审查（恶性问题 + 游玩期提示词两条线），共立案 15 条缺陷与 21 条提示词条目，产物是被忽略的 `local-development-records/` 下两份清单：

- `PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`：缺陷清单，15 条（其中 12 条已实施）
- `PROJECT-REVIEW-PROMPT-CHECKLIST-2026-09-16.md`：提示词清单，21 条全部定稿，**尚未实施**

**已实施的 12 条**：

| 批次 | 条目 | 提交 |
| --- | --- | --- |
| 1 | FIX-001 / 002 / 005 / 006a / 012 / 013 / 014 | `d6b03b8` `a28da96` `ae33c4c` `7a655ed` `ec71465` `8382e74` `485082a` |
| 2 | FIX-011（调度器韧性） | `ef6c058` |
| 2 | FIX-003（终态失败释放回合）+ FIX-004（失败分类） | `316c2dc` `ceb9a57` |
| 3 | FIX-006b（编排依赖进闸门）+ FIX-007（设计约定降级 + 卡自声明不变量） | `c0ba68e` |
| — | FIX-015（批次 1 引入的校验器回归） | `a1a7cbc` |

其中四条是本轮之前完全未知的：

- **FIX-002**：两个前台工作流的代码节点入口写成运行时相对路径，而执行器只按卡片目录解析——**每张按文档转换的卡都会在第一回合失败**。
- **FIX-014**：`director-health-report` 对 `archive-outbox` 误用写能力，导致**任何安装世界叙事统筹模块的卡都无法通过校验**。由本轮新建的「真实模板自校验」回归**首次运行**抓出。
- **FIX-006a**：校验器只检查顶层工作流的调用目标，**模块工作流节点的错目标与悬空调用在校验期完全不可见**。
- **FIX-003**：前台工作流一旦真正进入终态 `failed`，回合占用永不释放且面板无取消入口——**一次确定性失败即卡死整个会话**。

**FIX-015 是批次 1 自己引入的回归**：卡内新增的入口/调用校验没有区分"卡"与"项目全局包源码树"，使 `validate-module.py` 报出 12 条假错误。批次 2 的验证扫描抓到，已修并补了源码树夹具回归。教训已记入缺陷清单。

**批次 3 的性质与前两批不同**：它不是修 bug，而是把校验器的职责重新划分——协议/格式一致性与跨引用完整性保留为硬校验；对**卡的设计**的断言降级为 `design:` 警告（卡可以自由改名、替换、解耦前台工作流），需要强制时由卡在 `manifest.design_invariants` 里自己声明，声明即校验。同时把"编排性依赖"（导演驱动叙事模块）从任何硬编码检查中移出，改为模块目录下的 `dependencies.json` 侧车记录 + 转卡闸门的两条路披露。

**尚未实施**：缺陷清单的批次 4（FIX-008/009/010）；提示词清单的 A 组 7 条 + C 组 1 条；以及两份清单各自登记的待定稿/待取证条目。

### 前序轮次

正文 Agent、模块工作流调用、卡片静态资料库、叙事记忆、ComfyUI 剧情生图及其公共基础设施已有代码实现。再次验收发现的 F01—F08、团队深度导演验收发现的 F01—F14、随后修复复核发现的 R1—R9，以及第二轮复核发现的 S1—S9，均已完成修复并通过自动验证。

真实模型、真实 ComfyUI 与重新转卡的端到端验证**仍未执行**。不要未经用户授权修改 `play/` 或执行真实付费模型/生图测试。

开始后续工作前依次阅读：

1. [README.md](README.md)：项目入口、使用方式与文档导航。
2. [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)：根源、安装运行时、卡片与 session 的独立修改边界。
3. [PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md](PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md)：公共能力的确认与实施台账。
4. 对应全局模块的 `IMPORT.md` 和模块 Skill。
5. 本轮两份清单（被忽略目录）：先读缺陷清单的「实施顺序约束」与「后续待定稿」，再读提示词清单的「判定纪律」。

## 工作区边界

- 本阶段只修改仓库根目录的 Skill、规范、全局模块源、运行时/Web 模板、测试和文档。
- `play/` 被 Git 忽略，本阶段没有读取、修改或同步其中的卡、共享运行时、设置与 session。根目录修改不会自动传播到那里。
- 根目录 `.pi/APPEND_SYSTEM.md` 已被 Git 跟踪，内容是用户自行添加并明确要求保留的开发会话追加提示入口。它属于用户所有，不是空占位文件；任何开发、清理、模板同步或发布整理都不得清空、覆盖或改写它。
  - **注意区分**：`assets/pi-rp-runtime/.pi/APPEND_SYSTEM.md` 是另一份文件（游玩运行时的 RP 协议提示），与本条所指的根目录文件无关。该运行时文件的内容已被决定**全部舍弃**，见「当前待办」。
- 全局模块复制进卡后即成为卡所有的副本；以后更新根源不会自动升级该卡。
- 用户如要求修改既有卡、安装运行时或 session，必须把该层作为单独目标明确授权。
- 本轮新增 `assets/card-runtime/`（内容按相对路径复制到卡根）与 `local-development-records/` 下的两份清单及回归脚本；后者位于被忽略目录，不随发布提交。

## 当前实现

### 公共协议、运行时与工作流

- 模块协议版本为 Module v6，区分 data/resource/hybrid；数据部分继续使用 Data Contract v1、Record Envelope v2、Change Batch v1，工作流使用 Workflow v3。权威规范位于 `.agents/skills/design-pi-rp-data/references/protocol.md`。
- 一个模块可以拥有多个 collection 和 record type。索引、目录及创作文档属于可重建派生数据；Agent 只通过命名 view 和节点授权读取数据。
- 持久修改统一通过带幂等 ID、`expectedRevision`、提交策略和事务回执的变更批次完成。公共运行时负责 envelope、历史、索引、provenance、回滚与恢复。
- Workflow v3 支持 `agent`、`code`、`call`、`gate`、`join`、`workflow-return`、`turn-finalize`，使用 DAG 依赖、模块工作流调用边界、节点级 `moduleAccess`、声明式产物和节点结束提交。
- 模块只暴露完整的自有工作流，不把内部节点或工具直接拼接/暴露给调用方。顶层或模块节点通过同一调用并等待机制使用模块工作流；修改权威数据的 `module-internal` 工作流按模块串行，对外只读工作流可并发。模块工作流只能继续调用对外工作流，并设调用环与最大深度保护。
- Agent/代码节点仅能调用自身 `workflowCalls` 明列的入口；绑定可声明固定参数与允许值范围。Agent 只看到 `agentCallable` 入口及机械接口信息，何时调用完全由节点作者的任务提示决定；返回给 Agent 的正文只有输出文档路径。
- 公共随机服务同时提供 Agent `rp_roll` 工具与代码节点 `services.random.roll()`；前者由 Agent 工具白名单授权，后者由 `runtimeServices: ["random"]` 授权。二者共享结构化骰子语义、加密安全随机源和按运行/节点/key 幂等的非上下文化审计记录。
- `document-set` 是带 `DOCUMENTS.md` 的递归目录产物；普通目录也可声明为 `kind: "directory"`。模块调用的文件/目录输入与导出均使用调用方指定且防碰撞的路径；静态资源模块不伪造权威数据集合。正文节点还能显式生成不可变 `document-workspace-snapshot`：只冻结运行时登记资料、动态调用结果、当前输入和最终正文，记录文件哈希并执行文件数、大小与深度上限；顶层触发器可把指定快照映射给后置工作流。
- 影响分析、规划、正文或检查的模块统一通过声明式工作流文件/目录输出提供材料；接入可组合采用正文前准备、正文后生成供后续回合使用的内容、以及归档到记忆或其他权威模块供以后检索。跨回合资料必须由后续工作流显式重新导出或准备，工作流唤醒不携带工作区。
- 通用节点级 `workspaceHandoff.include` 只移交生产节点显式列出的命名文件或文件夹，并默认把它们放到后继节点的 `handoff/<生产节点>/<原工作区相对路径>`，形成白名单镜像；可选 `as` 只用于有意改名。不扫描整个工作区，不支持通配符或 `exclude`，缺失、类型不符、越界、符号链接、路径重叠或非一致碰撞都会失败。
- 任意 Agent 节点都可用 `metadata.documentWorkspace: true` 选择通用文档式上游交付：运行时把普通上游结果、交接镜像根和已显式移交的内容编入 `WORKSPACE-DOCUMENTS.md`，不再隐式复制所有声明产物或模块调用结果，也不会解析或重建上游知识地图。知识地图本身只有被声明并列入交接白名单才会移交；其中相对路径从对应镜像根解析。未启用的 Agent 保持普通上游结果与获准文件交接的内联行为。该能力不区分正文、导演或其他 Agent。
- 回合后台工作流可在触发绑定上显式设置 `blockNextTurnUntilReady`（默认 `false`）；代码节点可用 `routeFromOutput` 驱动静态条件分支，并能把延迟数据批次绑定到仍然可见的历史消息。
- 顶层工作流支持 `after-opening` 触发；模块内部工作流默认保持整模块写锁，也可显式声明集合锁，使不相交集合的工作流并行。节点查询预算可声明调用方可选参数及静态上限；Agent节点的模块调用绑定还能声明 `maxCalls`，用于硬限制一次或两次检索。前台工作流用 `turnContext.recentCompleteTurns` 统一控制最近正文和近期模块故事窗口。
- 消息、工作流运行和可见产物保留独立的技术生产者与叙事来源层。事务还可保存实际输入消息的精确 revision，并提供只读影响查询和完整性诊断。
- 声明式模块前端 schemaVersion 2 支持 `record-browser`、`story-browser`、`settings-form`、`workflow-controls`、`integrity-alerts`；`story-browser` 提供摘要目录、按需全文、系列分组和显式高级权威源入口。普通浏览器不能借前端声明扩大模块能力或直接写权威文件。

### 全局与单卡配置方案

- 根目录新增 `manage-pi-rp-config-ui` Skill，以无卡、无聊天、无持久会话的只读游玩 bridge 启动与 `play` 相同的 Web UI，用于预览通用前端；同一侧栏中的配置方案仍可编辑，首次启动会建立并激活全局“开发默认”方案，卡片 Web 则使用单卡作用域。
- 配置方案覆盖模型 URL、协议、模型名、限制、前后置提示词，通用/模块 Agent，以及工作流运行策略、触发方式、Agent 节点绑定和模块公开参数。Agent 与工作流都使用“通用/模块—具体对象”两级选择，“通用”仅包含没有模块所有者的内容。工作流展示全部节点及类型，只有 Agent 节点显示 Agent、模型、提示词和上下文配置。模块参数从声明的 `settings-form` 初始记录载入。每个字段的问号提示都与标签同排，并支持悬浮/聚焦。
- 模型、Agent 和工作流配置入口已统一收进配置方案，侧栏不再显示重复的模型与 Agent 页面；独立工作流页只负责定义、节点与实例状态展示以及运行期操作。根目录可编辑用户资料和字号并保存到 `.pi-rp-local/`，游玩时共享 common 设置作为回退、卡内 common 类别覆盖且优先。
- 全局方案保存在根目录忽略区，单卡方案保存在对应卡的 `config-profiles/`；均支持新建、改名、复制、切换、删除和 JSON 导入导出。导入会校验 schema 与作用域，导出和复制均不包含 API Key。
- API Key 继续写入操作系统项目隔离缓存，并进一步按作用域、卡、方案和模型隔离。模型/Agent 在下一次调用生效，工作流覆盖在下一次实例生效，模块初始化参数只用于新会话首次建库，不重写已有会话。

### 正文 Agent 与卡片静态资料

- 卡片清单使用 manifest v2，`fixed_context` 只指向一个精简的 `core/foundation.md`。该文件主要承载来源支持的世界/前提总览与故事长期基调、原则、走向；详细人物、世界观、规则、创作指导、文风、格式和参考资料不再塞入固定上下文。
- 每张新转卡都包含 `card-context-library` resource 模块。其 catalog v1 以完整 Markdown 文档为最小交付单元，分别记录类别、阅读策略、权威性、适用阶段、优先级、选用组、选用说明、视角、别名、关联和来源。
- `card-context-library/export-context` 按调用节点指定的类别导出全部匹配文档及动态生成的知识地图 `DOCUMENTS.md`。基础实现为粗粒度类别快照；需要更精细检索的卡可定制或替换模块工作流。
- `standard-rp` 和 `advanced-memory-rp` 都使用普通 Agent 正文节点，并允许在正文前接入上游资料准备。标准流程静态准备卡片资料；进阶流程固定准备完整有效事件时间线，正文 Agent 自己分析情景、提出简单资料目标并动态调用记忆检索，完成资料推理和初步规划后才选读详细资料、修正规划并创作。
- 清单中的阅读策略用于支持 Agent 判断，不由运行时硬编码强制读取。正文 Agent 与其他 Agent 没有权限或调用机制上的特殊身份，未来可在同一接口上增加并行候选正文节点。

### 叙事记忆全局模块

源目录：[global-modules/narrative-memory/](global-modules/narrative-memory/)

- 七个 collection：实体、关系、事件/事件摘要、认知、知情群体、来源捕获、运行支持记录。
- 目录与时间线由无 Agent 的 `narrative-memory-reference-snapshot` 对外工作流统一按参数生成，可只取目录、只取有效时间线或同时取两者，并支持实体 `entry-only`/`related-records` 与字段筛选。检索工作流 `narrative-memory-retrieve` 从调用方 Agent 的自然语言 Markdown 查询清单开始，内部解析为结构化选择、确定性组装并返回 `document-set`；不再负责情景分析，也不再自动附加完整时间线。
- 归档采用两级结构：第一级只列客观 Markdown 清单，第二级负责定位、语义建模与统一变更；支持多轮连续归档、冷却、最新轮保护、早期正文参考和外部模块来源捕获。
- 实体、关系与认知支持信息控制；知情群体支持嵌套、排除、`dynamic` 及可补录旧成员的 `fixed`。不生成重复的角色个人记忆副本。
- 时间显示与机器排序分离；卡级适配器必须定义严格 `trueTime` 格式并持久生成排序值。
- 事件目录压缩默认目标 90、触发 150，每次成功压缩后两项各增加 10；摘要超限先标记，下一次归档再由 Agent 缩减，不由代码截断。
- 自动归档与用户指定范围的 `repair`/`supplement` 都会写入覆盖记录。前端提醒缺少覆盖或归档后正文 revision 变化，但不会自动使记录失效或自行启动修复。
- 默认实体、事件等模板各自保存在独立文件中；卡可以注册自定义模板与 `unique` 实体模板。

导入和卡级适配要求见 [global-modules/narrative-memory/IMPORT.md](global-modules/narrative-memory/IMPORT.md)。

### 世界叙事统筹全局模块

源目录：[global-modules/world-narrative-coordinator/](global-modules/world-narrative-coordinator/)

- 私有、深度、参考资料、归档交接、健康快照和设置域分别保存日常孵化与指导、完整深度报告、持久知识扩展、已确认归档材料、手动统计结果和配置；创作工作流不能读取私有或深度资料。
- 前置导演在正文 Agent 完成分析与记忆检索后轻量调整；后置导演在正文落地后完成主要复盘并阻塞下一轮；深度导演按后置建议异步启动，可选择旧版单 Agent 或动态团队会议。团队版含必需基础检索、可选中途助理、弹性讨论、排空、总结陈词、秘书草稿、一次审查、最终修订与参考文档写作。
- 指导以稳定 ID 记录，由各频道发布清单选择，确定性组装器支持条目 Note，避免 Agent 重抄整份输出文档。
- 归档沿用叙事记忆的通用来源捕获；进入 `archive-outbox` 的内容必须已经确认需要归档并带知情范围，且不是每轮必写。
- 团队会议期间不占数据写锁，最终以短锁原子提交报告与参考资料，并用生命周期收尾处理失败、取消和跳过。数据健康只统计、更新前端快照并提醒；维护与完整性修复均为用户手动启动。模块前端可查看状态、正式参考资料、统计和设置。

导入和卡级接入要求见 [global-modules/world-narrative-coordinator/IMPORT.md](global-modules/world-narrative-coordinator/IMPORT.md)。

### 近场与广域叙事全局模块

源目录：[global-modules/local-scene-narrative/](global-modules/local-scene-narrative/) 与 [global-modules/world-scope-narrative/](global-modules/world-scope-narrative/)

- 近场叙事负责主线当前地点及周边的其他完整故事；广域叙事负责世界范围内通常更特别、更持久且值得传播的故事。两者均有自己独立的创作准则、文风与格式资料。
- 后置导演输出语义委托，运行时补充技术ID；两个候选分支可并行。候选只包含完整正文及模块、目录摘要、时间范围、地点、角色、重要或唯一实体等最小结构数据，不写事实。
- 后置工作流的第二次导演Agent调用等待全部候选，只审核硬冲突和明显逻辑硬伤；默认保留原稿，修改时必须提供完整替换稿。随后各模块无Agent发布工作流并行提交，发布成功即成为世界事实并进入通用来源捕获。
- 深度导演报告维护一个广域活跃题材和至少一个备用题材；题材耗尽不会单独唤醒深度导演。近场与广域创作均不得走到正文当前世界时间之后。
- 前端“一隅众生”和“万象潮生”默认随模块区域收起，玩家可自由阅读；正文按 `recentCompleteTurns` 获取摘要式目录和按需全文，更早故事走叙事记忆。
- **两者都不是可独立使用的完整功能**：由后置导演决定何时委托、给什么指导、审核并发布，再由通用来源捕获归档。这一编排依赖无法被任何结构检查看见（模块内部没有调用指向导演），因此记录在各自的 `dependencies.json` 侧车里，转卡预选阶段必须据此披露"补选导演"与"卡内解耦"两条路及各自的工作量与风险；校验器**不读**该文件。

导入要求见各自的 `IMPORT.md`，统一后置编排模板见 `global-modules/world-narrative-coordinator/integration/workflows/director-post-with-narratives/workflow.json`。

### ComfyUI 剧情生图全局模块

源目录：[global-modules/comfy-image-generation/](global-modules/comfy-image-generation/)

- Module v6 data/Data Contract v1 包含会话偏好、分阶段持久化的生图请求、带状态 revision 的 render 记录及模块自有工作流清单。
- `comfy-image-generation/agent-image-generation` 是带外部副作用的 `module-internal` 工作流，由同名顶层手动包装入口调用；内部使用 `image-prompt-writer`，Agent 只写随画面变化的内容片段。
- profile 负责固定质量、风格、LoRA、负面提示词、ComfyUI 节点绑定和输出选择；API-format 工作流通过根目录 `adapt-comfyui-workflow` Skill 分析和适配。
- Web 提供工作流选择、快速/定制生成、连接测试、缩略图与原图、提示词查看、profile 覆盖和派生重生成。
- 图片文件始终留在 ComfyUI output；项目只保存请求、提示词、状态和输出引用，不因删除聊天或正文而删除图片。

导入要求见 [global-modules/comfy-image-generation/IMPORT.md](global-modules/comfy-image-generation/IMPORT.md)。

### 转换、模块开发与卡片维护

- `st-card-to-pi-rp` 在正式转换方案前先列出全局模块并等待选择；选择会改变内容承载方式的模块时，方案必须明确迁移、保留、来源适配和权限影响。选择带 `dependencies.json` 的模块时还须披露其编排依赖与解耦代价。
- 卡包校验器把检查分为三类：协议/格式一致性与跨引用完整性是**错误**（阻断）；对**卡的设计**的断言（前台工作流是否准备卡内资料、是否先备记忆时间线、正文 Agent 是否暴露指定调用、`card-context-library` 是否保持随发布形态）是 `design:` **警告**（不阻断，逐条记入 `conversion-report.md`）；卡可以在 `manifest.design_invariants` 里声明自己要保留哪些设计不变量，**声明即校验、违反即错误**，未声明则一律不查。因此卡改名、替换或解耦前台工作流不再被模板断言误伤，而沿用随发布模板的卡仍能恢复原有的防护力。
- `design-pi-rp-data` 负责统一数据所有权、结构、检索、变更、事务和工作流访问设计。
- `create-pi-rp-feature-module` 只在明确目标和方案确认后创建 card-local 或明确要求的 project-global 模块。
- `audit-and-upgrade-pi-rp-card` 仅在用户明确调用时检查既有卡，并在所有讨论结束、整体方案再次确认后实施。
- `adapt-comfyui-workflow` 只在仓库根目录分析用户提供的 ComfyUI API 工作流；存在映射歧义时先报告并等待确认。

## 顶层升级状态

公共台账中的正式条目均已实施：

| 条目 | 状态 | 已实现能力 |
| --- | --- | --- |
| INFRA-001 | 已实施 | 回合后台工作流阻止下一轮输入及失败/恢复处理 |
| INFRA-002 | 已实施 | 转卡前置全局模块选择与承载变化披露 |
| INFRA-003 | 已实施 | 消息与工作流产物的叙事来源层级 |
| INFRA-004 | 已实施 | 多来源 revision、影响/完整性诊断与显式修复入口 |
| INFRA-005 | 已实施 | 声明式交互模块前端 |
| INFRA-006 | 已实施 | 代码节点输出驱动条件路由 |
| INFRA-007 | 已实施 | 可信代码提交的历史消息绑定 |
| INFRA-008 | 已实施 | 通用随机掷骰服务与双入口授权 |

详细取舍、兼容边界和验证记录保留在 [PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md](PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md)。该文件没有未经用户确认的候选项。

## 验证快照

2026-09-16 完成**批次 3** 修复（FIX-006b / FIX-007）：

- 真实资产自校验扩到 **35 项断言**：新增 13 项设计约定/不变量用例（未声明只警告、声明后成错误、随发布资产零额外警告、四类声明自洽负例）与 2 项依赖侧车一致性用例。
- 校验器单元测试 `14/14` 通过（本轮新增 1 个不变量形状用例，并把导演模块断言改为 warning）。**该套件在本沙箱默认跑不动**——沙箱拒绝在被接管的临时目录内部建目录——因此新增了 `local-development-records/run-validator-unit-tests.py`，把 `TemporaryDirectory` 换成工作区实现后执行原用例，见「已知边界」第 5 条。
- 运行时库测试 `193/194`（唯一失败为自带管道子进程的用例，属沙箱限制）；模块与组合测试 `50/50`（含导演定向 `18/18`）；Web 测试 `6/6`；`node --check public/app.js`、`sync_story_mechanics.mjs --check`、`git diff --check` 通过。
- 校验器的三分读法（error / `design:` warning / 声明的不变量）在回归里各有正负例；`validate-module.py` 现在也会打印模块自身的警告。
- **未执行**：`check_release_manifest.mjs`（沙箱禁止其内部 `git check-ignore`），以及真实卡转换中的端到端验证——即"改名后的前台工作流不再被模板断言误伤"只经实现与用例覆盖，未在真实转换里跑过。

逐项实施记录见被忽略的 `local-development-records/PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`。

2026-09-16 完成**批次 2** 修复（FIX-003 / 004 / 011）并随后修掉批次 1 引入的 FIX-015：

- 运行时库测试 `193/194`（唯一失败为 `rp-team-runtime.test.mjs` 中自带管道子进程的用例，属本沙箱限制，见「已知边界」第 5 条）；其中工作流引擎 `45/45`、工作流状态机 `31/31`。
- 根目录模块与组合测试 `50/50`；Web 测试 `6/6`；`node --check public/app.js` 通过；`git diff --check` 通过。
- 「真实模板自校验」扩到 **20 项断言**，新增独立源码树夹具 `.tmp-module-source-validation/`：6 个随项目发布的包在**没有卡清单**的布局下全部通过，并覆盖两类假错误的负例与"卡内缺模块脚本仍须报错"的正例。`validate-module.py` 恢复通过。
- 新增回归：终态失败释放回合（前端 `failureKind` 分支）、确定性失败分类（代码节点 / Agent 装配前 / 带码配置错误 / 真实 provider 错误）、派发标记逐次尝试重置、调度器 `onChange` 异常不再终止进程。
- 本批次**没有**任何端到端验证：真实 Pi 会话、真实模型与浏览器目视均未执行（见「已知边界」第 1 条）。

逐项实施记录见被忽略的 `local-development-records/PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`。

2026-09-16 完成全面审查后的**批次 1** 修复（FIX-001 / 002 / 005 / 006a / 012 / 013 / 014）：

- 新建「真实模板自校验」回归 `scripts/test_real_asset_validation.py`：用真实资产拼装一张完整夹具卡（6 个模块 + 7 个运行时顶层工作流 + 3 个集成模板），在进程内调用校验器 CLI，覆盖各条目的正负例。**首次运行 15 项断言全部通过。**该脚本**随项目发布**，夹具建在仓库根的被忽略目录 `.tmp-card-validation/`（不使用 `tempfile`，见「已知边界」第 5 条）。
- 该回归**首次运行即抓出 FIX-014**——此前无人发现，因为校验器从未与随项目发布的资产一起跑过。
- 模块测试 `6/6`；运行时库测试 `25/26`（唯一失败为上面那条沙箱限制）。
- 三个改动文件（`.ts` / `.mjs` / `.py`）语法检查通过；`.pi/workflow` 旧路径零残留引用。
- 本轮同时发现并修复了两处**只有把校验器与真实资产一起跑才会暴露**的缺陷：FIX-005（绑定字段白名单与前端区域类型落后于协议）与 FIX-014（`director-health-report` 误用写能力）。
- **该批次自身的回归在批次 2 才被发现**：FIX-002 / FIX-006a 的校验只在"卡"语境下成立，源码树自校验因此报了 12 条假错误（FIX-015）。

逐项实施记录见被忽略的 `local-development-records/PROJECT-REVIEW-FIX-CHECKLIST-2026-09-16.md`。

2026-09-16 完成团队深度导演第二轮复核 S1—S9 的逐项修复与用户确认：

- 公共运行时库测试：`188/188` 通过；根目录模块与组合测试：`50/50` 通过，其中世界叙事统筹模块定向测试为 `18/18`。
- Web 测试：`6/6` 通过；Python 结构与 Skill 测试：`20/20` 通过；受影响 MJS 语法检查及 `git diff --check` 通过。
- 默认记忆检索契约、因果写后读取、operation 身份、结构化产物拒收、成功发布边界、失败用量、并发交付、最终产物证据和父子换模等待均有正式正向回归。
- `awaiting-child` 持久记录准确子运行并保留父运行锁和 operation；目标子节点换模完成后，进程内及重启恢复均会自动接回原父链，且不创建重复子运行。
- 历史 S1—S9 缺陷探针在对应旧行为断言处反向失败，证明九项旧缺陷不再复现。

逐项实施记录见被忽略的 `local-development-records/TEAM-DEEP-DIRECTOR-SECOND-REPAIR-PROGRESS-2026-09-16.md`。

2026-09-15 完成团队深度导演修复复核 R1—R9 的修复与重新验收：

- 公共运行时库测试：`173/173` 通过；根目录模块与组合测试：`46/46` 通过，其中世界叙事统筹模块定向测试为 `14/14`。
- Web 测试：`6/6` 通过；转卡校验器 Python 测试：`13/13` 通过；Web `public/app.js` 语法检查及 `pi-rp-web.ts` Pi 离线扩展加载通过。
- 已覆盖当前权威状态读取、未提交包的来源修订复核、恢复等待保留 operation、交付快照权限、产物哈希、失败用量、重试池、秘书旁路异常和有效模型配置冻结。
- 补充验证了团队 SDK 会话尝试回退、恢复时输入基线不被重写，以及提交瞬间对来源 revision 的再次校验。
- 历史缺陷探针的 9 项“缺陷存在”断言现全部失败，逐项证明旧行为不再出现；正式正确性回归全部通过。`git diff --check` 通过。

修复重新验收记录见 `local-development-records/TEAM-DEEP-DIRECTOR-REPAIR-RECHECK-ACCEPTANCE-2026-09-15.md`。

2026-09-15 完成团队深度导演 F01—F14 修复后的当前工作树复核：

- 公共运行时库测试：`166/166` 通过；根目录模块与组合测试：`44/44` 通过。
- 世界叙事统筹模块定向测试：`12/12` 通过；Web 测试：`6/6` 通过；转卡校验器 Python 测试：`13/13` 通过。
- 已覆盖四种团队人数形态、成员配置预检与冻结、精确资料边界、半轮恢复、不可变协调批次、助理重试与取消、低并发调度、事件日志恢复、跨回合冻结查询、短锁原子提交、逐成员模型重试和增量用量统计。
- `git diff --check` 通过。

未启动真实付费模型，也未修改 `play/`、现有卡或 session。真实模型会议的内容质量、provider 差异及重新转卡后的完整交互仍属于后续端到端验收。

2026-09-14 完成 F01—F08 修复后的当前工作树复核：

- 根目录全局模块与组合回归：`39/39` 通过；公共运行时、Web 与 ComfyUI 适配回归：`123/123` 通过，合计 `162/162`。
- Python 提取、转卡契约、卡包校验和清单测试：`19/19` 通过；叙事记忆 Module v6 包结构校验通过。
- 41 个实际顶层/模块工作流定义均可由 Workflow v3 运行时规范化。
- 121 个 MJS 文件、Web `public/app.js` 语法检查及 `pi-rp-web.ts` Pi 离线扩展加载通过。
- 故事规范生成副本 `--check` 通过；发布清单工作区检查通过，覆盖 5 个模块、145 个声明引用路径和 224 个模块文件。
- 本地开发记录中的 `PROJECT-REVIEW-RECHECK-PROBES-2026-09-14.mjs` 跨层断言通过：revision conflict 无 POST 且父子流程失败、活动操作冲突判定、冻结 profile 重放、502 原任务恢复、跨回合输入冻结及暂存区损坏 Schema 检出均符合方案。
- `git diff --check` 通过。

未执行真实 provider/API、真实 ComfyUI 队列或重新转换卡的完整 RP 回合测试。

## 已知边界

1. **仍没有端到端样板卡验证，但已有真实资产自校验。** 校验器现在会用随项目发布的真实模块与工作流拼装夹具卡跑通（不过**不安装运行时、不调用模型、不执行工作流**）。首次重新转卡时仍应把实际导入、节点上下文、模型输出、事务和 Web 操作作为集成验收。
2. **没有旧卡自动迁移。** 项目尚未发布，本轮直接升级根协议和模板。既有卡、安装运行时与 session 不会自动兼容或同步。
3. **没有真实 ComfyUI 生成验证。** 连接、队列、history、图片代理与 profile 逻辑使用测试替身验证；真实工作流仍需按用户设备适配。
4. **本机 PATH 中的 `python` 是 Windows Store 占位程序。** 应使用 `.cache/codex-runtimes/...` 下的解释器并加 `-X utf8`；其他机器应改用可用的 Python 3 路径。
5. **受限 sandbox 下部分验证命令无法运行。** `node --test` 会因子进程管道被拒（`spawn EPERM`）而失败——须改为逐个直接运行测试文件；但**测试体自身**开子进程的用例即使直接运行也会失败：`adapt-comfyui-workflow/scripts/workflow-tools.test.mjs` 全部 2 条、`rp-team-runtime.test.mjs` 的 `Secretary side failures…` 1 条（`actual: null` 而非预期退出码）。沙箱还**拒绝在被接管的临时目录内部创建目录**：`tempfile.TemporaryDirectory()` 能建出顶层目录，但其下任何 `mkdir` 都是 `WinError 5`，因此 `test_validate_card_pack.py`（14 个用例）与 `test_inventory_card.py` 默认整份失败，**且失败原因与断言无关**——不要据此判断被测代码。校验器单元测试可用 `local-development-records/run-validator-unit-tests.py` 在本地跑通（把 `TemporaryDirectory` 替换为工作区实现，用例本身不动），批次 3 结果为 `14/14 OK`。`check_release_manifest.mjs` 因内部调用 `git check-ignore` 同样受限；`pi` 离线扩展加载会因在 `~/.pi/` 建锁文件失败（`EPERM`）。扩展的语法检查可用 Pi 自带的 esbuild 直接转译代替（见「常用验证命令」，**必须直接调用平台二进制**，其 `bin` 包装脚本用管道子进程，会被沙箱拒绝）。以上都需在非受限 shell 中重跑才算完整验证。
6. **Skill 快速校验依赖 PyYAML。** 本轮依赖安装在仓库外的临时目录，没有写入项目。
7. **不要用 PowerShell 文本管道处理本仓库的 UTF-8 文件。** 本机的 Windows PowerShell 会按 ANSI（CP936）读取，前导字节会吞掉后续 ASCII 字符（含换行），造成**不可逆**损毁——本轮已因此重建过一份清单文档。文件读写一律走文件工具。

## 接手规则

- 先执行 `git status --short` 并检查当前差异；已有修改属于用户工作，不要回退或覆盖。
- 不要把根目录升级复制到 `play/`，除非用户明确指定源、目标、传播方向和迁移范围。
- 对全局模块的修改不自动更新已经导入的卡；对卡片的修改也不回灌根源。
- 修改协议、运行时、模块契约或工作流时，重新运行对应单元测试、卡包/模块校验、扩展加载与差异检查。
- 若发现公共能力不足，先比较模块内实现与顶层升级，向用户说明简化收益、兼容与风险；获得确认后才能登记或修改公共台账。

## 常用验证命令

```powershell
# 真实模板自校验（用真实资产拼夹具卡 + 独立源码树夹具跑校验器，覆盖各条目的正负例）
$pythonExe = 'C:\Users\bayue\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $pythonExe -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_real_asset_validation.py

# 受限 sandbox 下 node --test 会因 spawn EPERM 失败，改为逐个直接运行测试文件
$runtimeTests = Get-ChildItem .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
foreach ($file in $runtimeTests) { node $file }

$moduleTests = Get-ChildItem global-modules -Recurse -File -Include '*.test.mjs' | Select-Object -ExpandProperty FullName
foreach ($file in $moduleTests) { node $file }

# Web 测试同样不能用 npm test（它内部走 node --test 的管道子进程）
foreach ($file in (Get-ChildItem .agents/skills/st-card-to-pi-rp/assets/pi-rp-web/test -Filter '*.test.mjs').FullName) { node $file }

# 以下两条在受限环境下即使直接运行也会失败（测试体自身开子进程），见已知边界 5
node .agents/skills/adapt-comfyui-workflow/scripts/workflow-tools.test.mjs
node .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-team-runtime.test.mjs

node .agents/skills/create-pi-rp-feature-module/scripts/sync_story_mechanics.mjs --check
node .agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs   # 受限环境不可用，见已知边界 5

& $pythonExe -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_skill_contract.py
& $pythonExe -X utf8 global-modules/narrative-memory/scripts/validate-module.py
# 校验器单元测试：受限环境用本地 runner（把 TemporaryDirectory 换成工作区实现），非受限环境直接跑原文件
& $pythonExe -X utf8 local-development-records/run-validator-unit-tests.py
& $pythonExe -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_validate_card_pack.py
# test_inventory_card.py 在受限环境下无法建临时目录，见已知边界 5

node --check .agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/app.js
# 扩展语法（受限环境下 pi --offline 不可用，改用 Pi 自带 esbuild 直接转译）
& "$env:APPDATA\npm\node_modules\@earendil-works\pi-coding-agent\node_modules\@esbuild\win32-x64\esbuild.exe" `
  .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts --loader:.ts=ts --outfile=.tmp-ext-check.mjs --format=esm
git diff --check
```

## 当前待办

**已实施**：批次 1 全部；批次 2 的 FIX-003 / 004 / 011；批次 3 的 FIX-006b / 007；FIX-015（批次 1 引入的校验器回归）。

**待实施**（顺序见缺陷清单的「实施顺序约束」）：

- **批次 4**（最后一批代码修复）：FIX-008（失败批次被当作幂等重放）+ FIX-009 + FIX-010。FIX-004 的一条已知不精确（派发后的数据提交失败仍归入模型失败）按定稿留给 FIX-008 处理，两处不要并行改。
- **提示词清单**：A 组 7 条措辞改动 + C 组 1 条正向授权，全部已定稿可实施；其中 P-005 与刚搬迁的 `prepare-recent-narrative-stories.mjs` 同文件。
- 两份清单各自的「后续待定稿」与「待取证」条目；其中来自并行代理而未经逐行复核的，升级前必须先复核。

**尚未开始**：`.pi/APPEND_SYSTEM.md` 的内容已决定**全部舍弃**（该文件要么移除，要么只保留所有 Agent 都需要的总体概述），相关改动不在本轮范围内。

