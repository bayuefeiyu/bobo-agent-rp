# PROJECT STATUS

更新时间：2026-09-14

当前分支：`main`

当前 `HEAD`：`db24f38efbe4fd1e51f72efb9fd191b18b2f9cfe`（`feat: unify RP data runtime and development skills`）

当前未提交的叙事记忆、ComfyUI 和公共基础设施修改均基于该提交继续开发。

## 交接结论

当前已确认的正文 Agent、模块工作流调用、卡片静态资料库、叙事记忆、ComfyUI 剧情生图及其公共基础设施已有代码实现。再次验收发现的 F01—F08 已按用户逐项确认的方案完成修复并通过本轮自动验证，实施记录见 [修复实施方案](PROJECT-REVIEW-RECHECK-IMPLEMENTATION-PLAN.md)。当前工作树包含尚未提交的根目录源、测试与文档变更，接手者必须保留这些修改，不得通过 reset、checkout 或覆盖复制清理工作树。

现阶段的单元、结构、组合及故障负例复核均通过；真实模型、真实 ComfyUI 与重新转卡的端到端验证仍未执行。不要未经用户授权修改 `play/` 或执行真实付费模型/生图测试。

开始后续工作前依次阅读：

1. [README.md](README.md)：项目入口、使用方式与文档导航。
2. [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)：根源、安装运行时、卡片与 session 的独立修改边界。
3. [PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md](PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md)：公共能力的确认与实施台账。
4. 对应全局模块的 `IMPORT.md` 和模块 Skill。

## 工作区边界

- 本阶段只修改仓库根目录的 Skill、规范、全局模块源、运行时/Web 模板、测试和文档。
- `play/` 被 Git 忽略，本阶段没有读取、修改或同步其中的卡、共享运行时、设置与 session。根目录修改不会自动传播到那里。
- 根目录 `.pi/APPEND_SYSTEM.md` 是已经被 Git 跟踪的空文件，用于提供确定的开发项目提示入口。
- 全局模块复制进卡后即成为卡所有的副本；以后更新根源不会自动升级该卡。
- 用户如要求修改既有卡、安装运行时或 session，必须把该层作为单独目标明确授权。

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

- 四个数据域分别保存日常私有孵化与指导、深度导演报告、已确认归档交接和模块设置；创作工作流不能读取私有或深度资料。
- 前置导演在正文 Agent 完成分析与记忆检索后轻量调整；后置导演在正文落地后完成主要复盘并阻塞下一轮；深度导演按后置建议异步启动，只写深度域并可进行一至两次高预算记忆检索。
- 指导以稳定 ID 记录，由各频道发布清单选择，确定性组装器支持条目 Note，避免 Agent 重抄整份输出文档。
- 归档沿用叙事记忆的通用来源捕获；进入 `archive-outbox` 的内容必须已经确认需要归档并带知情范围，且不是每轮必写。
- 数据健康只统计和提醒；维护与完整性修复均为用户手动启动。首版没有模块前端。

导入和卡级接入要求见 [global-modules/world-narrative-coordinator/IMPORT.md](global-modules/world-narrative-coordinator/IMPORT.md)。

### 近场与广域叙事全局模块

源目录：[global-modules/local-scene-narrative/](global-modules/local-scene-narrative/) 与 [global-modules/world-scope-narrative/](global-modules/world-scope-narrative/)

- 近场叙事负责主线当前地点及周边的其他完整故事；广域叙事负责世界范围内通常更特别、更持久且值得传播的故事。两者均有自己独立的创作准则、文风与格式资料。
- 后置导演输出语义委托，运行时补充技术ID；两个候选分支可并行。候选只包含完整正文及模块、目录摘要、时间范围、地点、角色、重要或唯一实体等最小结构数据，不写事实。
- 后置工作流的第二次导演Agent调用等待全部候选，只审核硬冲突和明显逻辑硬伤；默认保留原稿，修改时必须提供完整替换稿。随后各模块无Agent发布工作流并行提交，发布成功即成为世界事实并进入通用来源捕获。
- 深度导演报告维护一个广域活跃题材和至少一个备用题材；题材耗尽不会单独唤醒深度导演。近场与广域创作均不得走到正文当前世界时间之后。
- 前端“一隅众生”和“万象潮生”默认随模块区域收起，玩家可自由阅读；正文按 `recentCompleteTurns` 获取摘要式目录和按需全文，更早故事走叙事记忆。

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

