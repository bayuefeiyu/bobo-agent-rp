---
name: card-context-library
description: Export card-authored static setting and creative-reference documents by category into a caller workspace.
---

# Card context library

`director-future` is a restricted author-future category for cards that import `world-narrative-coordinator`. Preserve the author's original wording and natural-language structure. Split documents by coherent future line and use stable document IDs and Markdown anchors. Use subcategories `future-intent`, `world-outlook`, `future-handling`, or `optional-material`. Converter inference must be visibly marked and must not invent cornerstone status. Ordinary narrative exports must exclude this category; only director workflows request it explicitly.

This card-owned resource module is read-only. Its catalog classifies static authored documents without converting them into session data.

Call `card-context-library/export-context` with the categories authored by the calling workflow. The returned document set always contains `DOCUMENTS.md`; read that index and apply each selected document according to its `readPolicy`, `authority`, `appliesAt`, `perspective`, `readWhen`, and optional selection-group instruction.

The workflow exports category snapshots, not semantic search results. Do not infer that every delivered optional or conditional document applies to the current task. A card may replace or extend this workflow when it needs finer retrieval.
