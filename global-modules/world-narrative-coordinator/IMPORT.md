# 导入与顶层接入

本目录是项目全局源模块。只有用户在转卡提案中明确选择后，才复制到卡片的 `features/world-narrative-coordinator/`；同时复制 `agents/` 中的 Agent 配置到卡片 `agents/`。导入副本归卡片所有，不与本目录自动同步。

## 必需依赖

- `features/card-context-library/module.json`
- `features/narrative-memory/module.json`

缺失任一依赖时，转换或验证必须失败，不得静默降级。卡片创作资料库必须包含 `director-future` 类别。该类别只装载未发生的未来事件、世界形势与处理意图；纯文风、节奏和创作原则仍放在 `narrative-guidance`、`rule` 或 `style`。

## 卡片顶层工作流

导入器需按卡片已有正文工作流生成，而不是直接复制固定正文图：

1. 导演版前台正文：正文 Agent 完成情景分析和记忆检索后调用前置日常导演；前置写入 `private-state`，正文节点再调用 `materialize-guidance(publicationId=publication-narrative, channel=narrative)` 并继续创作。
2. 后置导演：若卡片启用近场/广域叙事，采用 `integration/workflows/director-post-with-narratives/workflow.json` 为模板，把触发器中的正文工作流ID替换成实际ID。正文写作节点必须导出 `post-turn-context`，后置流程阻塞下一轮，依次完成主要复盘和委托决策、两个候选分支并行创作、导演第二次Agent调用统审、两个发布分支并行发布及通用来源捕获。若未启用这两个模块，可采用精简 `director-post-turn`。
3. 深度包装：`global-background`，锁定 `deep-workbench`，由确定性启动节点根据后置交接中的 `shouldStart` 和 reasonCodes 调用 `deep-director-planning`；同一时间仅一份运行。
4. 开场初始化：`turn-background`，`trigger.type=after-opening` 且阻塞首次输入，复用后置导演 Agent 并传入 `phase=opening`。另生成一个在初始化完成后检查深度启动建议的非阻塞包装工作流；是否建议启动由开场初始化结合 `settings.opening.deepMode` 决定。
5. 手动维护和手动完整性修复：顶层手动工作流只负责准备用户请求/诊断并调用对应内部工作流。

导入时还必须把 `director-archive-source-capture` 的 `DIRECTOR_POST_WORKFLOW_ID` 替换为本卡实际采用的后置导演工作流ID；不要同时启用精简版和近场/广域统筹版后置流程。

前置与后置不会同时执行，可以锁定同一 `private-state`。深度导演只锁 `deep-workbench`，允许与日常导演并行。旧模块未声明 `writeLocks` 时，模块内部写工作流默认锁整个模块，保持原有排他行为。

导演归档交接由卡片现有通用 `narrative-memory-source-capture` 接入：只查询 `archive-outbox` 的 ready 条目和 `archive-source` 视图，成功捕获后由顶层确定性节点用回执更新 `status=captured` 与 `sourceCaptureId`。`contentVersion` 由确定性代码根据业务内容变化维护，Agent 不填写或决定该值；捕获身份绑定来源记录与该版本。近场、广域已发布故事也走同一来源捕获协议，并由叙事记忆中各自的预定义说明指导归档；不要创建模块专属归档 Agent。

首次版本不创建前端，不修改现有会话，不自动维护数据，也不自动修复原地编辑。
