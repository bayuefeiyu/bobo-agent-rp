# SillyTavern Card to Pi RP

一套面向 Pi Agent 的 SillyTavern 角色卡转换与 Pi RP 开发工具。它将角色卡中的设定、世界书、开场白、规则、变量与可转换的 EJS 行为整理为可运行的 Pi RP 卡包，同时提供统一数据设计、模块开发和既有卡定制能力。

本仓库只发布可复用的转换与开发工具，不提交任何角色卡原文件、卡图、转换产物、聊天记录或个人设置。上述本地运行数据统一放在被 Git 忽略的 `play/` 中。

## 文档导航

- [PROJECT_STATUS.md](PROJECT_STATUS.md)：当前开发快照、已完成能力、验证结果、已知边界和接手注意事项。后续开发者应先读此文件。
- [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)：根目录源、安装运行时、卡片和 session 之间的修改授权边界。
- [PI-PLAY-CONTEXT-ISOLATION.md](PI-PLAY-CONTEXT-ISOLATION.md)：从 `play/` 启动游玩前的一次性隔离设置。
- [PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md](PI-RP-INFRASTRUCTURE-UPGRADE-BACKLOG.md)：已经由用户确认的公共基础设施升级及其实施记录；它不是未确认想法清单。
- `global-modules/<module-id>/IMPORT.md`：全局模块的导入、运行时依赖和卡级适配要求。

当前根目录提供五个可选全局模块源：`narrative-memory`、`world-narrative-coordinator`、`local-scene-narrative`、`world-scope-narrative` 与 `comfy-image-generation`。它们都只影响未来明确选择并导入它们的卡，不会同步更新 `play/` 中已有副本。

其中**两个叙事模块不是一个可独立挑选的平级选项**：`local-scene-narrative` 与 `world-scope-narrative` 只负责写候选，由 `world-narrative-coordinator` 决定何时写、给什么指导、审核并发布，并接 `narrative-memory` 归档；两者都在自己的 `dependencies.json` 里记录这一点。转换时如只选叙事模块而不选导演，转换流程必须给出两条路并说明各自的工作量与风险：**补选导演**，或**在该卡内自行编写解耦的编排**（现成模板是六节点的 `director-post-with-narratives`，解耦后失去世界逻辑把关、深度推演题材与跨模块硬冲突检查）。`comfy-image-generation`、`narrative-memory` 与导演模块本身可按需单独选择。

## 仓库内容

```text
.agents/skills/
├── st-card-to-pi-rp/                # 转换工作流、规范、脚本和运行时/Web 模板
├── design-pi-rp-data/               # 统一数据、记录结构与运行逻辑设计
├── create-pi-rp-feature-module/     # 根目录发起的模块创建与定制
├── adapt-comfyui-workflow/          # 将 ComfyUI API 工作流适配为生图配置
├── manage-pi-rp-config-ui/          # 无卡开发模式下管理全局命名配置方案
├── audit-and-upgrade-pi-rp-card/    # 显式调用的旧卡检查与升级设计
├── debug-pi-rp-play/                # 根目录分析游玩会话与工作流运行问题
└── codex-delegate-bounded-tasks/    # Codex 有界子任务委派策略
```

Pi 会自动发现项目中的 `.agents/skills/`。因此 clone 后不需要手动安装这些 skills。

本地工作区采用转换与游玩分层：

