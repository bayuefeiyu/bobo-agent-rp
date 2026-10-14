# 前后端分离：源码盘点

> 历史基线：本文保留实施前事实与路由清单；旧 Web server 已移至共享包并删除旧入口。当前实现见[实施记录](../../../../FRONTEND-SEPARATION-IMPLEMENTATION.md)和[生成 API](../../../../packages/rp-web-contract/API.md)，请勿据此接入旧接口。

盘点日期：2026-10-14。对应[实施计划](../../../../FRONTEND-BACKEND-SEPARATION-PLAN.md)。

本文件记录当前源码事实，不定义新协议。范围为根公共源码，不读取真实卡、用户密钥或聊天数据，不启动服务。HEAD 为 `9cbcab0`，工作区含大量既有修改；下列行号和哈希以本次读取时为准，实施前应重新核对。

计划修订说明：用户已明确本次为破坏性更新，不考虑旧卡兼容。下列旧 API、v1/v2 声明及打包入口描述仅记录盘点时的实现，不构成保留要求；改造按实施计划的新基线执行，不增加旧卡兼容层。

## 1. 入口与调用链

实际是**两套 HTML 入口、三种服务上下文、两份 HTTP 路由实现**，不是每个功能面板都有独立后端：

| 上下文 | 启动链 | 前端 | 业务实现 |
| --- | --- | --- | --- |
| 项目选卡 | `pi-rp-launcher/server.mjs` → scanCards/launchCard → Pi RPC 子进程 → ready file | `pi-rp-launcher/index.html`，CSS/JS 内联 | 自己扫描卡、管理 active process、recent 与交接 |
| 卡内游玩 | Pi extension → `createRpHostSession` → startBridge → 卡内 `web/server.mjs` → `startWebBridge` | `pi-rp-web/public/index.html` | 注入 config/workflows/modules/chat/attempts/images bridge |
| 根开发预览/全局配置 | `manage-pi-rp-config-ui/scripts/start-config-ui.mjs` → **导入相同 createApplication** | 同一 `public/index.html` | preview cardStore、独立 bridge、全局 profile/config stores |

关键定位：

- 实施前 pi-rp-web/server.mjs（该旧入口现已删除）：201–205 固定 public 根；207 createApplication；613–628 静态 fallback；638–654 startWebBridge。
- [开发入口](../../manage-pi-rp-config-ui/scripts/start-config-ui.mjs)：12 导入 createApplication；140–253 注入的 cardStore/bridge；255–265 监听和打开页面。
- [宿主接线](../assets/pi-rp-runtime/.pi/lib/rp-host-session.ts)：396–409 固定导入卡内 web/server.mjs；865–906 模块/数据适配和各 bridge 组装；915–917 ready 文件及浏览器交接。
- [启动器](../assets/pi-rp-launcher/server.mjs)：175–217 launchCard；220–244 路由；251–257 独立启动。

开发入口已经复用路由和配置目录构造函数。需要继续整理的是服务实现、能力声明和生命周期，不能把“合并两份配置 router”当成待完成任务。

## 2. 前端文件与依赖

以下路径相对 `assets/pi-rp-web/public/`；行数按 UTF-8 文本以换行分段统计，仅反映规模，不作为验收指标。

| 文件 | 行数 | 当前职责及耦合 |
| --- | ---: | --- |
| `index.html` | 318 | 正文、卡列表、用户/系统设置、配置、工作流、Token、模块 rail、图片弹窗共用页面 |
| `app.js` | 1052 | 页面入口、正文和聊天生命周期、全局初始化、轮询、头像上传、面板导航；重导出部分内部函数 |
| `app-context.js` | 200 | state/elements 全局对象、DOM 初始化、request、错误/交接展示、模型预设 |
| `app-modules.js` | 985 | region 分派、数据查询、表单/拨档、记录/故事、模块显示设置，依赖共享 context 和 image renderer |
| `app-image.js` | 211 | 生图请求、图片查看器、提示词再生成、Comfy 设置；依赖共享 context |
| `app-workflows.js` | 394 | 定义与运行、恢复/重试、Token 聚合、模型/Agent 标签；依赖共享 context |
| `app-call-records.js` | 124 | 调用记录弹窗、过程记录、1.5s 定时刷新；request 来自 context |
| `config.js` | 694 | 单独的局部 state、fetch/token、profile 编辑、模型指定、资料库及历史服务配置 |
| `module-autosave.js` | 44 | 无 DOM 的串行字段保存队列，revision 冲突比对；仍带展示文案 |
| `team-presets.js` | 129 | 配置中的团队/协作模式转换纯逻辑 |
| `prompt-controls.js` | 57 | 拨档选择与预览纯逻辑 |
| `module-json.js` | 29 | JSON 树建模 |
| `model-providers.js` | 22 | 配置页模型供应商数据；context 另有 modelPresets |
| `markdown.js` | 170 | DOM Markdown 渲染器 |
| `styles.css` / `config.css` | 1360 / 101 | 官方主题与配置域样式，不能成为新公开 API 的依赖 |

