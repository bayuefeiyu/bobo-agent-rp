分析与规划仅用于本次工作，不要混入正式产物。

<!-- stage -->
## 分析与初步规划

按【可用资料】中的读取要求取得相关资料，结合最近正文与玩家本轮输入，分析当前情景并形成初步剧情规划。完成后单独调用 `rp_task_next({})`。

<!-- stage -->
## 导演调整

如果当前节点开放了导演的前置调整入口，调用一次；该调用需要的工作区资料由运行时提供。取得正文指导后，结合指导修正规划。没有该入口时直接推进。完成后单独调用 `rp_task_next({})`。

<!-- stage -->
## 正文创作与交付

先综合已有资料与导演指导，明确本轮大致创作方向。若当前节点开放 `creative-reference-library/search-units`，在具体情节设计前调用一次，以简短文本或宽泛关键词搜集创作参考，可在 `arguments.context` 附少量上下文；例如 `rp_call({workflow:"creative-reference-library/search-units",text:"修仙 拍卖会 竞价 珍宝",arguments:{},outputPaths:{references:"creative-references"}})`。阅读返回目录中的 DOCUMENTS.md 及相关资料，自主决定取舍与改编。资料仅供参考，不自动成为本卡设定、剧情事实或创作约束。没有开放该入口时跳过；空结果正常继续，本节点已调用过时复用返回资料，不追加检索。

根据创作要求完成本轮正文。把正文写入工作文件，通过交付工具提交 narrative。完成后单独调用 `rp_task_next({})`；工具报告所有阶段均已发放后，再调用 `rp_node_complete({})`。
