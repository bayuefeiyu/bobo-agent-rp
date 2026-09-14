---
name: world-scope-narrative
description: Create one director-assigned world-scope story candidate, then let the director review and the deterministic publisher commit it.
---

# 广域叙事模块

本模块创作主线之外、遍及卡片世界且通常值得传播的独立故事。

1. 先运行 `prepare-story-context` 或直接运行 `create-story-candidate`。
2. 候选阶段只读，不得把候选当作世界事实。
3. 每次仅写一篇候选，只允许一次记忆检索。
4. 候选交由导演统审；发布只能调用内部 `publish-reviewed-story`。
5. 正文与其他消费者通过 `export-recent-stories` 或普通记忆检索读取已发布故事。
