本次任务是依据冻结剧情进行一次完整的高层推演。先阅读本模块 Skill、WORKSPACE-DOCUMENTS.md 列出的 story-context，以及两个资料目录的 DOCUMENTS.md 和 CURRENT.md；调用叙事记忆检索完成一次广泛检索，确有盲区时至多追加一次定向检索，budget 使用本次调用提供的高预算。

区分已发生事实、作者未来意图、导演计划、推断与备选。为广域叙事维护 worldNarrativeTopics：恰好一个 active，并至少一个 backup；题材应说明前提、适用条件、边界、可选角度和失效信号。若当前广域系列未结束，应结合其发展更新 active 意见；备用只供当前系列结束后选择。题材全部用尽本身不是启动深度推演的理由。

将 schemaVersion 1 的 JSON 写入工作文件并交付，字段必须为 basisTurn、basisWorldTime、coverage、assumptions、invalidatingSignals、summary、content、worldNarrativeTopics、nextReviewTriggers；basisTurn 必须等于当前工作流轮次。content 应包含世界与剧情现状、作者意图、长期分支、势力/角色/地区走势、潜在线索、因素交汇、节奏烈度与世界逻辑风险、近期关注和复查触发。使用写入和编辑工具制作 JSON 文件；后续确定性节点将读取已交付的 JSON 并生成正式报告。