```text
bobo-agent-rp/
├── .pi/APPEND_SYSTEM.md             # 根目录启动 Pi 时加载的空项目系统提示
├── .agents/                         # 转换、数据设计、模块和卡片维护 Skill；仅开发时使用
├── global-modules/                  # 可选的项目级模块源
├── my-cards/                        # 本地待转换素材（Git 忽略）
├── play/                            # 独立游玩根目录（Git 忽略）
│   ├── .pi/                         # RP 运行时、扩展与游玩 skills
│   ├── cards/<card-id>/             # 转换后的卡包
│   ├── sessions/<card-id>/          # 聊天与模块状态
│   ├── agents/                      # 全局 Agent 基础配置
│   ├── workflows/                   # 可复制到卡片的全局工作流模板
│   ├── settings/                    # 用户资料、头像、非敏感模型配置与运行策略
│   └── runtime.json                 # 本地运行时布局标记
├── PI-RP-DEVELOPMENT-SCOPE.md       # 根目录、卡片、运行时与 session 修改边界
└── PI-PLAY-CONTEXT-ISOLATION.md     # 玩家需要手动完成的隔离步骤
```

## 使用

要求：

- Pi Coding Agent
- Node.js 20 或更高版本（使用 Web UI 时）
- Python 3（提取或校验卡包时）

克隆仓库后，在仓库根目录启动 Pi：

```bash
pi --approve
```

然后向 Pi 提出转换请求，例如：

```text
使用 st-card-to-pi-rp 分析并转换这张 SillyTavern 角色卡：<角色卡路径>
```

转换 skill 会先检查源资料并解决本次需要引入的全局模块，再给出“单一精简基础设定 + 卡片资料库”的明确划分、统一数据/功能模块、EJS 处理和开场白等简要方案并等待确认；只有用户或创作者确认该整体方案后才会正式生成卡包。基础设定主要保留来源支持的世界/前提总览与故事长期基调、原则、走向；详细世界观、完整人物资料、规则、创作指导、文风、格式和参考材料进入卡片自有的静态资料库。选择叙事记忆等会改变内容承载方式的大型模块时，方案还必须明确披露迁入模块、继续固定、继续由其他模块拥有及只保留提示锚点的内容。

检查或升级一张既有卡时，明确调用 `audit-and-upgrade-pi-rp-card` 并指定 `play/cards/<card-id>/`。该 skill 不会自动触发；它会逐项讨论卡包语义、工作流、项目依赖、前端和新版原卡，允许跳过任一项，全部讨论结束并获得最终确认后才实施修改。

游玩时发现异常，可在仓库根目录的开发 Pi 会话中使用 `debug-pi-rp-play`，指定卡与会话或描述现象。它会检查各工作流最近的运行及节点证据，按问题提供可组合的单卡修复、项目修复、继续调查或仅记录等方案；只执行用户选定的范围。暂缓问题可记入被 Git 忽略的 `local-development-records/docs/play-debug/`。根目录各 skill 在逐项讨论多个方案时使用问题编号和 `A/B/C` 选项，推荐方案尽量排在 `A`。

设计统一数据或开发功能模块时，也从仓库根目录使用 `design-pi-rp-data` 或 `create-pi-rp-feature-module`。即使目标是 `play/cards/<card-id>/` 中的既有卡，也不要从 `play/` 游玩环境发起开发。

建议将本地输入卡放在仓库外，或放入已被 Git 忽略的 `my-cards/`。转换结果固定放在同样被忽略的 `play/cards/`，避免误提交他人的作品。

如果项目根目录存在 `global-modules/<module-id>/module.json`，转换时会主动列出可用的全局模块并询问本次需要引入哪些。

仓库内置 `global-modules/narrative-memory/` 叙事记忆模块源，用于在长篇 RP 中按需检索实体、事件、关系、认知与知情范围，并通过独立的两级归档工作流持续维护记录。模块前端面向调试与设置，可分页查看全部记录和修订历史、提醒归档覆盖或正文修订问题、按用户选择的回合范围修复或补充记录、调整常用参数及手动启动受控维护工作流；提醒不会自动使记录失效或启动修复。该源包不会自动修改已经转换的卡。

