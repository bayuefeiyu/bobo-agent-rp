# PROJECT STATUS

**当前快照，日期 2026-10-09。** 本文件只描述**当前**能力、限制、验证结果和接手规则。
长篇实施历史（逐批次修复清单、历史验证计数与实机取证记录）已移到
[DEVELOPMENT-HISTORY.md](DEVELOPMENT-HISTORY.md)；那里的版本号与计数属于该条目当时的状态。

## 文档导航

- [README.md](README.md)：项目定位、结构、当前使用入口与验证入口。
- [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)：从干净检出执行的开发与验证指南。
- [DEVELOPMENT-HISTORY.md](DEVELOPMENT-HISTORY.md)：历史实施记录，**不作为当前规范**。
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)：本机与受限环境下的故障排查。
- [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)：根源、安装运行时、卡片与 session 的独立修改边界。
- [PI-PLAY-CONTEXT-ISOLATION.md](PI-PLAY-CONTEXT-ISOLATION.md)：从 `play/` 启动游玩前的一次性隔离设置。
- [PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md](PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md)：公共基础设施升级台账，没有未经用户确认的候选项。
- [.agents/skills/st-card-to-pi-rp/references/architecture-implementation-plan.md](.agents/skills/st-card-to-pi-rp/references/architecture-implementation-plan.md)：本轮工程架构优化的实施方案与实施状态表。

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

- 模块协议版本为 Module v7，区分 data/resource/hybrid；数据部分继续使用 Data Contract v1、Record Envelope v2、Change Batch v1，工作流使用 Workflow v4（`schemaVersion: 4`）。权威规范位于 `.agents/skills/design-pi-rp-data/references/protocol.md`。
- Module v7 的 manifest 显式登记 `agentFiles` 与 `workflowFiles`，每个工作流都声明 `ownerModuleId`；`promptFile`/`entryFile` 是模块相对路径，运行时引用统一为 `module-id/local-id`，配置方案使用精确的模块归属键。
- 一个模块可以拥有多个 collection 和 record type。索引、目录及创作文档属于可重建派生数据；Agent 只通过命名 view 和节点授权读取数据。
- 持久修改统一通过带幂等 ID、`expectedRevision`、提交策略和事务回执的变更批次完成。公共运行时负责 envelope、历史、索引、provenance、回滚与恢复。
- Workflow v4 的节点类型为 `agent`、`team`、`code`、`call`、`gate`、`join`、`workflow-return`、`turn-finalize`；入口种类为 `foreground`、`turn-background`、`global-background`，可声明触发且不要求 `workflow-return`，可调用的 `module-external`/`module-internal` 无触发且恰有一个 `workflow-return`。使用 DAG 依赖、模块工作流调用边界、节点级 `moduleAccess`、声明式产物和节点结束提交。
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

- Module v7 data / Data Contract v1 包含会话偏好、分阶段持久化的生图请求、带状态 revision 的 render 记录及模块自有工作流清单。
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

架构优化实施后的复核问题已进入收尾：宿主入口、生命周期、节点执行和 Web 处理器分开；前端面板只依赖共享上下文；图像数据转换与业务规则归图像模块；配置统一由命名方案写入。完整改动与最终验证结果见 [架构优化收尾记录](.agents/skills/st-card-to-pi-rp/references/architecture-closeout.md)。历史阶段数字不作为当前验收依据。

当前统一入口为 `npm run verify:all` 与 `npm run typecheck`。后者覆盖全部宿主 TypeScript，错误会使命令失败。结构门槛只验证结构，实际行为由各套件和新卡离线运行夹具验证；不再依赖未发布的本机验收文档。每次运行的详细结果位于被忽略的 `.verify/results.json`。

2026-10-09 收尾验证：`verify:all` 发现并执行 95 个文件，解析到 579 个用例全部通过，无跳过或未执行；生成一致性、发布清单、Pi 转译及打包契约通过。`typecheck` 与 `git diff --check` 通过。环境为 Windows、Node 24.14.0、Pi 0.86.0、Anaconda Python 3.13.9；未使用沙箱豁免。