- `st-card-to-pi-rp` 在正式转换方案前先列出全局模块并等待选择；选择会改变内容承载方式的模块时，方案必须明确迁移、保留、来源适配和权限影响。
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

2026-09-14 完成 F01—F08 修复后的当前工作树复核：

- 根目录全局模块与组合回归：`39/39` 通过；公共运行时、Web 与 ComfyUI 适配回归：`123/123` 通过，合计 `162/162`。
- Python 提取、转卡契约、卡包校验和清单测试：`19/19` 通过；叙事记忆 Module v6 包结构校验通过。
- 41 个实际顶层/模块工作流定义均可由 Workflow v3 运行时规范化。
- 121 个 MJS 文件、Web `public/app.js` 语法检查及 `pi-rp-web.ts` Pi 离线扩展加载通过。
- 故事规范生成副本 `--check` 通过；发布清单工作区检查通过，覆盖 5 个模块、145 个声明引用路径和 224 个模块文件。
- `PROJECT-REVIEW-RECHECK-PROBES-2026-09-14.mjs` 跨层断言通过：revision conflict 无 POST 且父子流程失败、活动操作冲突判定、冻结 profile 重放、502 原任务恢复、跨回合输入冻结及暂存区损坏 Schema 检出均符合方案。
- `git diff --check` 通过。

未执行真实 provider/API、真实 ComfyUI 队列或重新转换卡的完整 RP 回合测试。

## 已知边界

1. **没有端到端样板卡验证。** 当前只能确认单元、结构、权限和模板链路；首次重新转卡时应把实际导入、节点上下文、模型输出、事务和 Web 操作作为集成验收。
2. **没有旧卡自动迁移。** 项目尚未发布，本轮直接升级根协议和模板。既有卡、安装运行时与 session 不会自动兼容或同步。
3. **没有真实 ComfyUI 生成验证。** 连接、队列、history、图片代理与 profile 逻辑使用测试替身验证；真实工作流仍需按用户设备适配。
4. **本机 PATH 中的 `python` 是 Windows Store 占位程序。** 本轮 Python 测试使用 Codex 随附解释器并加 `-X utf8`；其他机器应改用可用的 Python 3 路径。
5. **Skill 快速校验依赖 PyYAML。** 本轮依赖安装在仓库外的临时目录，没有写入项目。

## 接手规则

- 先执行 `git status --short` 并检查当前差异；已有修改属于用户工作，不要回退或覆盖。
- 不要把根目录升级复制到 `play/`，除非用户明确指定源、目标、传播方向和迁移范围。
- 对全局模块的修改不自动更新已经导入的卡；对卡片的修改也不回灌根源。
- 修改协议、运行时、模块契约或工作流时，重新运行对应单元测试、卡包/模块校验、扩展加载与差异检查。
- 若发现公共能力不足，先比较模块内实现与顶层升级，向用户说明简化收益、兼容与风险；获得确认后才能登记或修改公共台账。

## 常用验证命令

```powershell
$runtimeTests = Get-ChildItem .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $runtimeTests

$memoryTests = Get-ChildItem global-modules/narrative-memory/runtime/test -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $memoryTests

node --test .agents/skills/adapt-comfyui-workflow/scripts/workflow-tools.test.mjs
npm test --prefix .agents/skills/st-card-to-pi-rp/assets/pi-rp-web

node .agents/skills/create-pi-rp-feature-module/scripts/sync_story_mechanics.mjs --check
node .agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs

$pythonExe = 'C:\Users\bayue\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $pythonExe -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_validate_card_pack.py
& $pythonExe -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_skill_contract.py
& $pythonExe -X utf8 .agents/skills/audit-and-upgrade-pi-rp-card/scripts/test_inventory_card.py
& $pythonExe -X utf8 global-modules/narrative-memory/scripts/validate-module.py

node --check .agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/app.js
pi --offline --no-session --no-skills --no-extensions --extension .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts --print ""
git diff --check
```

## 当前待办

F01—F08 已完成实施和自动复核。之后仍需在用户设备上另行进行重新转卡、真实模型与真实 ComfyUI 的端到端验收；这些验证涉及 `play/` 与外部服务，不属于本轮已授权的根目录修复范围。
