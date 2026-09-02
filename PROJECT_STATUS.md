# PROJECT STATUS

更新时间：2026-09-02

分支：`main`

本次升级此前的基线提交：`c41975d1738e1253d04b73d95003575d5d28def5`（`feat: add workflow diagnostics and bounded delegation`）

## 当前目标

把 Pi RP 中原先彼此独立的变量、记忆、秘密、传闻、正文外输出等数据机制，升级为一套可供不同角色卡、功能模块和工作流共同使用的统一数据与文档协议。

协议需要同时支持：模块自定义数据结构、多集合和多记录类型、代码化索引与检索、面向 RP 的精简返回、显式变更文档、节点级权限、并发冲突检测、事务与恢复，以及工作流节点之间的私有/共享产物。项目尚未发布，因此本阶段直接替换旧机制，不提供旧协议兼容或既有测试卡迁移。

## 当前仓库状态

- 统一数据协议、运行时、转换与数据设计 skill、检查 skill、验证器、Web 和文档构成本次正式升级，并随本状态文件一同提交。
- `play/` 被 `.gitignore` 忽略，仅用作本地游玩运行目录；本阶段未读取、修改或同步其中内容，用户会手动清理整个目录并重新转卡。
- 根目录 `.pi/APPEND_SYSTEM.md` 已创建为空文件，且通过 `.gitignore` 例外规则保留为可提交文件；它当前仍属于未跟踪变更。
- `PROJECT_STATUS.md` 已被 Git 跟踪，本文件用于后续阶段接续，不应复制进 `play/`。

## 已完成内容

### 统一数据协议

- 新增根目录 `design-pi-rp-data` Skill；其 `references/protocol.md` 成为统一数据的唯一权威规范，确定 Module v4、Data Contract v1、Record Envelope v2、Change Batch v1 和 Workflow v2。
- 一个模块可以声明多个 collection，每个 collection 可以包含多个 record type；模块数据字段保持高度自由，公共 envelope 和变更批次字段严格校验。
- 索引为可选的派生数据。缺失索引值可为空，或使用作者声明的默认值；存在但类型错误的索引值会被拒绝。索引、目录和生成文档均可从权威记录重建。
- 每种供 RP 使用的记录类型必须声明自己的命名 view。查询结果仅返回 `id`、`recordType`、`revision` 和 view 渲染值，不把技术 envelope、索引或 provenance 自动暴露给 Agent。
- 支持结构化索引筛选、作者声明的内容检索字段、保守的默认查询预算、节点预算上限、截断标记和 continuation cursor。
- 稳定 ID 注册由模块作者或卡作者按记录类型选择；名称和别名解析也受当前节点查询权限约束。

### 数据运行时与一致性

- 新增 `rp-data-*` 运行时库，覆盖协议校验、记录 envelope、schema、索引、view、存储、查询、变更批次、事务、工作区产物和节点提交。
- Agent 可以显式提交变更批次；节点结束时也可以提交工作流明确指定的变更文档。运行时不会扫描目录猜测草稿文件。
- 支持 `atomic`、`grouped` 和受节点显式授权约束的 `best-effort`。批次和操作 ID 用作幂等键；对既有记录的所有修改都必须携带 `expectedRevision`。
- 同一 session 内提交串行执行；多文件事务失败会回滚已经替换的目标，事务 receipt 与数据变更处于同一提交边界。
- 技术 provenance 由运行时自动填写且默认不进入 Agent 上下文；Agent 只需按需填写自然语言 `note`。
- 模块可提供受信任的本地确定性 processor；processor 只返回模块数据、可选状态/备注和结果，revision、时间、历史、索引及 provenance 均由公共运行时管理。

### 工作流、节点权限与产物

- Workflow v2 只保留 `agent`、`code`、`narrative`、`gate`、`join`、`turn-finalize` 节点类型。
- 模块定义 capability，工作流节点通过 `moduleAccess` 获得 capability 子集；skill 只解释操作语义，不授予权限。同一模块在不同节点可分别只开放查询或开放新建、修改、归档等操作。
- Agent 声明的工具白名单与节点 capability 同时生效；隔离 Agent 会话已修正为只暴露节点允许的统一数据工具。
- 节点通过 `outputs` 注册精确命名的产物，并可使用 `node`、`workflow`、`turn`、`session`、`public` 作用域。节点结束提交发生在节点成功和下游节点释放之前。
- 校验器会检查并行写入冲突、越权 capability、未声明的提交目标、非法 `best-effort`、无效依赖和工作流类型约束。
- 原有 `module-updater`、`variable-updater` Agent，`module-update`、`variable-update` 工作流，以及 `rp-variables.mjs`、`rp-outputs.mjs` 专用实现已删除；统一由 `data-worker` 和数据协议处理。

### 上下文、工具与前端