## 已知边界

1. 已有新卡打包、复制后宿主启动、实际 Web 操作、无模型工作流执行、持久化及恢复的离线夹具。Pi 接口使用替身，尚未验证真实模型 API 下的完整 RP 回合。
2. 项目未发布，本轮不添加旧卡、旧协议或旧会话兼容层；根项目变化不自动传播到 `play/`。
3. 图像模块有真实数据契约和模拟连接测试，尚未执行真实 ComfyUI 队列与 GPU 生成。
4. Python 命令不可见不代表未安装。必须同时检查系统 Python、Anaconda/Miniconda 及其环境；可用 `VERIFY_PYTHON` 指定已确认的解释器，另行确认 PyYAML。CUDA 不能替代解释器检查，详见 [故障排查第 1 节](TROUBLESHOOTING.md#1-python-命令无效或指向-windows-store-占位程序)。
5. 受限环境可能拒绝子进程、符号链接或临时目录操作。`--sandbox-skips` 只增加诊断，失败仍是失败；不能作为最终通过凭据。
6. 开发验证要求 Node 24，并先执行 `npm ci`。打包声明的最低运行时与开发基线分开，本轮未验证 Node 20 游玩。
7. 不要经 Windows PowerShell ANSI 文本管道往返写入 UTF-8 文件。

## 接手规则

- 先执行 `git status --short` 并检查当前差异；已有修改属于用户工作，不要回退或覆盖。
- 不要把根目录升级复制到 `play/`，除非用户明确指定源、目标、传播方向和迁移范围。
- 对全局模块的修改不自动更新已经导入的卡；对卡片的修改也不回灌根源。
- 修改协议、运行时、模块契约或工作流时，重新运行对应单元测试、卡包/模块校验、扩展加载与差异检查。
- 若发现公共能力不足，先比较模块内实现与顶层升级，向用户说明简化收益、兼容与风险；获得确认后才能登记或修改公共台账。

## 常用验证命令

```powershell
npm ci --no-audit --no-fund
npm run verify:all
npm run typecheck
npm run verify:list
npm run test:engine
npm run test:python
npm run check:generated
npm run check:release
git diff --check
```

首次执行先检查 Node、Pi、系统 Python 与 Conda 环境。完整参数及结果解释见 [开发与验证指南](DEVELOPER-GUIDE.md)。

## 当前待办

**已实施**：批次 1 全部；批次 2 的 FIX-003 / 004 / 011；批次 3 的 FIX-006b / 007；批次 4 的 FIX-008 / 009 / 010；FIX-015（批次 1 引入的校验器回归）；FIX-016（提交被卡声明拒绝时的归类）；FIX-017（②③ 提交失败的面板措辞）。**缺陷清单内的 17 条代码修复已全部落地。**

**提示词清单**：21 条**无待办**——A 组 7 条、B 组 P-104、C 组 1 条已实施；B 组其余三条与 D/E 组是"保留 / 明确不做"的决策记录；文末「待取证」是**尚未逐行读过的位置清单**，需要时才去读，不是待办队列。

**待实施**：

- 缺陷清单「后续待定稿」里的候选（团队写锁残留、协助任务路径冲突、`best-effort` 的 `partial`、`pruneWorkflowState` 层级、`readDataReadViewCollection`、团队预算校验时机、终态 finalizer 不可达、`awaiting-child` 无出口、配置面板初值、条件环永久 running 等）；**这些都来自并行代理报告、未逐行复核**，升级为 FIX 条目前必须先复核。
- 提示词清单的「待取证」位置（15 处），按需取证。

**尚未开始**：`.pi/APPEND_SYSTEM.md` 的内容已决定**全部舍弃**（该文件要么移除，要么只保留所有 Agent 都需要的总体概述），相关改动不在本轮范围内。
