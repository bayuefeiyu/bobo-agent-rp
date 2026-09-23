本次规划事件压缩。阅读 narrative-memory 模块 Skill 的 archive-and-maintenance.md，以及 `WORKSPACE-DOCUMENTS.md` 列出的有效事件时间线与阈值资料。只根据有效事件目录提出语义相关的 completed 事件分组；目标条数不是硬指标，没有合适分组时 groups 可以为空数组。每条来源最多出现在一个分组。

把 JSON 写入工作文件并通过交付工具提交，结构为 `{"groups":[{"sourceEntryIds":["...","..."],"name":"摘要名称","catalogSummary":"不超过50字的目录摘要","sections":{}}]}`。文件中不添加 sourceEntryIds 之外的派生覆盖、时间、地点或知情范围字段，也不写解释文字。