主要调用链：

```text
index.html -> app.js -> app-context + app-modules + app-image + app-workflows
                    -> app-workflows -> app-call-records -> app-context
index.html -> config.js -> team-presets + model-providers
launcher/index.html -> 内联 fetch
```

`app.js:995–1038` 初始化卡、状态、设置、模块、模型、Agent、工作流、卡列表和历史；1040–1044 启动 600ms 轮询；968–992 刷新主状态并按面板刷新模块/工作流/Token。`config.js:147–151` 另有请求封装，692 从 hash/context 取得配置 token。`app-context.js:138–151` 通过错误消息正则识别失效 bridge，并直接操作交接 UI。

资源地址在 app/app-image 等文件中直接使用 `/api/...`，头像上传还绕开通用 request 调 fetch。SDK 抽取范围要包括二进制和资源 URL，不只是 JSON。

## 3. HTTP 路由完整清单

### 3.1 口径与标记

Web handler 有 **94** 个 method＋path 模式，启动器另有 **3** 个。开发入口复用 Web handler 的 94 个，不是另外 94 份实现，也不表示其 bridge 全部支持。正则枚举展开计数，query 参数不增加计数；静态 GET 和 404 fallback 不计。

下面 `B` 为注入的 bridge，`C` 为 cardStore，`A` 为路由调用 `authorizeConfigMutation(x-rp-config-token)`。没有 A 仅表示此路由没有调用该配置认证方法，不代表底层没有数据权限或生命周期检查。

所有 Web 路由来自 实施前 pi-rp-web/server.mjs（现已删除）。参数名为阅读方便归一化；ID 的实际正则仍以源码为准，工作流全限定引用必须编码为一个 URL path segment。

### 3.2 正文、尝试、聊天、消息：17

源码 212–249、542–554、586–611。

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| GET | `/api/card` | C.getPublicCard |
| GET | `/api/state` | B.getState |
| GET | `/api/narrative-attempts` | B.listNarrativeAttempts |
| POST | `/api/narrative-attempts/regenerate` | B.regenerateNarrative |
| POST | `/api/narrative-attempts/preview` | B.previewNarrativeAttempt |
| GET | `/api/narrative-attempts/:attemptId/history` | B.getNarrativeAttemptHistory |
| POST | `/api/narrative-attempts/:attemptId/adopt` | B.adoptNarrativeAttempt |
| PUT | `/api/narrative-attempts/:attemptId` | B.reviseNarrativeAttempt |
| GET | `/api/transcript` | B.getTranscript |
| GET | `/api/sessions` | B.listSessions |
| POST | `/api/opening` | C.getOpening → B.selectOpening |
| POST | `/api/input` | B.submitInput |
| POST | `/api/resume` | B.resumeSession |
| GET | `/api/messages/:sequence/history` | B.getMessageHistory |
| PUT | `/api/messages/:sequence` | B.updateMessage |
| DELETE | `/api/messages/:sequence` | B.deleteMessage |
| DELETE | `/api/sessions/:sessionId` | B.deleteSession |

### 3.3 卡、用户与系统：10

源码 252–262、526–541、556–585。用户资料与头像通过 `playerName` query 指定；无独立 GET user-profile。

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| GET | `/api/cards` | B.listCards |
| GET | `/api/cards/:cardId/cover` | B.getCardCover |
| GET | `/api/settings` | B.getSettings |
| GET | `/api/user-avatar` | B.getUserAvatar |
| POST | `/api/user-avatar` | B.updateUserAvatar；二进制 |
| POST | `/api/user-settings` | B.updateUserSettings |
| DELETE | `/api/user-profile` | B.deleteUserProfile |
| POST | `/api/card-switch` | B.switchCard |
| POST | `/api/system-settings` | B.updateSystemSettings |
| POST | `/api/module-display-settings` | B.updateModuleDisplaySettings |

### 3.4 配置：28

