# 游玩前端创作者指南

本次为破坏性更新，只支持新打包卡。main 允许替换整个游玩区域，并保留官方配置、工作流监控和恢复入口。更改整套应用或管理流程，请从官方 main 派生分支。

## 开发入口

可运行例子在 [minimal-rp-frontend](examples/minimal-rp-frontend/README.md)。它不导入官方 `app.js`、`app-context.js` 或默认游玩 DOM。协议、类型与生成的路由目录在 [rp-web-contract](packages/rp-web-contract/API.md)，无 DOM 的 SDK 在 `packages/rp-web-client/`。重新设计时先阅读[功能交接](FRONTEND-FUNCTIONAL-HANDOFF.md)，无需复刻官方布局。

独立开发页使用本地代理连接已启动的新卡后端：

```powershell
rtk proxy node examples/minimal-rp-frontend/dev-server.mjs http://127.0.0.1:<后端端口>
```

代理转发公开 API、SDK 与官方管理资产；没有新增跨域授权。玩家运行发布包不需要开发服务器或前端构建工具。React、Vue、Canvas、WebGL 等自行构建成静态文件即可；本轮没有引入游戏引擎或动画编排协议。

## 契约与状态

创建 `createRpClient({baseUrl, fetch?, auth?, transport?})`，调用 `connect()` 获得版本、能力和 `readContext`。每个实例有独立预览选择。资源通过 `resourceUrl()` 或可释放的 `loadResource()` 获取；不要拼接后端绝对文件路径。

`readContext` 包含 serverInstanceId、cardId、chatId、executionId。连接/聊天改变会取消请求，迟到结果不能更新新界面；模块分页 cursor 也绑定读取上下文。`preview(id)` 只改变本客户端的读取投影，采用候选才改变权威版本。预览时后端拒绝普通权威写入，候选修订和采用使用各自受控操作。

`watch()` 第一次读取或上下文重置通知 `snapshot`，之后状态变化通知 `change`。这是快照轮询，不保证每个中间事件都送达。不要把重新连接、预览或重载快照当作新演出事件，更不能因快照自动提交业务操作。停止订阅、卸载及 pagehide 时释放请求、计时器和对象 URL。

编辑和模块设置提交携带 expectedRevision 与稳定 operationId。断网/超时后的 `operation_outcome_unknown` 不等于提交失败：先查询相应回执或权威状态，保留原 ID 与草稿，不自动换 ID 重发。SDK 不自动重试命令。其他命令是否可幂等重试以领域契约为准。

## 游玩宿主

入口导出 `async mount({container, client, signal, context, assetUrl, host})`，返回含 `unmount()` 的控制器；可提供 `onContext`、`onVisibility`、`onResize`、`onConnection`。宿主给实例独立 client、容器和 AbortSignal；不要依赖官方全局 state/elements。上下文改变时丢弃旧聊天草稿，重新读取自己的数据。

`host.openManagement(panel)` 打开官方面板，panel 为 story/user/system/workflows/profiles/tokens；`host.returnToPlay()` 返回游玩；`host.immersive(boolean)` 请求布局。外部官方“管理/恢复默认界面”入口保持可达，Escape 可退出沉浸并打开管理。自定义入口加载失败自动恢复默认。恢复默认是当前页面操作；重新加载会重新挂载安装的前端。永久恢复用安装工具的 backup。

首版同源受信任本地代码，不是安全沙箱。宿主不把配置密钥交给挂载参数；同源脚本隔离和远程多用户部署不在本轮承诺中。

## 模块和不同交互

`frontend-view.json` 仅接受 schemaVersion 3，包含 `bindings` 与 `regions`。binding 定义 records/stories/settings/prompts/workflows/integrity/images 能力，决定 collection/view/capability/字段/预算等权限；region 仅选择默认 renderer 和标题。公开请求使用 moduleId + bindingId，不使用控件类型授权。

创作者可以把 settings 的布尔字段画成开关、场景点击或其他操作；独立样例用普通动作按钮，官方默认 renderer 用表单。二者调用同一设置 API，不能增添未声明字段。未知必需 renderer 校验失败；标记 `optional:true` 的未知 renderer 保留验证过的 binding，官方界面只显示该区域的降级提示。增加业务通过既有模块机制，不能直接读写 session、任意集合或运行未授权工作流。

## 前端包及安装

包根放 `frontend.json`，字段集合固定：schemaVersion/id/version/kind/root/entry/apiVersion/hostVersion/requiredCapabilities/optionalCapabilities/assets/immersive。参考[样例描述](examples/minimal-rp-frontend/frontend.json)。custom root 必须为 `frontends/...`；入口、构建分块、CSS、字体、图像和音视频等文件逐个列入 assets。拒绝漏登记、缺失、符号链接、路径越界与不兼容版本。必需能力必须为协议已知能力，并在实际挂载时全部可用；可选能力由界面自行降级。

停止目标卡运行后，明确指定新基线卡与前端包：

```powershell
rtk proxy node scripts/install-play-frontend.mjs <目标新卡目录> <前端包目录>
rtk proxy node scripts/install-play-frontend.mjs <目标新卡目录> <前端包目录> --replace
rtk proxy node scripts/install-play-frontend.mjs <目标新卡目录> --restore <backupId> --replace
rtk proxy node scripts/install-play-frontend.mjs <目标新卡目录> --recover
```

已有 custom 前端必须显式 --replace。工具保存 descriptor/lock 备份，用新目录安装并原子切换，更新资产哈希，核对官方管理/后端/模块文件字节未变。崩溃留下 pending journal 时校验拒绝启动，先 --recover。回退仅适用于当前平台版本，不跨本次破坏性更新。安装成功后重启卡；工具不会改 session、配置或模型，也不会自动遍历更新 play/。

新卡 runtime-lock schema2/packageFormat3、launch schema2、runtimeVersion2.0.0、Web API/宿主1.0。旧卡、v1/v2 模块视图、自定义 web/server.mjs、旧 API 路由全部拒绝；本轮没有迁移工具。
