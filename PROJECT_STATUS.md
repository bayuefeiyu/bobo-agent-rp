# PROJECT STATUS

更新时间：2026-09-01  
分支：`main`  
当前基线提交：`099bba3 Add configurable agent workflow runtime`

## 当前目标

把 SillyTavern 角色卡转换为可持续运行的 Pi Agent RP 卡包：尽量保留原作者设定、原文和风格，同时用代码化记录、按需上下文、功能模块、变量快照、工作流和多 Agent/多模型协作，替代 SillyTavern 单次生成和提示词激活机制。

当前开发重点已经从基础卡转换进入运行时完善阶段。本阶段集中完成了：共享提示词瘦身、敏感模型凭据迁移、固定变量检查器、功能模块文档跳转、节点级和工作流级 Token 统计，以及用户专用的节点过程记录。

## 当前仓库状态

- Git 工作区尚未提交：相对 `099bba3` 有 32 个已修改文件、3 个新增文件；新增文件是 `rp-token-usage.mjs`、其测试和本交接文档。
- 仓库只跟踪 `.agents/` 下的转换 skill、运行时模板、Web 模板、规范和脚本。`play/`、待转换素材、转换卡、聊天、设置和凭据均被忽略。
- 当前模板运行时与本地 `play/.pi` 的工作流、Token 统计和 Web 扩展核心文件哈希一致。
- `seraphina` 与 `daqi-weiguang` 两份本地卡的 `index.html`、`app.js`、`styles.css` 与通用 Web 模板一致。这些本地卡仅用于开发验证，不应提交。

## 已完成内容

### 转换 skill 与卡包约束

- 转换前先分析并给出简要方案；用户确认后才正式生成。方案会主动列出全局模块、推荐全局工作流，并允许逐项讨论。
- 以拆分、归类、移动和重组为主，尽量保留角色卡原文；不复刻 ST 的绿灯、深度、递归、黏性、冷却等激活参数。
- 世界观分为固定基础锚点和可发现的按需资料；固定知识地图必须能指向所有按需内容。
- EJS 仅作为源行为描述，不执行源代码；确定性分支转原生处理器，语义判断转 Agent/skill，持久变化转模块工作流，显示逻辑转 Web view。
- 变量采用原生完整快照，不兼容旧 MVU 输出协议。含持久变量的卡默认创建完整变量检查器；用户明确取消时只隐藏前端，不移除变量存储和更新。
- 原卡状态栏、HUD 或其他正文外输出必须是独立功能模块，不能替代完整变量检查器，也不能继续混入正文。

### 记录、变量与功能模块

- 聊天按卡 ID、Pi session ID 分层保存；开场白为首条公共记录，后续用户/AI 消息按回合绑定。
- 修改历史消息只修改该条文本，不重算后续数据；删除历史消息会截断该条及之后的消息，并级联删除绑定的模块/变量/工作流记录。
- 功能模块使用 v3 定义、v2 存储协议和统一记录 envelope；模块自己的 skill 持有其全部提示词。
- 前端模块和后台模块只在显示层不同；Agent 上下文按作者定义的 `contextOrder` 排列，不能被前端显示顺序改变。
- 变量更新在正文保存后执行，收到完整有效状态，可多次调用更新工具；代码按操作校验，失败项交回 Agent 修正，成功后保存绑定 AI 消息的完整快照。
- 正文外输出使用 `post-narrative-output` 后台任务，先于变量更新完成并绑定同一条 AI 消息。
- 功能区支持通用 JSON 递归键值展示；每个可见模块提供“修改数据”和“修改模块”，由服务端打开对应本地文件，浏览器本身不编辑文件。

### 上下文、工作流与多 Agent/多模型

- 每轮模型上下文由固定卡片/玩家内容、代码选取记录、按需查询结果和当前节点要求重新组装，不依赖旧 Pi 工作日志维持剧情。
- `APPEND_SYSTEM.md` 只保留共享工作目录、公共工具和公共 skill 说明；角色行为、创作规则、上下文排列和模块规则归各自 Agent、工作流、卡或模块所有。
- 模型、Agent、工作流节点配置相互独立。模型解析优先级为：节点模型 → 工作流默认模型 → Agent 默认模型 → `pi:current`。
- 支持 `foreground`、`turn-background`、`global-background` 三类工作流；支持 DAG 依赖、并行根节点、条件分支、join、冷却、多实例、重试、用户选模型和显式静默兜底开关。
- 前台工作流只产生一份正文；回合数字在下一条用户消息被接受时才推进。当前回合后台可阻塞下一轮，全局后台使用私有目录并只发布完成的结构化长期结果。
- 每个成功节点在 `workflow/process-records/<run-id>/<node-id>.md` 保存最后一次 Agent 收发内容；确定性节点保存“未调用 Agent”说明。运行状态只保留可用性和相对路径，文档不进入 Agent 上下文、上游产物或长期发布；重试成功后覆盖为最后一次成功记录。
- API Key 已从项目文件迁移到操作系统缓存目录下按 `play/` 绝对路径隔离的秘密文件；项目中的模型配置只保存非敏感字段，Web API 不回传 Key。

