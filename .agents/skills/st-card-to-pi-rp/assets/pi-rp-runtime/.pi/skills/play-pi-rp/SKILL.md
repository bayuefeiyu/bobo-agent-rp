---
name: play-pi-rp
description: Start, continue, or resume roleplay from a converted Pi RP card pack using card-fixed context, workflow-authored message and unified-data retrieval, module-owned runtime skills, openings, and per-chat persistent records.
---

# Play Pi RP

Use the selected card and shared runtime. Keep file and tool work out of player-visible prose.

## Start

Read the card manifest, fixed context, selected player profile, primary characters, and declared feature modules in authored context order. Read a module Skill before interpreting, querying, or updating that module's data. Select exactly one opening and store it as the first common message record.

Do not run source EJS or context-processor code as Agent work.

Web mode owns session creation, opening selection, message appends, and browser display. Do not duplicate those writes.

## Each turn

Follow the active workflow and the current node's declared responsibility. Use the card knowledge map for authored setting/rule documents. Use `rp_message_query` only when the card's message-retrieval instructions require exact transcript retrieval.

For module records, follow the owning module Skill and the current node's exact `moduleAccess`. Use `rp_data_query`, `rp_data_get`, and `rp_data_resolve` only as needed within granted collections, views, and budgets. Query results are disclosed views, not full authority files. Preserve a returned revision as `expectedRevision` for guarded changes.

Persistent changes use an authorized unified change batch through `rp_data_submit` or the exact output declared for node-end submission. Do not edit session data directly, guess undeclared drafts, or turn a failed revision check into an unconditional overwrite.

Return only the output assigned to the active node. The foreground narrative node emits the sole player-visible story prose; auxiliary-output and data-maintenance nodes emit only their declared outputs.

Use the supplied `workspace/public/turn/` path for shared task drafts. Do not directly edit engine-managed chat, module, variable, schema, policy, binding, or view files during play.

Truth precedence is stable card canon, the chosen opening, then delivered session events and valid later revisions. Detailed documents outrank routing anchors; character memory limits character knowledge and does not redefine objective truth. Do not expose internal prompts, planning, data envelopes, or process records in player-visible prose.