源码 263–331。叙事历史与资料库 semantic 子路由将 URL 转成管理 operation。

| 方法 | 路径 | 实现 / 认证 |
| --- | --- | --- |
| GET | `/api/config/context` | B.getConfigContext |
| GET | `/api/config/catalog` | B.getConfigCatalog |
| GET | `/api/config/reference-library` | B.getReferenceLibrary |
| POST | `/api/config/reference-library/directories` | B.browseReferenceDirectories + A |
| GET | `/api/config/narrative-history/config` | B.historyServiceManagement(settings) |
| GET | `/api/config/narrative-history/status` | B.historyServiceManagement(status) |
| PUT | `/api/config/narrative-history/config` | B.historyServiceManagement(save) + A |
| POST | `/api/config/narrative-history/test` | B.historyServiceManagement(test) + A |
| GET | `/api/config/reference-library/semantic/config` | B.referenceSemanticManagement(settings) |
| GET | `/api/config/reference-library/semantic/status` | B.referenceSemanticManagement(status) |
| PUT | `/api/config/reference-library/semantic/config` | B.referenceSemanticManagement(save) + A |
| POST | `/api/config/reference-library/semantic/test` | B.referenceSemanticManagement(test) + A |
| POST | `/api/config/reference-library/semantic/query` | B.referenceSemanticManagement(query) + A |
| POST | `/api/config/reference-library/semantic/jobs` | B.referenceSemanticManagement(start) + A |
| POST | `/api/config/reference-library/semantic/jobs/:jobId/cancel` | B.referenceSemanticManagement(cancel) + A |
| POST | `/api/config/reference-library/semantic/jobs/:jobId/resume` | B.referenceSemanticManagement(resume) + A |
| PUT | `/api/config/reference-library` | B.saveReferenceLibrary + A |
| GET | `/api/config/profiles` | B.listConfigProfiles |
| POST | `/api/config/profiles` | B.createConfigProfile + A |
| POST | `/api/config/import` | B.importConfigProfile + A |
| GET | `/api/config/profiles/:profileId/export` | B.exportConfigProfile |
| POST | `/api/config/profiles/:profileId/rename` | B.renameConfigProfile + A |
| POST | `/api/config/profiles/:profileId/duplicate` | B.duplicateConfigProfile + A |
| POST | `/api/config/profiles/:profileId/activate` | B.activateConfigProfile + A |
| PUT | `/api/config/profiles/:profileId/secrets/models/:modelId` | B.saveConfigModelSecret + A |
| GET | `/api/config/profiles/:profileId` | B.getConfigProfile |
| PUT | `/api/config/profiles/:profileId` | B.saveConfigProfile + A |
| DELETE | `/api/config/profiles/:profileId` | B.deleteConfigProfile + A |

### 3.5 生图与连接：12

源码 351–397；均委托 B，路由本身不调用配置 token 校验。

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| GET | `/api/image-generation` | getImageGeneration |
| PUT | `/api/image-generation/preferences` | saveImagePreferences |
| POST | `/api/image-generation/run` | startImageGeneration |
| POST | `/api/image-generation/requests/:requestId/recover` | recoverImageGeneration |
| GET | `/api/image-generation/connections` | getComfyConnections |
| POST | `/api/image-generation/connections` | saveComfyConnection |
| DELETE | `/api/image-generation/connections/:connectionId` | removeComfyConnection |
| POST | `/api/image-generation/connections/:connectionId/test` | testComfyConnection |
| PUT | `/api/image-generation/profiles/:profileId/override` | saveComfyProfileOverride |
| POST | `/api/image-generation/profiles/:profileId/open` | openComfyProfileDocument |
| GET | `/api/image-generation/renders/:renderId/images/:index` | getComfyRenderImage；二进制，含 preview query |
| POST | `/api/image-generation/renders/:renderId/regenerate` | regenerateComfyRender |

### 3.6 模块与影响查询：11

