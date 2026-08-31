# SillyTavern Card to Pi RP

一套面向 Pi Agent 的 SillyTavern 角色卡转换 skill。它将角色卡中的设定、世界书、开场白、规则、变量与可转换的 EJS 行为整理为可运行的 Pi RP 卡包，同时尽量通过拆分、归类和重组保留原作者的文字与风格。

本仓库只发布可复用的转换工具，不提交任何角色卡原文件、卡图、转换产物、聊天记录或个人设置。上述本地运行数据统一放在被 Git 忽略的 `play/` 中。

## 仓库内容

```text
.agents/skills/st-card-to-pi-rp/
├── SKILL.md                         # 转换工作流与确认流程
├── references/                      # 卡结构、模块、变量、EJS、Web 等规范
├── scripts/                         # 卡片提取和卡包校验脚本
└── assets/
    ├── pi-rp-runtime/               # 转换后项目使用的 Pi 运行时模板
    └── pi-rp-web/                   # 每张卡独立复制的 Web UI 模板
```

Pi 会自动发现项目中的 `.agents/skills/`。因此 clone 后不需要手动安装此 skill。

本地工作区采用转换与游玩分层：

```text
bobo-agent-rp/
├── .agents/                         # 转换 skill 与模板；仅在转换时使用
├── global-modules/                  # 可选的项目级模块源
├── my-cards/                        # 本地待转换素材（Git 忽略）
├── play/                            # 独立游玩根目录（Git 忽略）
│   ├── .pi/                         # RP 运行时、扩展与游玩 skills
│   ├── cards/<card-id>/             # 转换后的卡包
│   ├── sessions/<card-id>/          # 聊天与模块状态
│   ├── agents/                      # 全局 Agent 基础配置
│   ├── workflows/                   # 可复制到卡片的全局工作流模板
│   ├── settings/                    # 用户资料、头像、模型/API 与运行策略
│   └── runtime.json                 # 本地运行时布局标记
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

建议将本地输入卡放在仓库外，或放入已被 Git 忽略的 `my-cards/`。转换结果固定放在同样被忽略的 `play/cards/`，避免误提交他人的作品。

如果项目根目录存在 `global-modules/<module-id>/module.json`，转换时会主动列出可用的全局模块并询问本次需要引入哪些。

转换完成后不要直接在仓库根目录游玩。先按 [PI-PLAY-CONTEXT-ISOLATION.md](PI-PLAY-CONTEXT-ISOLATION.md) 完成一次项目级隔离，再从 `play/` 启动新的 Pi 会话。

## 转换原则

- 尽量保留角色卡原文和作者风格，优先拆分、梳理、移动和重组，不随意改写或扩写。
- 不复刻 SillyTavern 的激活颜色、插入深度、递归、黏性、冷却等提示词组装机制。
- 变量转换为 Pi RP 原生完整快照模块，不保留旧 MVU 输出协议。
- 不执行来源 EJS；分析其读取、分支、输出和副作用后，转换为原生上下文处理器、模块 hook、更新流程、Agent 检索规则或 Web 显示。
- 原卡卡图会保留为 Web 角色封面和聊天中的角色头像；原卡要求在正文之外生成的“与此同时”、状态栏、心理、评论等内容会转换为独立功能区模块，而不是继续混入正文。
- 所有按需内容必须从固定知识地图中可发现，并保留完整来源映射和转换报告。

## 工作流与多 Agent

Web UI 提供 API/模型、Agent 和工作流页面。模型配置以 ID 保存，可设置上下文/输出限制、思考强度、并发量及可选的首尾提示词；Agent 配置独立保存，卡片可建立覆盖层；工作流节点只引用这些 ID。

前台工作流负责本轮唯一正文，当前回合后台工作流用于变量和功能区更新，全局后台工作流在当前聊天的独立目录运行并只发布完成的结构化结果。节点按依赖逐个或并行调度，不会一次性把整套工作流提示词塞给模型。默认最多并发 10 个节点，并为前台保留一个位置；模型连续失败后默认等待用户选择模型重试，只有用户显式开启时才使用记录可见的静默兜底模型。

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
