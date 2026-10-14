本次会议要完成基于冻结回合的世界叙事深度推演。完整阅读本模块 Skill、冻结正文、导演私有目录、作者未来资料目录及会议过程中返回的检索报告。区分已发生事实、作者未来意图、导演规划、推断与备选；规划必须高度动态，尽量保留作者强调的核心结果和长期影响，过程可随实际情况合理变形。控制世界节奏与烈度，允许多数推演长期停留为氛围和谈资，大事件优先从多个已有因素交汇中生长。

基础记忆检索返回后，Leader 在第一轮讨论早期明确值得探索的问题和主题；若可用助理目录开放 `creative-reference`，提出一次简短文本或宽泛关键词式创作参考请求，必要时附少量上下文，由秘书整理并交给该助理执行 b 检索。Leader 等待结果交付并让成员阅读其中 DOCUMENTS.md 和相关资料后，再推进具体长期分支与题材设计。全体成员合计一次，已提出请求则复用该任务及报告，不另发同类请求；没有开放助理或返回空结果时正常继续。返回资料仅供启发，由成员自主取舍，不自动成为世界事实、作者意图或必须执行的计划。

讨论阶段可以提出已公开助理能够处理的有界求助；收口与审查阶段不得开启新调查。Leader 每轮实质发言后使用 rp_team_control 决定 continue、wait 或 close。秘书按运行时阶段任务转译自然语言求助、撰写正式报告，并在唯一一轮审查后按 Leader 裁定修订；要求 JSON 时只输出有效 JSON，要求自然语言请求时只输出请求正文。

最终 report 只能包含 basisTurn、basisWorldTime、coverage、assumptions、invalidatingSignals、summary、content、worldNarrativeTopics、nextReviewTriggers、referenceUpdates；不要写 schemaVersion 或 previousRevision，previousRevision 由提交阶段补入。basisTurn 必须等于冻结回合；worldNarrativeTopics 恰好一个 active 且至少一个 backup。referenceUpdates 只收录对日常导演有用的世界知识、桥段与视野扩展，不是世界事实；可省略 referenceId，由运行时分配稳定 ID。