源码 333–349、398–447；均委托 B。

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| GET | `/api/modules` | listFeatureModules |
| GET | `/api/data-impact` | inspectDataImpact |
| POST | `/api/modules/:moduleId/open` | openFeatureModuleDocument |
| GET | `/api/modules/:moduleId/regions/:regionId/records` | queryModuleFrontendRegion |
| GET | `/api/modules/:moduleId/regions/:regionId/records/:recordId/history` | getModuleFrontendHistory |
| GET | `/api/modules/:moduleId/regions/:regionId/stories/:recordId` | getModuleFrontendStory |
| POST | `/api/modules/:moduleId/regions/:regionId/stories/:recordId/open-source` | openModuleAuthoritySource |
| GET | `/api/modules/:moduleId/regions/:regionId/settings` | getModuleFrontendSettings |
| PUT | `/api/modules/:moduleId/regions/:regionId/settings` | updateModuleFrontendSettings |
| GET | `/api/modules/:moduleId/regions/:regionId/integrity` | inspectModuleFrontendIntegrity |
| POST | `/api/modules/:moduleId/regions/:regionId/workflows/:workflowId/run` | runModuleFrontendWorkflow |

### 3.7 模型、Agent、工作流及诊断：16

源码 449–524；均委托 B。Token UI 由现有运行数据聚合，没有独立 token API。

| 方法 | 路径 | 实现 |
| --- | --- | --- |
| GET | `/api/models` | listModels |
| POST | `/api/models/discover` | discoverModels |
| POST | `/api/models/test` | testModel |
| GET | `/api/agents` | listAgents |
| GET | `/api/workflows` | listWorkflows |
| GET | `/api/workflow-runs` | listWorkflowRuns |
| POST | `/api/workflow-runs/:runId/reexecute` | reexecuteWorkflow |
| GET | `/api/workflow-runs/:runId/nodes/:nodeId/process-record` | getWorkflowNodeProcessRecord |
| POST | `/api/workflow-runs/:runId/nodes/:nodeId/process-record/open` | openWorkflowNodeProcessRecord |
| POST | `/api/workflow-runs/:runId/nodes/:nodeId/team-transcript/open` | openWorkflowTeamTranscript |
| GET | `/api/workflow-policy` | getWorkflowPolicy |
| POST | `/api/workflows/:workflowId/activate` | activateWorkflow |
| POST | `/api/workflow-runs/:runId/nodes/:nodeId/retry` | retryWorkflowNode |
| POST | `/api/workflow-runs/:runId/nodes/:nodeId/recover` | recoverWorkflowNode |
| POST | `/api/workflow-runs/:runId/cancel` | cancelWorkflowRun |
| POST | `/api/workflow-runs/:runId/skip` | skipWorkflowRun |

### 3.8 启动器：3

[启动器 server](../assets/pi-rp-launcher/server.mjs) 227–241。

| 方法 | 路径 | 实现 / 认证 |
| --- | --- | --- |
| GET | `/api/cards` | scanCards、recentCards、active |
| GET | `/api/cards/:cardId/cover` | manifest 定位封面、路径与扩展名检查、文件读取 |
| POST | `/api/launch` | launchCard；`x-launcher-token` |

`GET /` 读取 index.html 并替换 `__LAUNCHER_TOKEN__`。与卡内同名的 cards/cover 端点服务上下文和响应语义并不完全相同，不能只按 URL 去重合并。

## 4. 开发模式的能力缺口

使用 TypeScript AST 静态读取开发入口的 `bridge` 对象，再与共享 server 中 `bridge.<method>(` 的唯一方法名比较：共引用 **84** 个方法，开发 bridge 中 **36** 个未定义、**12** 个明确映射为 unavailable（409）、**36** 个有实现。此统计不是 HTTP 测试结果；路由参数有效并进入未定义方法调用时，按共享 catch 推导会返回 500。

缺失的 36 个方法：

```text
adoptNarrativeAttempt          cancelWorkflowRun
getComfyRenderImage            getMessageHistory
getModuleFrontendHistory      getModuleFrontendSettings
getModuleFrontendStory        getNarrativeAttemptHistory
getTranscript                getWorkflowNodeProcessRecord
inspectDataImpact             inspectModuleFrontendIntegrity
listNarrativeAttempts         openComfyProfileDocument
openFeatureModuleDocument     openModuleAuthoritySource
openWorkflowNodeProcessRecord openWorkflowTeamTranscript
previewNarrativeAttempt       queryModuleFrontendRegion
recoverImageGeneration        recoverWorkflowNode
reexecuteWorkflow             regenerateComfyRender
regenerateNarrative            removeComfyConnection
retryWorkflowNode             reviseNarrativeAttempt
runModuleFrontendWorkflow     saveComfyConnection
saveComfyProfileOverride      saveImagePreferences
skipWorkflowRun               startImageGeneration
testComfyConnection           updateModuleFrontendSettings
```

明确 unavailable 的 12 个方法：activateWorkflow、deleteMessage、deleteSession、discoverModels、getCardCover、resumeSession、selectOpening、submitInput、switchCard、testModel、updateMessage、updateModuleDisplaySettings。

