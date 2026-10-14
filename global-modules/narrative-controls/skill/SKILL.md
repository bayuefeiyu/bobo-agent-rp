---
name: narrative-controls
description: Explain the current creative requirements prepared with the card's ordinary static creative documents.
---

# 正文创作要求

本模块的 `conversation` 集合保存玩家输入、第0轮开场和正式发布的正文文档。工作流交付的正文历史是这些文档的冻结视图；按当前任务授权读取即可。宿主负责发布、手动编辑的修订及后缀删除，不要直接改写权威记录或 `messages.jsonl` 投影缓存。

每次正文生成及关联成果属于独立尝试。只读取当前任务交付的资料版本，不跨尝试寻找缺失成果。用户手改保留修订，由用户承担对既有成果的影响；不自行启动补算。影响下一轮的平行事件和状态维护宜安排在上一轮结束。

本模块为正文准备本次生效的创作准则。交付的《创作要求》与同一资料目录中的其他创作准则处于同级；按该目录的普通读取规则使用，不因模块来源而提高优先级。

阅读当前任务实际交付的资料即可。前端设置和源资源由代码管理，本模块不向创作 Agent 提供查询或修改设置的工具，也不要求 Agent 自行选择档位。
