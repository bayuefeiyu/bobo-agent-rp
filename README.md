# SillyTavern Card to Pi RP

一套面向 Pi Agent 的 SillyTavern 角色卡转换与 Pi RP 开发工具。它将角色卡中的设定、世界书、开场白、规则、变量与可转换的 EJS 行为整理为可运行的 Pi RP 卡包，同时提供统一数据设计、模块开发和既有卡定制能力。

本仓库只发布可复用的转换与开发工具，不提交任何角色卡原文件、卡图、转换产物、聊天记录或个人设置。上述本地运行数据统一放在被 Git 忽略的 `play/` 中。

## 仓库内容

```text
.agents/skills/
├── st-card-to-pi-rp/                # 转换工作流、规范、脚本和运行时/Web 模板
├── design-pi-rp-data/               # 统一数据、记录结构与运行逻辑设计
├── create-pi-rp-feature-module/     # 根目录发起的模块创建与定制
├── audit-and-upgrade-pi-rp-card/    # 显式调用的旧卡检查与升级设计
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

转换 skill 会先分析角色卡，给出固定上下文、按需资料、变量/功能模块、EJS 处理和开场白等简要方案，并等待确认；只有确认后才会正式生成卡包。

检查或升级一张既有卡时，明确调用 `audit-and-upgrade-pi-rp-card` 并指定 `play/cards/<card-id>/`。该 skill 不会自动触发；它会逐项讨论卡包语义、工作流、项目依赖、前端和新版原卡，允许跳过任一项，全部讨论结束并获得最终确认后才实施修改。

设计统一数据或开发功能模块时，也从仓库根目录使用 `design-pi-rp-data` 或 `create-pi-rp-feature-module`。即使目标是 `play/cards/<card-id>/` 中的既有卡，也不要从 `play/` 游玩环境发起开发。

建议将本地输入卡放在仓库外，或放入已被 Git 忽略的 `my-cards/`。转换结果固定放在同样被忽略的 `play/cards/`，避免误提交他人的作品。

如果项目根目录存在 `global-modules/<module-id>/module.json`，转换时会主动列出可用的全局模块并询问本次需要引入哪些。

转换完成后不要直接在仓库根目录游玩。先按 [PI-PLAY-CONTEXT-ISOLATION.md](PI-PLAY-CONTEXT-ISOLATION.md) 完成一次项目级隔离，再从 `play/` 启动新的 Pi 会话。

## 转换原则

- 尽量保留角色卡原文和作者风格，优先拆分、梳理、移动和重组，不随意改写或扩写。
- 不复刻 SillyTavern 的激活颜色、插入深度、递归、黏性、冷却等提示词组装机制。
- 变量与记忆、秘密、传闻等记录一样，转换为统一数据协议下的集合和记录类型，不保留旧 MVU 输出协议或专用变量存储引擎；可按需要提供维护视图和前端检查区。
- 不执行来源 EJS；分析其读取、分支、输出和副作用后，转换为原生上下文处理器、模块处理器、普通工作流节点、统一数据操作或 Web 显示。
- 原卡卡图会保留为 Web 角色封面和聊天中的角色头像；原卡要求在正文之外生成的“与此同时”、状态栏、心理、评论等内容会转换为独立功能区模块，而不是继续混入正文。
- 所有按需内容必须从固定知识地图中可发现，并保留完整来源映射和转换报告。

## 开发与卡片定制边界

完整规则见 [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)。核心原则是双向不传播：

- 开发根目录 Skill、协议、global module、运行时/Web 模板、测试或文档时，不同步修改 `play/`、已转换卡或 session。
- 定制一张已转换卡时，只修改用户明确指定的卡，不修改根目录 Skill、模板、global module、其他卡、共享运行时或 session。
- 卡片本地副本与根目录来源之间没有自动同步关系；来源、`basedOn` 或 provenance 只用于识别，不授予传播权限。
- 单卡定制不得在卡片提示词、Skill、workflow、数据、provenance 或报告中写入全局化候选、回灌建议或与当前 RP 无关的开发标记。
- 跨层同步或 session 迁移必须由用户明确指定方向、来源、目标和范围。

## 工作流与多 Agent

Web UI 提供 API/模型、Agent 和工作流页面。模型配置以 ID 保存，可设置上下文/输出限制、思考强度、并发量及可选的首尾提示词；Agent 配置独立保存，卡片可建立覆盖层；工作流节点只引用这些 ID。

API Key 不写入项目目录：运行时按 `play/` 绝对路径生成隔离标识，保存到操作系统缓存目录下的 `bobo-agent-rp/projects/<project-hash>/model-secrets.json`。分享或上传项目不会携带凭据；旧版 `model-profiles.json` 中的 Key 会在下次启动时自动迁移并从项目文件删除。

前台工作流负责本轮唯一正文；回合后台与全局后台工作流使用普通 Agent/代码节点处理模块数据或声明的中间产物。持久、可检索的结果统一提交到所属模块集合，临时结果按节点输出的作用域与保留期管理。节点按依赖逐个或并行调度，不会一次性把整套工作流提示词塞给模型。默认最多并发 10 个节点，并为前台保留一个位置；模型连续失败后默认等待用户选择模型重试，只有用户显式开启时才使用记录可见的静默兜底模型。

每个成功完成的工作流节点都会在当前聊天的 `workflow/process-records/` 下生成独立 Markdown 过程记录，保存该节点最后一次 Agent 接收和发送的内容；纯代码节点会明确标记未调用 Agent。工作流页面可按实例和节点直接用系统默认编辑器打开记录。它们仅供高级用户调试，不参与 Agent 上下文、节点继承、数据查询或工件传递。

## SillyTavern 开发参考

本项目开发过程中参考了 [StageDog/tavern_helper_template](https://github.com/StageDog/tavern_helper_template)，但不会将该项目复制或打包进本仓库。

如果转换涉及 SillyTavern 的 MVU 变量、EJS、酒馆助手脚本、世界书结构或前端界面，可以查阅该项目及其文档。它是独立项目，其内容和许可证以原仓库为准。

## 验证

运行 Pi RP 运行时单元测试：

```bash
node --test .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/*.test.mjs
```

运行 Web 模板测试：

```bash
npm test --prefix .agents/skills/st-card-to-pi-rp/assets/pi-rp-web
```

校验一个转换后的卡包：

```bash
python .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
```