开发 bridge 还残留 7 个当前 router 不调用的 unavailable 方法：saveModel、deleteModel、saveAgent、restoreAgent、saveWorkflowPolicy、updateWorkflowNodeBinding、updateWorkflowTrigger。它们不是当前 API。

全局 profile 路由调用 `profileStore`；models/agents/workflows/policy 调用 `configStore`；用户资料/字号写 `.pi-rp-local/common.json`。catalog 组装复用 `buildConfigCatalog`。开发预览返回空聊天/空模块区域；它不支持游玩并不意味着应实现这些操作，目标是可靠声明不可用并返回明确错误。

## 5. 状态与模块授权证据

| 文件与行 | 当前行为 | 分离影响 |
| --- | --- | --- |
| `rp-turn-state.ts:57–71` | Web snapshot 含 messages、busy、blockingWorkflows、selectorUrl 等 | 需公开 DTO 与版本；运行时对象不可直接成为长期契约 |
| `rp-web-attempts-bridge.ts:46–72` | getState 按 active.displayExecutionId 换消息；preview 修改该字段 | 页面浏览选择是共享后端状态 |
| `rp-host-session.ts:870–873` | activeDataStore 按同一 displayExecutionId 选择只读 execution store | 模块预览需随正文一起迁移 |
| `rp-image-web-bridge.ts:29–60` | 操作守卫、数据 store、attemptId 受同一字段影响 | 图片和命令限制不能遗漏 |
| `rp-web-workflows-bridge.ts:31,197` | 预览期间禁止重执行/启动模块工作 | 新 API 要区分本客户端预览和后端真实运行状态 |
| `rp-host-session-scope.ts:5–44` | AsyncLocalStorage 绑定 owner、recordId、directory；切换后在途访问拒绝 | 已有异步保护应保留；新请求还需显式预期聊天身份 |
| `rp-web-modules-bridge.ts:49–53` | schemaVersion 1 时读取各 collection，返回 collections payload | 当前并非所有模块都按 view 投影；新基线移除此路径，保留功能须显式声明 binding |
| `rp-web-modules-bridge.ts:75–121` | region 类型决定查询/故事/历史，绑定 view、capability、预算 | UI 区域和数据访问绑定需要拆开 |
| `rp-web-modules-bridge.ts:123–178` | 设置/拨档按字段映射；expectedRevision；统一 executeDataBatch | 复用事务，不提供任意记录覆写端点 |
| `rp-module-frontend.mjs:3–5,108–121` | v1/v2；legacy 和 interactive 类型集合；严格字段检查 | 新声明必须同步 JS/Python 校验 |
| `scripts/validation/frontend.py:18–136` | Python 侧校验区域、view/capability、预算、工作流引用 | 只更新 JS 会导致转卡/交付校验不一致 |

上表 lib 文件位于 `assets/pi-rp-runtime/.pi/lib/`。交互类型包括 record-browser、story-browser、settings-form、prompt-controls、workflow-controls、integrity-alerts；旧类型包括 text、markdown、json、key-value、list、table、image-generation。

## 6. 打包与发布绑定

路径相对转卡 Skill，另有标注的除外。

| 文件与行 | 当前事实 | 后续触及点 |
| --- | --- | --- |
| `scripts/package_card_runtime.mjs:135–148` | 只向不存在的新目录打包，复制源卡到临时目录 | 新卡打包与已有卡前端升级应是不同工具入口 |
| 同文件 155–170 | engine extensions/lib/skills → runtime/engine；额外复制服务 packages 和默认配置 | 新共享包需显式复制，不能反查开发仓库 |
| 同文件 171 | 仅当 tmp/web/server.mjs 不存在时复制整个 Web 模板 | 不能把“已有自定义 server”当“所有前端依赖已齐全” |
| 同文件 172–175 | launch 入口、skills、必需文件固定，含 web/server.mjs | 新基线同步修改宿主接线、launch 声明与必需文件，不保留薄兼容入口 |
| 同文件 177–185 | SHA-256 全包清单；排除运行时设置/profile/lock；packageFormat 2、launchProtocol 1 | 前端替换也需维护锁清单 |
| `assets/pi-rp-launcher/validate-runtime-package.mjs:12–30,91` | 检查身份、声明、路径、缺文件；哈希差异只进 changed，ok 由 errors 决定 | 必须区分允许定制和替换工具本次完整性检查 |
| 同文件 32–90 | 校验模块/组件/依赖等 | 新 UI 包校验不改变模块所有权规则 |
| `scripts/validate_runtime_package.mjs` | 导入启动器的 validator | 只有一份维护实现，不是两套校验器 |
| `scripts/install_launcher.mjs:5–13` | 只复制 server.mjs、index.html、validate-runtime-package.mjs 三文件；更新用 --update | 共享 SDK/server 加入后需调整明确依赖清单 |
| 根 `PROJECT-RELEASE-MANIFEST.json` | 本次文档登记前固定 102 requiredPaths、7 模块、1 generatedChecks | 新 packages/示例/文档须精确纳入，不等同目录自动发布 |
| `scripts/check_release_manifest.mjs:116–141,144–234` | 校验发布路径、Git ignore、模块资源、JSON；staged/commit 支持临时物化 | 不检验所有 Web 内容哈希，不能替代打包验收 |
| 根 `.gitignore` | 根目录先全部忽略，再逐项放行 | 新根计划文件需额外放行；不放开 play |