### Web UI

- 页面包括正文、角色卡、用户设置、系统设置、API/模型、Agent、工作流和 Token 统计。
- 正文使用安全 Markdown DOM 渲染、连续阅读布局、角色卡封面作为 AI 头像、昵称独立用户头像。
- 支持选择开场白/已有聊天、删除非活动聊天、消息修改与后缀删除、角色卡切换和聊天重选。
- 系统设置可调整字号，并仅在前端隐藏/排序功能模块。
- API 页面支持常见/OpenAI 兼容模型配置、模型列表加载、手动模型名和极简 `hello` 测试；Agent 页面支持卡片覆盖、全局覆盖和恢复默认；工作流页面支持激活、查看节点、修改绑定、查看运行状态、重试、取消，以及按实例和节点打开过程记录。
- Token 页面显示当前聊天的输入、输出、缓存读写和总 Token；逐成功节点显示用量；完成的工作流显示本次所有已记录 attempt 的总用量。
- 工作流实例卡在完成后直接显示本次总 Token。重试中可取得的失败 attempt 用量也会计入；覆盖不完整时明确标记为“部分尝试未记录”。

## 关键技术决策

1. **浏览器只做展示和配置。** 浏览器不直接调用模型、不组装提示词、不调度工作流；Pi 扩展是唯一运行时和调度器。
2. **每张卡复制 Web 模板。** 允许卡片以后个性化前端，同时共享模板仍是新转换的来源。
3. **本地记录是 RP 权威数据。** Pi 原生日志是操作记录；聊天、模块快照、工作流 run 和上下文 receipt 由运行时文件重建。
4. **代码负责精确提取，Agent 负责语义选择。** 检索模式分为默认/自定义代码与 Agent append/override，Agent 失败时保留代码兜底。
5. **模块提示词归模块所有。** 工作流节点只保留路由、依赖和简短任务要求，避免规则重复和上下文漂移。
6. **变量历史保存完整快照。** 删除消息时可恢复最后一个仍有效版本；合法的前端手动修改未来直接修改最新有效版本，不另建审计记录。
7. **模型凭据与项目分离。** 共享项目或卡包不应携带 API Key；旧项目内 Key 自动迁移并清除。
8. **Token 以 attempt 为计费边界。** 节点保存成功 attempt 的标准化 `usage`；隔离 Agent 的失败 attempt 在能够取得用量时也保存。工作流终态汇总所有已记录 attempt，并保存覆盖完整性。

## 修改过的核心文件

### 转换入口与规范

- `.agents/skills/st-card-to-pi-rp/SKILL.md`：转换提案/确认流程、全局模块和工作流选择、默认变量检查器。
- `.agents/skills/st-card-to-pi-rp/references/feature-modules.md`：模块 v3、surface 与上下文顺序。
- `.agents/skills/st-card-to-pi-rp/references/variables.md`：完整快照变量和固定检查器。
- `.agents/skills/st-card-to-pi-rp/references/workflow-system.md`：模型/Agent/节点分层、工作流类型、重试、工作区和 Token 记录。
- `.agents/skills/st-card-to-pi-rp/references/web-runtime.md`：Web/扩展职责、页面和接口契约。
- `.agents/skills/st-card-to-pi-rp/references/validation.md`、`scripts/validate_card_pack.py`：卡包和变量检查器校验。

### Pi 运行时模板

- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts`：Web bridge、上下文重建、聊天切换、模块/变量任务、工作流调度、模型会话、Token 采集和节点过程记录。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs`：工作流状态机、attempt、节点和 run 级 Token 汇总。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-token-usage.mjs`：标准化和合并 Pi usage。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-store.mjs`：模型/Agent/工作流配置和系统缓存凭据。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/APPEND_SYSTEM.md`：精简后的共享环境协议。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/skills/play-pi-rp*/`：游玩/网页启动流程和任务边界。

### Web 模板

- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/index.html`：页面和 Token 统计结构。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/app.js`：聊天、设置、工作流和 Token 页面逻辑。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/styles.css`：响应式布局、功能区和统计卡片样式。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/server.mjs`：纯展示/配置 HTTP 接口，以及打开模块文档和节点过程记录的受限端点。

