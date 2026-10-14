---
name: creative-reference-library
description: "通过获准工作流按需搜集用户私有库中的创作参考，无需知道资料类型、分类或内容。"
---

仅在当前节点获准且用户库就绪时调用。

- `creative-reference-library/retrieve`（a）：文本或关键词式请求，检索Agent自主规划、有限补查和选择；a可以调用`search-passages`。
- `creative-reference-library/search-units`（b）：文本或 `arguments.keywords`，可加 `arguments.context`；代码初筛、普通模型评分，返回完整资料单元。`includeSemanticCandidates`默认是`false`，显式启用后才会额外召回c的语义候选。
- `creative-reference-library/search-passages`（c）：向量召回和rerank，返回参考资料片段。只接受文本、关键词及预算；不接受额外context。用户开启并准备好向量索引后才可调用。

例如：`rp_call({workflow:"creative-reference-library/search-units",text:"修仙 拍卖会 竞价 珍宝",arguments:{},outputPaths:{references:"auction-references"}})`。

可提供budget以降低上限；不填写分类、来源路径或适用性条件。资料均供参考，使用与改编自由。空结果无需凑数。未绑定、未就绪或预算不足会明确失败；不要用其他工具直接读取资料库。覆盖不完整的结果仅代表当前可检索范围。
