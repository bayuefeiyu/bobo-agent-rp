# Module-owned dynamic context processors

Use a deterministic context processor when code can select authored prompt fragments before narration. It never persists state or performs semantic judgment. Read the data-design Skill's [retrieval](../../design-pi-rp-data/references/retrieval-and-views.md) and [workflow access](../../design-pi-rp-data/references/workflow-access.md) guidance first.

Register the card-relative definition in `manifest.context_processors`. Schema version 2 contains exact fixed inputs plus named unified-data queries:

```json
{
  "schemaVersion": 2,
  "id": "quest-stage",
  "description": "Select active quest-stage rules.",
  "phase": "before-narrative",
  "contextOrder": 420,
  "entryFile": "features/quests/runtime/context/quest-stage.mjs",
  "dependencies": {
    "currentInput": false,
    "opening": false,
    "player": false,
    "messages": "none",
    "dataQueries": [{
      "id": "active-quests",
      "moduleId": "quests",
      "collectionId": "entries",
      "recordTypes": ["quest.entry"],
      "where": { "status": { "eq": "active" } },
      "view": "processor",
      "limit": 10
    }],
    "settings": false
  },
  "fragments": [{
    "id": "active-stage",
    "title": "进行中的任务规则",
    "file": "features/quests/skill/references/stages/active.md"
  }],
  "failure": "error"
}
```

The narrative workflow node must have query authority and the named view for every `dataQueries` entry. Runtime limits and node budgets still apply. The frozen processor input contains `schemaVersion`, declared fixed inputs, `data` keyed by query ID, and settings. The entry exports `selectContext(input)` or default and returns exactly `{include: string[]}` with unique declared fragment IDs.

Keep fragments under the module Skill and executable code under module runtime. Exact branching belongs here; semantic relevance belongs in an Agent node or module Skill; persistent changes use unified batches.
