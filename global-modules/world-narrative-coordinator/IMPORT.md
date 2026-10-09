# 导入与接入

本目录是项目全局源模块。只有用户在转卡提案中明确选择后，才将 `global-modules/world-narrative-coordinator/` 完整复制到卡片的 `features/world-narrative-coordinator/`；`agents/`、`prompts/`、`workflows/`、`runtime/`、`documents/` 与 `module.json` 都留在模块目录内，不把内容摊平到卡片根目录，也不建立根级提示词或工作流副本。模块 manifest 使用 schema 7，以 `agentFiles` 和 `workflowFiles` 注册全部自有 Agent 与工作流；每个工作流使用 schema 4 并声明 `ownerModuleId`，Agent、工作流目标和触发器引用使用 `world-narrative-coordinator/<id>` 这类全限定 ID，`promptFile` 与 `entryFile` 保持模块相对路径。导入副本归卡片所有，不与本目录自动同步。

## 必需依赖

- `features/card-context-library/module.json`
- `features/narrative-memory/module.json`

缺失任一依赖时，转换或验证必须失败，不得静默降级。卡片创作资料库必须包含 `director-future` 类别。该类别只装载未发生的未来事件、世界形势与处理意图；纯文风、节奏和创作原则仍放在 `narrative-guidance`、`rule` 或 `style`。

## 模块工作流与卡片接入

导入器需按卡片已确认的正文工作流选择模块内绑定，而不是把模块工作流复制到卡片根目录：

1. 导演版前台正文：正文 Agent 完成情景分析和记忆检索后调用前置日常导演；前置写入 `private-state`，正文节点再调用 `materialize-guidance(publicationId=publication-narrative, channel=narrative)` 并继续创作。
2. 后置导演：若卡片启用近场/广域叙事，使用模块内 `workflows/director-post-with-narratives/workflow.json`，并把其 `trigger.workflowId` 明确绑定到实际选中的前台正文工作流全限定 ID，例如 `narrative-controls/advanced-memory-rp` 或 `narrative-controls/standard-rp`。正文写作节点必须导出 `post-turn-context`，后置流程阻塞下一轮，依次完成主要复盘和委托决策、两个候选分支并行创作、导演第二次 Agent 调用统审、两个发布分支并行发布及通用来源捕获。若未启用这两个模块，可采用精简 `workflows/director-post-turn/workflow.json`。
3. 深度包装：使用并保留模块内已注册的 `workflows/director-deep-wrapper/workflow.json`。确定性启动节点根据后置交接中的 `shouldStart` 和 reasonCodes 读取 `settings.deep.workflowMode`：`single` 调用 `world-narrative-coordinator/deep-director-planning`，`team` 调用可变人数的 `world-narrative-coordinator/deep-director-team-planning`。团队版先用短锁登记运行，会议期间不占写锁，最后再用短锁把深度报告与参考资料原子提交；失败、取消或跳过均通过生命周期收尾释放运行状态。
4. 开场初始化：使用模块内 `world-narrative-coordinator/director-opening-bootstrap`，其 `trigger.type=after-opening` 且阻塞首次输入，复用后置导演 Agent 并传入 `phase=opening`。模块内的 `world-narrative-coordinator/director-opening-deep-wrapper` 在初始化完成后检查深度启动建议；是否建议启动由开场初始化结合 `settings.opening.deepMode` 决定。
5. 统计、手动维护和手动完整性修复：使用模块内已注册的 `world-narrative-coordinator/director-health-check`、`world-narrative-coordinator/director-manual-maintenance` 与 `world-narrative-coordinator/director-integrity-repair-entry`。统计更新 `health-dashboard` 前端快照但不维护数据；维护和修复仍只由用户手动启动。`director-integrity-repair-entry` 是入口包装，实际修复工作流仍是 `world-narrative-coordinator/director-integrity-repair`；两者都由 `module.json.workflowFiles` 注册。

导入时必须把模块内触发器绑定到卡片实际启用的全限定工作流 ID。近场/广域后置流程的 `trigger.workflowId` 应是 `narrative-controls/standard-rp` 或 `narrative-controls/advanced-memory-rp`；归档捕获工作流的 `trigger.workflowId` 应是 `world-narrative-coordinator/director-post-turn` 或 `world-narrative-coordinator/director-post-with-narratives`。转换器应根据用户确认的前台和后置选择写入这些真实引用，不能保留模板占位符。

