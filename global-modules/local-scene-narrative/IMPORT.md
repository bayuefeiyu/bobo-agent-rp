# 近场叙事模块导入

把本目录复制到卡片 `features/local-scene-narrative/`，并把 `agents/local-narrative-writer/` 复制到卡片 `agents/`。依赖 `card-context-library`、`narrative-memory`、`world-narrative-coordinator` 及支持 `document-workspace-snapshot`、调用次数限制、`story-browser` 的当前运行时。

卡片作者应基于正文同类资料适配本模块自己的 `documents/creative-principles.md`、`style.md` 与 `format.md`；运行时不会直接把正文创作要求当作本模块文风。

候选工作流只读且每次只写一篇；正式发布必须经过导演统审并调用内部发布工作流。前端标题为“一隅众生”，默认区域保持折叠；高级用户可通过“打开权威源文件”进入实际 JSONL 分区自行修改，后果由用户自行承担。