仓库内置 `global-modules/world-narrative-coordinator/` 世界叙事统筹模块源。它以私有孵化、频道指导、深度推演、持久参考资料和已确认归档交接等职责，在世界逻辑基础上寻找有张力的发展；采用前置轻量调整、后置阻塞复盘和按需异步深度推演。深度推演可在原单 Agent 工作流与动态 Leader/秘书/专家/助理会议之间切换，团队版使用独立阶段额度、并行助理、一次定稿审查和短锁原子提交。模块依赖 `card-context-library` 的 `director-future` 类别与 `narrative-memory`，前端提供状态、参考资料、设置、统计提醒和手动维护入口，不会自动维护或修改既有卡与会话。

仓库内置 `global-modules/local-scene-narrative/` 近场叙事模块与 `global-modules/world-scope-narrative/` 广域叙事模块。前者以“一隅众生”为前端标题，创作主线当前地点及周边的视野外故事；后者以“万象潮生”为前端标题，创作遍及世界且通常值得传播的较长事件。两者每次只生成一篇只读候选，经后置导演统一检查硬冲突后再确定性发布；已发布故事进入普通来源捕获。正文按自身最近回合窗口取得摘要目录和按需全文，玩家则可在默认收起的模块前端阅读故事，并可自行承担风险直接打开权威 JSONL 分区进行高级 DIY。**这两个模块由导演驱动，不是一个可单独使用的完整功能**：模块本身不含“何时写、写什么指导、谁审核、如何发布归档”的判断，`dependencies.json` 记录了导演提供的这些职责以及解耦所需的工作量与风险；只选它们而不选导演时，转换流程必须让用户在“补选导演”和“在卡内自行解耦编排”之间明确选择。

仓库内置 `global-modules/comfy-image-generation/` 剧情生图模块源。它必须在转卡或显式导入时复制进卡片，不会自动修改已有卡。要接入自己的模型，在仓库根目录向 Pi 提出“使用 `adapt-comfyui-workflow` 适配这个 ComfyUI API 工作流”，确认分析结果后才会写入 profile 和对应模型指导。不要在 `play/` 游玩会话中做结构适配。

生图运行时只让 Agent 生成随画面变化的内容片段；固定质量、风格、LoRA 触发词和负面提示词由 profile 组装。图片始终保留在 ComfyUI 的 `output/bobo-agent-rp/<聊天目录>/`，项目只保存会话期内的提示词和 ComfyUI 输出引用，不复制、缓存或随聊天删除图片。

转换完成后不要直接在仓库根目录游玩。先按 [PI-PLAY-CONTEXT-ISOLATION.md](PI-PLAY-CONTEXT-ISOLATION.md) 完成一次项目级隔离，再从 `play/` 启动新的 Pi 会话。

## 转换原则

- 尽量保留角色卡原文和作者风格，优先拆分、梳理、移动和重组，不随意改写或扩写。
- 不复刻 SillyTavern 的激活颜色、插入深度、递归、黏性、冷却等提示词组装机制。
- 变量与记忆、秘密、传闻等记录一样，转换为统一数据协议下的集合和记录类型，不保留旧 MVU 输出协议或专用变量存储引擎；可按需要提供维护视图和前端检查区。
- 不执行来源 EJS；分析其读取、分支、输出和副作用后，转换为原生上下文处理器、模块处理器、普通工作流节点、统一数据操作或 Web 显示。
- 原卡卡图会保留为 Web 角色封面和聊天中的角色头像；原卡要求在正文之外生成的“与此同时”、状态栏、心理、评论等内容会转换为独立功能区模块，而不是继续混入正文。
- 所有静态创作资料必须登记在卡片资料库目录中，以不可再拆的 Markdown 文档为交付单元，并保留完整来源映射和转换报告。

## 开发与卡片定制边界

完整规则见 [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)。核心原则是双向不传播：

- 开发根目录 Skill、协议、global module、运行时/Web 模板、测试或文档时，不同步修改 `play/`、已转换卡或 session。
- 定制一张已转换卡时，只修改用户明确指定的卡，不修改根目录 Skill、模板、global module、其他卡、共享运行时或 session。
- 卡片本地副本与根目录来源之间没有自动同步关系；来源、`basedOn` 或 provenance 只用于识别，不授予传播权限。
- 单卡定制不得在卡片提示词、Skill、workflow、数据、provenance 或报告中写入全局化候选、回灌建议或与当前 RP 无关的开发标记。
- 跨层同步或 session 迁移必须由用户明确指定方向、来源、目标和范围。

