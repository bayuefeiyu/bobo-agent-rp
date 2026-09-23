本次完成调用方的记忆查询。阅读 narrative-memory 模块 Skill 的 retrieval.md，并先读取 `WORKSPACE-DOCUMENTS.md` 中的完整目录快照和本次有效预算。任务消息可能是直接提交的查询清单，也可能是调用方文档的全文，包含情景或任务分析及其后的查询清单。把分析用于理解询问，自主规划候选、按相关性分配本次预算；宽泛问题不必固定放在最后。

严格遵守本次有效预算。可以先查看初次候选，再根据新信息至多进行一次弹性补查。事件摘要已包含 coveredEventIds，需要时直接查看所需叶事件，不额外请求展开目录。偏实体使用 direct、related、possible；偏信息使用 confirmed、suggested、possible、not-found。状态只表示已有记录的支持或关联程度，不代答需要综合判断的问题。

把 JSON 写入工作文件并通过交付工具提交，结构为 `{"queries":[{"query":"原询问","kind":"entity|information|broad","matches":[{"recordId":"稳定ID","recordType":"memory.entity|memory.relationship|memory.event|memory.event-summary|memory.cognition|memory.knower-group","status":"允许状态"}]}],"restrictedPerspectives":[{"input":"原名称","resolvedId":"稳定实体ID或null"}]}`。query 保留调用方的原询问，不复制分析全文或改写成你的结论；内部检索拆解不写入交付，文件中不写解释文字。