在盘点时，release manifest 固定 requiredPaths 没有直接登记 Web server/app、启动器三个文件、打包器或安装器；不要将发布检查通过理解为这些路径全被直接覆盖。后续交付阶段补齐必要交付根与依赖检查。

现有 validator 只遍历 lock.files，未在该实现中看到对所有实际文件的反向清单比较。不能声称它会拒绝一切额外文件。启动器对 Pi 版本不符作 warning，对 Node 主版本不符在 launchCard 中拒绝启动（server.mjs:66–79、181–182）。

## 7. 测试基础与缺口

- `assets/pi-rp-web/test/backend.test.mjs`：已有 HTTP 行为基础。
- `frontend-runtime.mjs`/`frontend-runtime.test.mjs`：真实脚本配最小 DOM/fetch 替身，可验证初始化和草稿行为；不等于真实浏览器。
- `public-dom-contract.test.mjs:87–111`：明确要求 app.js 引入拆出模块、模块使用共享 elements；改造时应替换这些结构约束，不能误当对外兼容承诺。
- `config-save.test.mjs`、`module-autosave.test.mjs`、`team-presets.test.mjs`：可复用的配置行为回归。
- `rp-host-session-scope.test.mjs`、`rp-web-*-bridge.test.mjs`、执行/会话数据/模块前端测试：后端边界基础。
- 根 `scripts/runtime-delivery.test.mjs:12–291`：合成卡打包、复制后 host、真实 HTTP、离线工作流、正文尝试与采用、冲突/删除/恢复/旧 bridge 关闭；没有使用真实模型/GPU。
- 根 `scripts/verification-suites.mjs:64–96`：递归发现 `.test.mjs`；engine/web/modules 按路径归类，其他含新 packages 默认归 tools。新测试需要明确 suite 分类与发现边界。
- 当前盘点未运行上述测试，未从过去 PROJECT_STATUS 的成功计数推导本次行为通过。

新验收必须补充：无 DOM 客户端、独立静态前端、服务能力完整性、双客户端读上下文、作用域切换和迟到操作、模块双 renderer、换前端与回退、打包脱离仓库运行。

## 8. 基线指纹与复核方式

| 文件简称 | SHA-256 |
| --- | --- |
| Web server.mjs | `08f17f147e97c82b56cf32e30667c5cdf87fa51fd9178c0f7e583ba040b48fc4` |
| start-config-ui.mjs | `c7302a3519f87ef98fd239cda1c7a1c36c1611ecd4a09af6c242c277d28bc888` |
| Launcher server.mjs | `f3ed026e5e4f9ce8ba1dfea22089b5613186b5fed5a09823e3bb6da17121ec2a` |
| rp-web-attempts-bridge.ts | `4c89e370d692f0397ef2a916d35fc4743027720659127f46a1da81e7b75632b8` |
| package_card_runtime.mjs | `aaa87f781801b2fd27061d996dcad361348cdd12166e3ae57b466c5819cef215` |

复核流程：读取上述维护源，展开 method/path 分支，对比 bridge 方法存在性，检查调用消费者与包复制清单。操作计数以 §3 各表行数为准；未知代码路径或源码发生变化时重新盘点，不沿用静态数字。

已排除的误判：开发入口没有第二份 router；CLI validator 没有第二份实现；当前 app.js 没有 GET user-profile 调用，资料来自 settings；哈希变化不自动使 runtime validator 失败。