不要同时启用精简版和近场/广域统筹版后置流程。

### 两种后置集成图的深度交接

`world-narrative-coordinator/director-deep-wrapper` 的触发器从后置工作流的一个节点输出取得深度材料，因此**它必须按实际采用的后置集成图逐条重新映射**，不能只替换 workflowId：

| 采用的后置工作流 | `story-context` 的来源 | 说明 |
| --- | --- | --- |
| `world-narrative-coordinator/director-post-turn`（精简版） | `review` / `story-context` | 该节点把已冻结的 `trigger/turn-context` 声明成 `turn` 作用域输出并列入 `workspaceHandoff`。 |
| `world-narrative-coordinator/director-post-with-narratives`（近场/广域版） | 由卡片自行补一个确定性转交 | 该图的 `post-director` 只导出 `delegations`，**不提供 story context**；直接沿用精简版的映射会得到一个永不解析的引用。转换时必须在该节点上补声明 `story-context`（指向它已收到的 `trigger/turn-context`、`scope=turn`、`retain=turn`）并列入 `workspaceHandoff`，或改用另一个真实存在的输出。 |

补声明是**转卡动作的一部分**，不是模板默认：只有启用了近场/广域编排的卡才需要它，而那正是深度包装的映射目标。校验器会逐条核对，漏掉即报错。

深度包装的 `start-if-needed` 必须声明 `metadata.triggerInputs` 且以 `metadata.storyContextSource: "trigger"` 要求上游转交；此时缺少 `trigger/story-context` 会直接失败，不会退回对话历史，因为把当前对话当作"已冻结剧情"会让深度报告看起来成功却基于不同材料。开场与手动入口没有上游可转交，使用 `world-narrative-coordinator/director-opening-deep-wrapper`，其 `storyContextSource: "history"` 明确允许历史回退。

校验器会逐个检查 `trigger.documents` 的 `fromNode` 与 `output` 是否真的存在于所引用的源工作流、输出作用域是否为 `turn`/`session`/`public`，以及每个节点的 `metadata.triggerInputs` 是否有对应映射；四类问题都是错误而非警告。

前置与后置不会同时执行，可以锁定同一 `private-state`。旧版单 Agent 深度导演仍在运行期间锁定 `deep-workbench`；团队版只在 begin、commit、finish 三个短事务中锁相应目录，长时间讨论不占写入通道，并可与日常导演并行。内部工作流未声明 `writeLocks` 时，模块内部写工作流默认锁整个模块，保持原有排他行为。

导演归档交接由卡片现有通用 `narrative-memory/narrative-memory-source-capture` 接入：只查询 `archive-outbox` 的 ready 条目和 `archive-source` 视图，成功捕获后由模块确定性节点用回执更新 `status=captured` 与 `sourceCaptureId`。`contentVersion` 由确定性代码根据业务内容变化维护，Agent 不填写或决定该值；捕获身份绑定来源记录与该版本。近场、广域已发布故事也走同一来源捕获协议，并由叙事记忆中各自的预定义说明指导归档；不要创建模块专属归档 Agent。

模块前端提供深度状态、参考资料正式记录、团队/单人模式设置、最近一次数据统计与手动维护入口。统计只提醒，不自动维护；直接查看正式记录供高级用户 DIY，项目不为越过工作流直接修改权威数据的后果兜底。导入不修改现有会话，也不自动修复原地编辑。
## 导演拨档要求

本模块现为 hybrid 包，包含可在游玩中切换的导演要求。导入前阅读 [DIRECTOR-CONTROLS.md](DIRECTOR-CONTROLS.md)：全部档位资源独立保存并完整随卡复制；所选内容按文档内 Agent 归属标记保留原文顺序，运行时加入对应导演的提示词。默认“主角待遇”不追加；末项“其他要求”只有默认与玩家自定义，默认文档可由创作者或转卡者填写。组合结果不进入正文静态资料库。需同时使用支持此装配方式的公共运行时。
