# Pi RP Runtime Protocol

This project hosts continuous interactive roleplay. When an RP session is active, treat the selected card pack and the session records as the authoritative fictional context.

Role behavior, creative method, player-agency policy, and output style belong to the selected Agent profile. The shared runtime does not assume that a node performs roleplay prose: it may instead describe, summarize, analyze, validate, or maintain structured state.

## Fixed context order

When a player profile is saved in `settings/common.json`, treat its selected name and description as fixed RP context. Assemble it after stable story/world/rule context and before a single-character card's primary protagonist profile. It contains authored identity and stable traits; the selected Agent decides how those facts apply to its task.

Feature-module prompt order is card-authored behavior. Place every frontend module by `contextOrder`, then every background module by `contextOrder`. Never use `displayOrder`, visible selection, collapsed state, or any other browser preference to reorder Agent context.

## Per-turn record retrieval

When the Web RP bridge marks a turn active, its authoritative context block replaces earlier Pi-session conversation, summaries, tool results, and prior injected RP context for story continuity. Use only fixed card/player context, the current player message, deterministically selected records, and exact records returned by `rp_context_query`.

Card context processors are deterministic runtime code, not Agent tools. Their selected authored fragments appear after fixed card/player/primary-character context and before retrieved records in card-authored `contextOrder`. Treat the supplied fragments as authoritative for that turn; do not emulate or reinterpret their source EJS.

Each agent-selectable catalog must be resolved once before completing the node response that receives it. Follow its module-owned skill and call `rp_context_query` with `select`, `success_empty`, or `not_triggered`. Catalog titles are navigation metadata, not canon. Code performs all exact extraction; never reconstruct a record from a summary. In append mode the query supplements code context. In override mode it replaces code context, with code fallback only when extraction fails.

Every feature-module prompt belongs to that module's `skill/` directory. Shared runtime text may route to a module skill but must not duplicate its detailed definitions, activation rules, or update procedure.

The session-local `draft/` directory is public temporary workspace for RP tasks. It is cleared before each new player turn and is never authoritative story state. An unfinished variable draft may survive an interrupted update task, but it does not become effective context until finalized.

When a card has a native variable module, player-visible prose is completed and saved first. A post-narrative variable-update task then receives the complete effective variable state, reads the module skill, may call `rp_variable_update` repeatedly, and must call `rp_variable_finalize`. Code validates the concentrated draft and reports only failed variable operations; the Agent uses the full state and authored skill to reason about relationships. Successful finalization saves one complete snapshot bound to the AI message. Variable changes affect the next creative turn.

When a module skill authorizes Agent catalog enrichment, use `rp_catalog_update` only after reading exact records. Generated catalog text is navigation metadata, not fictional canon, and must respect the module's information-boundary rules.
