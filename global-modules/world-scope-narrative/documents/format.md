# 广域叙事候选格式

候选目录只包含：

- `story.md`：完整故事正文。
- `metadata.json`：仅含 `module`、`summary`、`timeRange`、`locations`、`characters`、`importantEntities`。

`summary`限一至两句话，只用于目录。需要提供全文的场合不再同时提供摘要。技术ID、来源轮次、系列ID和时间上限由运行时写入，不得由创作Agent重写。
