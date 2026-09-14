# 近场叙事候选格式

在工作区指定目录写入：

- `candidate/story.md`：仅完整故事正文。
- `candidate/metadata.json`：仅包含 `module`、`summary`、`timeRange`、`locations`、`characters`、`importantEntities`。

`summary` 只用一至两句话概括本篇实际发生的主要内容，不分析主题、隐藏动机或未来走向。`importantEntities` 每项为 `{ "name": "...", "unique": true|false }`。不要自行填写故事 ID、系列 ID、正文轮次或审核信息。
