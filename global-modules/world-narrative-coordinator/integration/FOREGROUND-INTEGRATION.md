# 正文工作流接入片段

不要复制一套固定正文图。转换器应在卡片现有正文 Agent 节点中保留原有分析与创作任务，并完成以下接入：

1. 正文 Agent 先完成本轮情景分析，并调用 `narrative-memory/narrative-memory-retrieve`。
2. 在同一正文 Agent 节点中调用 `world-narrative-coordinator/pre-director-update`。已接入的公共运行时会从该节点实际获准的资料自动生成冻结的 `document-workspace-snapshot`，并作为 `context` 文档输入；正文 Agent 不手工复制、重组或传递整个节点工作区。
3. 前置导演从快照根 `DOCUMENTS.md` 开始按需阅读。工作流作者通过节点文档声明控制快照内容；需要新增资料时修改声明及其生成代码，不在提示词中要求 Agent 打包。
4. 前置调用返回后，再调用 `world-narrative-coordinator/materialize-guidance`，参数至少包含 `publicationId=publication-narrative` 与 `channel=narrative`，将返回文档作为当前轮创作依据。
5. 正文完成后，由顶层 `director-post-turn` 工作流接手后置复盘；正文 Agent 不替后置导演做常规复盘。

若启用近场或广域叙事，正文前还应运行公共 `prepare-recent-narrative-stories` 节点。它读取正文工作流的 `turnContext.recentCompleteTurns`（默认5），为两个模块导出摘要式目录及按需全文；不是只提供上一轮。正文写作节点发布时必须生成 `document-workspace-snapshot`，供后置导演和候选创作共享本轮实际获准资料与最终正文。下一轮前置导演必须明确检查刚发布的模块故事与新玩家输入是否相交。

正文节点的 `workflowCalls` 只能显式列出上述目标。模型仍由顶层工作流绑定，模块不得写死特定供应商或强弱档位。
