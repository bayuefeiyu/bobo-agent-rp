# 近场叙事模块导入

把本目录复制到卡片 `features/local-scene-narrative/`，并把 `agents/local-narrative-writer/` 复制到卡片 `agents/`。依赖 `card-context-library`、`narrative-memory`、`world-narrative-coordinator` 及支持 `document-workspace-snapshot`、调用次数限制、`story-browser` 的当前运行时。

**本模块由导演驱动，不是一个可单独使用的完整功能。** 本目录的 `dependencies.json` 记录了导演提供的职责（何时委托、指导来源、审核、发布归档）以及解耦所需的工作量与风险。只导入本模块而不导入导演时，转换流程必须让用户在“补选 `world-narrative-coordinator`”和“在本卡内自行编写解耦编排”之间明确选择，并把选择写进 `conversion-report.md`；不要静默丢弃集成，也不要因为用户没选导演就拒绝导入。

卡片作者应基于正文同类资料适配本模块自己的 `documents/creative-principles.md`、`style.md` 与 `format.md`；运行时不会直接把正文创作要求当作本模块文风。

候选工作流只读且每次只写一篇；正式发布必须经过导演统审并调用内部发布工作流。前端标题为“一隅众生”，默认区域保持折叠；高级用户可通过“打开权威源文件”进入实际 JSONL 分区自行修改，后果由用户自行承担。
