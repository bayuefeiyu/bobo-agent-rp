# Module-owned dynamic context processors

Use a deterministic context processor when native code can decide which authored module prompt fragments apply before narrative generation. Do not use one for persistent updates, display logic, or semantic relevance that requires Agent judgment.

Register each card-relative processor definition in `manifest.context_processors`. Schema version 1 contains exactly:

```json
{
  "schemaVersion": 1,
  "id": "quest-stage",
  "description": "Select the active authored quest-stage rules.",
  "phase": "before-narrative",
  "contextOrder": 420,
  "entryFile": "features/quests/runtime/context/quest-stage.mjs",
  "dependencies": {
    "currentInput": false,
    "opening": false,
    "player": false,
    "messages": "none",
    "variables": "none",
    "modules": ["quests"],
    "settings": false
  },
  "fragments": [
    {
      "id": "active-stage",
      "title": "进行中的任务规则",
      "file": "features/quests/skill/references/stages/active.md"
    }
  ],
  "failure": "error"
}
```

Paths are safe POSIX paths relative to the card root. `phase` is only `before-narrative` in version 1. `messages` and `variables` are `none` or `all`; `modules` lists exact module IDs. The entry exports `selectContext(input)` or default and returns exactly `{include: string[]}` using unique declared fragment IDs.

The input is frozen and contains `schemaVersion`, `card`, `turn`, `currentInput`, `openingId`, `player`, `messages`, `variables`, `modules`, and `settings`; undeclared values are empty. The processor performs no persistent writes or prompt mutation. Put module-specific prompt fragments under the module's `skill/` directory, while executable code stays under its `runtime/` directory. The processor selects authoritative files rather than embedding or copying their prose.

Use code for exact conditions. Keep semantic activation in the module skill and use Agent selection when interpreting narrative meaning is unavoidable. Split source EJS that combines prompt output and side effects: selection belongs here, persistent changes remain in the module update workflow.