- 上下文处理器升级为 v2，可声明统一 `dataQueries`；消息检索继续使用独立消息工具，派生消息目录完全由代码生成，不再通过 Agent 扩写。
- 扩展注册 `rp_data_query`、`rp_data_get`、`rp_data_resolve`、`rp_data_change`、`rp_data_submit` 和 `rp_message_query`，并在服务端统一执行权限、预算和会话边界检查。
- Web 状态返回统一 collection 数据，功能区提供只读“查看数据”入口；不再依赖变量专用或正文外输出专用协议。
- 用户设置已加入删除已保存用户功能：删除活动用户后选择剩余第一项，删除非活动用户不改变当前选择，最后一个用户禁止删除。
- 角色卡封面继续作为 Web 聊天中的 AI 头像；阅读式头像布局和安全 Markdown 渲染测试保持通过。

### 转换、模块创作与角色卡检查

- 转换 skill、目标卡包规范、EJS 转换、变量、功能模块、全局模块、Web、工作流和验证文档已改为统一协议，不再指导生成旧变量/MVU/正文外输出格式。
- 功能模块创建 skill 已从运行时模板迁到根目录，可设计 card-local 或用户明确要求的 project-global module；数据模型与运行逻辑统一由 `design-pi-rp-data` 指导。
- 运行时模板只保留 `play-pi-rp`、`play-pi-rp-web` 等游玩能力，不再打包模块开发 skill。
- 新增仅在用户明确要求时执行的 `audit-and-upgrade-pi-rp-card` skill。
- 检查流程依次与用户讨论：卡包语义、工作流、项目依赖、前端、原卡升级分析；每项均可跳过。全部讨论结束后先给出简要总结和方案，用户确认后才执行修改。
- 检查 skill 包含卡包清单脚本及提示词、工作流冲突、依赖升级、前端定制融合和原卡升级参考文档。

### 上下文隔离与本地运行

- 根目录空 `.pi/APPEND_SYSTEM.md` 用于从仓库根目录启动 Pi 时提供确定的项目系统提示入口，同时避免把游玩提示词放进开发上下文。
- `PI-PLAY-CONTEXT-ISOLATION.md` 说明转换时从仓库根目录启动、游玩时以下一层 `play/` 为根目录启动的手动隔离方式。
- 新增 `PI-RP-DEVELOPMENT-SCOPE.md`，规定根目录、安装运行时、单张卡和 session 之间双向不隐式传播；单卡定制不得向卡片文件写入全局化、回灌或模板开发标记。
- 所有开发从仓库根目录发起，即使目标是 `play/cards/<card-id>/`；`play/` 只用于游玩。本地 `play/` 本阶段不处理，后续由用户手动清理并重新转卡。

## 关键技术决策

1. **不兼容旧协议。** 项目未发布，旧变量、模块记录和正文外输出机制直接由统一协议替换，不编写固定迁移层。
2. **公共外壳严格，模块数据自由。** envelope、路由、版本、revision 和提交字段严格；模块内部 `data`、可选 schema、索引、view 和 processor 由作者设计。
3. **索引决定如何筛选，view 决定 Agent 看见什么。** 二者分离，避免为了代码处理而增加的字段污染 RP 上下文。
4. **权限由模块能力和节点授权共同决定。** 模块声明可提供的操作，工作流节点只授予当前任务所需子集，Agent 工具白名单再做一层收窄。
5. **访问控制是自由查询的兜底。** 常规工作流仍由作者决定哪些内容进入哪个 Agent 的上下文；运行时权限主要防止高自由度 Agent 自行查询导致信息泄露。
6. **变更文档必须显式指定。** 允许一轮产生多份、按先后顺序提交；Agent 可主动调用工具，节点结束也可兜底提交，但禁止目录自动扫描。
7. **现有记录修改必须乐观并发控制。** `expectedRevision` 缺失或不匹配即产生冲突 receipt，不允许静默覆盖。
8. **技术来源信息自动化。** 工作流运行、节点、生产者类型、操作和时间等由运行时记录；Agent 只负责可选备注。
9. **工作流产物不等于长期数据。** 节点草稿和中间输出有明确作用域与保留期；只有显式提交或发布的内容进入权威数据/公共产物。
10. **协议只保留明确版本号，不定义通用迁移规则。** 将来确需升级旧数据时，由用户与 Agent 针对实际模块讨论后直接修改少量数据，或临时生成批量迁移代码。
11. **既有卡前端升级采用融合而非覆盖。** 检查 skill 必须以定制后的前端为基础评估模板更新，不能假设已转换卡仍与模板一致。
12. **根目录与卡片双向不传播。** 根目录开发不修改已转换卡；单卡定制不修改根目录 Skill、模板或 global module，也不在卡片文件中留下全局化或回灌标记。跨层修改必须由用户明确指定方向和目标。

## 修改过的核心文件

### 权威规范与 skill

- `.agents/skills/design-pi-rp-data/`：统一数据设计入口、权威协议、建模、检索、变更、workflow 接入、模式与验证。
- `.agents/skills/st-card-to-pi-rp/SKILL.md` 及其 `references/`：转换流程和目标格式全面升级。
- `.agents/skills/create-pi-rp-feature-module/`：根目录模块创作规范。
- `.agents/skills/audit-and-upgrade-pi-rp-card/`：新增显式触发的检查与升级 skill。
- `PI-RP-DEVELOPMENT-SCOPE.md`：根目录、卡片、运行时与 session 的修改边界。