## 工作流与多 Agent

Web UI 将模型、Agent 和工作流配置统一收进命名配置方案。模型配置以 ID 保存，可设置上下文/输出限制、思考强度、并发量及可选的首尾提示词；Agent 与工作流配置可建立覆盖层，工作流节点只引用这些 ID。独立工作流页面用于查看定义、节点和运行实例，并提供运行期操作，不再直接修改配置。

在仓库根目录运行 `node .agents/skills/manage-pi-rp-config-ui/scripts/start-config-ui.mjs` 会以“无卡、无聊天”的开发预览状态打开与 `play` 完全相同的 Web UI。正文区、角色卡页和模块栏可用于检查通用前端效果，但不会创建虚拟卡、会话或运行工作流；用户资料与正文字号等通用默认可以修改并保存在 `.pi-rp-local/`。游玩时共享 `settings/common.json` 作为全局回退，卡内 `settings.json.settings.common` 覆盖对应类别且优先级更高。从同一侧栏进入“配置方案”即可统一管理模型、Agent、工作流和模块参数，不再保留重复的独立编辑页。首次启动会从作者默认值建立并激活可编辑的“开发默认”方案，内置默认仍作为只读基线保留。Agent 和工作流都先选“通用”或所属模块，再选具体对象；“通用”只展示不属于模块的内容。工作流档案包含运行策略、触发方式和全部节点，并且只有 Agent 节点显示 Agent、模型、提示词和上下文选项。模块参数从 `settings-form` 初始值载入。全局开发模式与单卡游玩模式分别维护命名方案，支持新建、改名、复制、切换、删除和不含凭据的 JSON 导入导出；单卡方案只对当前卡生效。所有字段均带同排用途提示，模型 API Key 仍只保存在本机项目隔离缓存中。

API Key 不写入项目目录：运行时按 `play/` 绝对路径生成隔离标识，保存到操作系统缓存目录下的 `bobo-agent-rp/projects/<project-hash>/model-secrets.json`。分享或上传项目不会携带凭据；旧版 `model-profiles.json` 中的 Key 会在下次启动时自动迁移并从项目文件删除。

前台工作流通过普通 Agent 节点生成一个或多个候选正文，再由 `turn-finalize` 选择玩家可见输出；正文 Agent 与其他 Agent 没有特殊执行器。任意生产节点都可用 `workspaceHandoff.include` 把严格列出的文件或文件夹移交给后继 Agent、代码或调用节点；接收端默认在 `handoff/<上游节点>/` 下保留其原工作区相对路径，形成白名单镜像，`as` 仅用于有意改名。没有整目录扫描、通配符或排除清单，缺失、越界、符号链接、路径重叠和碰撞均失败。任意 Agent 节点还可显式启用通用文档工作区，把普通上游结果、镜像根和已经完成的显式交接编入 `WORKSPACE-DOCUMENTS.md`；运行时不会解析或重建上游知识地图，地图本身也必须被显式移交。未启用时仍以内联方式接收普通上游内容。`standard-rp` 会初始化文档工作区，静态导出卡片资料库，并按 `turnContext.recentCompleteTurns` 提供最近若干完整回合、当前输入和该索引；其他叙事模块复用同一回合窗口。`advanced-memory-rp` 固定准备完整有效事件时间线；正文 Agent 自己分析情景并生成简单资料目标的自然语言 Markdown，动态调用记忆检索、完成资料推理和初步规划，随后才选读详细世界观等资料，修正规划并创作正文。