## 测试与验证结果

本交接前重新核对：

- 运行时模板全部单元测试：`41/41` 通过。
  - 命令：`node --test <pi-rp-runtime/.pi/lib 下全部 *.test.mjs>`
  - 覆盖配置密钥迁移、上下文处理器、记录检索、变量、输出模块、工作流引擎、工作区、节点过程记录和 Token 汇总。
- 通用 Web 模板：`6/6` 通过。
  - 命令：`npm test --prefix .agents/skills/st-card-to-pi-rp/assets/pi-rp-web`
- 本地 `seraphina` Web 副本：`6/6` 通过。
- 本地 `daqi-weiguang` Web 副本：`6/6` 通过。
- 两张本地卡包均通过 `validate_card_pack.py`，各 `0 warning`。
- 通用模板与当前 `play/` 运行时、两份卡片 Web 核心文件哈希一致。
- `node --check` 已通过通用模板和两份卡的 `public/app.js`。
- `git diff --check` 通过；Git 仅输出本机 `safe.directory` 配置格式警告。
- 当前 PowerShell PATH 没有 `python` 命令；卡包校验使用 Codex 自带 Python 运行时完成。

尚未执行真实模型/API 的端到端工作流测试，因此单元测试不能替代实际 Pi 会话验证。

## 已知问题

1. **工作区未提交。** 当前 28 个修改文件和 3 个新增文件都需要在下一阶段复核后提交、推送。
2. **两处规范仍保留旧的模块排序说法。** `references/validation.md` 仍写有“后台模块在前台模块之后”，`create-pi-rp-feature-module/references/module-schema.md` 仍写有“Frontend modules precede background modules in context”。这与当前决定和运行代码（所有模块统一按 `contextOrder`）冲突，应先修正。
3. **Token 历史不可补算。** 升级前已完成节点/工作流没有 usage，只能显示“未记录”。
4. **Token 覆盖可能不完整。** 隔离 Agent 能在结构化输出解析失败时附带已经产生的 usage；当前主叙事 Pi 会话若在保存正文前异常结束，运行时未必能取得该失败 attempt 的 usage。此时工作流会保留 `usageComplete: false`，UI 显示已记录部分。
5. **缺少真实 Pi 端到端回归。** 尚未用实际 provider 验证节点成功、工具调用、重试、后台更新和工作流完成后的 UI Token 数值是否与 provider/Pi 显示一致。
6. **模板复制需要显式同步。** 新卡从 `.agents/.../assets` 获取最新版本；已经转换的卡不会自动升级。本地两张开发卡当前已同步，但未来模板变更仍需升级既有卡。

## 尝试过但失败或已放弃的方案

- **在普通工具/事件上下文直接调用 `newSession()`。** 曾触发 `TypeError: switchContext.newSession is not a function`。当前方案是通过 `pi.sendUserMessage()` 调用注册的 `/rp-web-reset <card-id>` 命令，由拥有合法命令上下文的处理器创建新 session；不要恢复旧做法。
- **让 Web 成为独立模型客户端。** 这会导致重复 API 配置和两个运行时真相源，已放弃。Web 只把输入交给当前 Pi 会话并读取本地状态。
- **依赖完整旧 Pi 工作上下文续写。** 工具调用、资料查阅和被修改/删除的历史会污染下一轮，已改为每个节点按固定/继承/自定义模式重建上下文。
- **在共享系统提示词中解释代码已经保证的内部行为。** 会浪费每轮 Token，也把卡片/Agent 特有规则错误提升为全局规则。已把 `APPEND_SYSTEM.md` 缩减为工作区和公共能力说明。
- **把 API Key 保存在 `play/settings/model-profiles.json`。** 分享项目时存在误提交风险，已由系统缓存秘密文件替代，并保留自动迁移。
- **把变量检查器与作者状态栏合并。** 会丢失完整调试视图或改变作者设计，已确定为两个独立模块。

## 下一步开发顺序

当前没有能够确认的“用户已经明确提出、但尚未实现”的开发项。下一步等待用户指定新的开发需求。

“已知问题”中的规范冲突、验证缺口和未提交状态仅用于交接，不自动构成下一步开发授权或开发顺序。

## 常用验证命令

```powershell
$tests = Get-ChildItem .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $tests
npm test --prefix .agents/skills/st-card-to-pi-rp/assets/pi-rp-web
python .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
git diff --check
```

若当前环境没有 `python` 命令，先定位可用 Python 解释器，再以该解释器运行同一个校验脚本；不要因此跳过卡包校验。