### Pi 运行时

- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-records.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-schema.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-index.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-views.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-query.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-changes.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-transactions.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-artifacts.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-node-runtime.mjs`
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts`：统一工具、上下文和 Web bridge 集成。
- `rp-context-processors.mjs`、`rp-records.mjs`、`rp-workflows.mjs`、`rp-workflow-engine.mjs`、`rp-workspace.mjs`：接入 Workflow v2 和统一数据运行时。
- `agents/data-worker/agent.json`、`agents/background-worker/agent.json`、`agents/narrative-writer/agent.json`、`workflows/standard-rp/workflow.json`：替换旧专用更新流程。

### 校验、Web 与项目入口

- `.agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py` 及其测试：校验 Module v4、Data Contract v1 和 Workflow v2。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/app.js` 及测试：统一数据入口和用户删除文案/行为。
- `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/APPEND_SYSTEM.md`：游玩环境统一协议说明。
- `.pi/APPEND_SYSTEM.md`、`.gitignore`、`PI-RP-DEVELOPMENT-SCOPE.md`、`PI-PLAY-CONTEXT-ISOLATION.md`、`README.md`：根目录提示入口、开发边界、隔离与项目说明。

## 测试与验证结果

2026-09-02 基于当前工作树重新执行：

- Pi 运行时 Node 测试：`52/52` 通过。
  - 覆盖协议、索引、view、identity、预算、批次提交、权限、revision 冲突、幂等、事务回滚、processor、节点结束提交、工作流、用户删除和工作区产物。
- Web 模板测试：`6/6` 通过。
- Python 卡包校验器测试：`4/4` 通过。
- 角色卡检查 skill 的 inventory 测试：`2/2` 通过。
- `node --check` 检查 Web `public/app.js`：通过。
- `git diff --check`：通过，无空白错误。
- Pi 使用 `--offline --no-session --no-skills --no-extensions` 并单独加载 `pi-rp-web.ts`：退出码 `0`，扩展可被当前 Pi 运行时加载。
- `design-pi-rp-data`、根目录 `create-pi-rp-feature-module`、`st-card-to-pi-rp`、`audit-and-upgrade-pi-rp-card` 四个 Skill 的结构快速校验：全部通过。
- 检查 41 个相关 Markdown 文件的相对链接：全部可解析。

未执行真实 provider/API、真实新转换卡的完整 RP 回合测试；现有测试卡按用户要求不升级，因此没有拿它们验证新协议。

## 已知问题

1. **真实端到端链路尚未验证。** 尚未用重新转换后的角色卡和实际模型验证查询、Agent 主动提交、节点结束提交、并发冲突提示、事务 receipt、前端展示和下一轮上下文的完整组合。
2. **本机 PATH 中的 `python` 不可用。** 当前 Python 测试使用 Codex 随附解释器；直接运行文档中的 `python ...` 命令在本机可能命中 Windows Store 占位程序并以 `9009` 退出。
3. **skill 快速校验依赖环境补充。** 随附 Python 最初缺少 PyYAML，且默认 GBK 解码无法读取部分 UTF-8 文档；本阶段通过临时依赖目录和 `-X utf8` 完成校验。依赖未写入仓库。
4. **`play/` 不受 Git 管理且本阶段未处理。** 用户会手动清理整个目录并重新转卡；任何根目录或模板修改都不得隐式同步到其中。

## 尝试过但失败的方案

- 直接使用 PATH 中的 `python` 运行校验失败，退出码为 `9009`；改用 Codex 随附 Python 后成功。
- 首次运行 skill 快速校验时因缺少 PyYAML 失败；临时安装到仓库外的依赖目录后，又遇到 Windows 默认 GBK 解码错误；最终通过增加 `-X utf8` 成功完成校验。
- 开发过程中尝试用组合式 PowerShell 命令批量删除旧目录并同步文件，被执行安全策略拒绝；随后改为核对精确路径后分别删除、应用补丁和复制，没有造成仓库内容损坏。
- Web 测试最初仍断言旧的“修改数据”文案，在界面切换为只读“查看数据”后失败；测试已按新行为更新并重新通过。

## 待解决工作

无。当前没有用户已经明确提出、但尚未完成的开发内容。

“真实端到端链路尚未验证”是当前验证边界，不表示用户已经授权执行真实模型测试。

## 常用验证命令

```powershell
$tests = Get-ChildItem .agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib -Filter '*.test.mjs' | Select-Object -ExpandProperty FullName
node --test $tests
npm test --prefix .agents/skills/st-card-to-pi-rp/assets/pi-rp-web
& 'C:\Users\bayue\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -X utf8 .agents/skills/st-card-to-pi-rp/scripts/test_validate_card_pack.py
& 'C:\Users\bayue\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -X utf8 .agents/skills/audit-and-upgrade-pi-rp-card/scripts/test_inventory_card.py
node --check .agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public/app.js
git diff --check
```