模块只通过 Module v6 清单提供完整 `module-external`/`module-internal` 工作流。`data`、`resource`、`hybrid` 分别承载会话权威数据、静态作者资料或两者；资源模块不伪造数据集合。顶层节点以统一的调用并等待机制使用它们；父节点等待时释放调度槽。Agent 和代码节点都必须列出精确的 `workflowCalls`，可附加固定参数及参数值范围，Agent 还只能看到声明为 `agentCallable` 的入口。调用提示词中的使用时机完全由节点作者编写，运行时不会自行添加建议或风险话术。持久、可检索结果统一提交到所属模块集合；静态资料可通过 `document-set` 快照交付；其他临时结果按节点输出作用域与保留期管理。默认最多并发 10 个节点，并为前台保留一个位置。

公共运行时还提供与模块无关的结构化随机原语。任意 Agent 可由卡片在工具白名单中显式获得 `rp_roll`；任意代码节点可声明 `runtimeServices: ["random"]` 并调用 `services.random.roll()`。两种入口共用加密安全的整数随机源和按工作流实例、节点、逻辑 key 幂等的审计记录，因此节点重试不会悄然改变结果；随机记录不自动进入 Agent 上下文或成为模块权威数据。

需要影响分析、规划、正文或检查的功能模块，通过声明式工作流文件/目录输出提供材料，并可组合采用三种接入时机：正文前为当前任务准备资料、正文后基于本轮结果生成供后续回合使用的内容、以及归档到记忆或其他权威模块供以后检索。跨回合内容必须由后续工作流重新导出或准备；工作流唤醒和节点工作区本身不会隐式传递资料。

每个成功完成的工作流节点都会在当前聊天的 `workflow/process-records/` 下生成独立 Markdown 过程记录，保存该节点最后一次 Agent 接收和发送的内容；纯代码节点会明确标记未调用 Agent。工作流页面可按实例和节点直接用系统默认编辑器打开记录。它们仅供高级用户调试，不参与 Agent 上下文、节点继承、数据查询或工件传递。

## SillyTavern 开发参考

本项目开发过程中参考了 [StageDog/tavern_helper_template](https://github.com/StageDog/tavern_helper_template)，但不会将该项目复制或打包进本仓库。

如果转换涉及 SillyTavern 的 MVU 变量、EJS、酒馆助手脚本、世界书结构或前端界面，可以查阅该项目及其文档。它是独立项目，其内容和许可证以原仓库为准。

## 验证

本项目主要在 Windows/PowerShell 下开发。运行公共运行时、模块和 Web 回归测试：

```powershell
$runtimeTests = Get-ChildItem .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $runtimeTests

$memoryTests = Get-ChildItem global-modules/narrative-memory/runtime/test -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $memoryTests

$directorTests = Get-ChildItem global-modules/world-narrative-coordinator/runtime/test -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $directorTests

npm test --prefix .agents/skills/st-card-to-pi-rp/assets/pi-rp-web
```

运行 ComfyUI 适配与运行时测试：

```powershell
node --test .agents/skills/adapt-comfyui-workflow/scripts/workflow-tools.test.mjs
node --test .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui.test.mjs
```

校验全局记忆模块或一张转换后的卡包：

```powershell
python -X utf8 global-modules/narrative-memory/scripts/validate-module.py
python -X utf8 .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
```

校验故事规范生成副本和仓库发布完整性：

```powershell
node .agents/skills/create-pi-rp-feature-module/scripts/sync_story_mechanics.mjs --check
node .agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs
```

发布完整性检查默认核对当前工作区，允许尚未暂存但未被 Git 忽略的开发文件。准备发布时使用 `--staged` 核对暂存区，或使用 `--commit <ref>` 核对指定提交；这两种模式要求发布清单声明的模块文件全部位于对应 Git 文件集中。

当前工作树的完整验证结果与本机 Python 注意事项见 [PROJECT_STATUS.md](PROJECT_STATUS.md)。真实模型、真实 ComfyUI 服务和新转换卡的端到端验证不包含在上述单元测试中。
