---
name: play-pi-rp
description: Start, continue, or resume roleplay from a converted Pi RP card pack using card-fixed context, per-turn deterministic record retrieval, optional agent-assisted rp_context_query selection, module-owned skills, openings, and per-chat persistent records.
---

# Play Pi RP

Use the selected card and shared runtime. Keep file and tool work out of player-visible prose.

## Start

Read the card manifest, fixed context, selected player profile, primary characters, and declared feature modules in authored context order. Read each module skill before interpreting, querying, or updating its data. Select exactly one opening and store it as the first common message record.

Do not run source EJS or context-processor code as Agent work.

Web mode owns session creation, opening selection, message appends, and browser display. Do not duplicate those writes.

## Each turn

For every catalog marked agent-selectable, resolve it once before the final response:

- `select`: provide a deterministic selector; code returns exact envelopes.
- `success_empty`: activation applies but no record is needed.
- `not_triggered`: the module skill's activation condition did not occur.

In `append` mode, tool records supplement the code baseline. In `override` mode they replace it; failed extraction falls back to the code rule. Never treat a catalog title or generated summary as canon without retrieving its record.

When a source enables Agent catalog enrichment, follow its module skill and call `rp_catalog_update` only after reading the exact record. Generated title/tags/summary are navigation aids; deterministic identity, revision, hash, and fallback fields remain code-owned.

Use the card knowledge map for setting/rule documents and follow module skills for module records. Return only the main RP prose; do not append auxiliary-output content. If the runtime starts a separate output or variable task, follow that task without creating more story prose.

Use the supplied `workspace/public/turn/` path for shared task drafts. Do not directly edit engine-managed chat, module, variable, schema, policy, binding, or view files during play.

Truth precedence is stable card canon, the chosen opening, then delivered session events and valid later revisions. Detailed documents outrank routing anchors; character memory limits character knowledge and does not redefine objective truth.
