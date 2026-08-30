---
name: play-pi-rp
description: Start, continue, or resume roleplay from a converted Pi RP card pack using card-fixed context, per-turn deterministic record retrieval, optional agent-assisted rp_context_query selection, module-owned skills, openings, and per-chat persistent records.
---

# Play Pi RP

Use the selected card and shared runtime. Keep file and tool work out of player-visible prose.

## Start

Read the card manifest, fixed context, selected player profile, primary characters, and declared feature modules in authored context order. Read each module skill before interpreting, querying, or updating its data. Select exactly one opening and store it as the first common message record.

The runtime evaluates declared `before-narrative` context processors from frozen current state and injects only their selected authored fragments. The Agent does not run source EJS, choose processor branches, or treat processor code as persistent state.

Web mode owns session creation, opening selection, message appends, and browser display. Do not duplicate those writes.

## Each turn

The Web bridge replaces earlier Pi work context with a fresh authoritative block containing only fixed context, the current user message, code-selected records, compact catalogs for agent-enabled sources, and records returned by `rp_context_query`.

For every catalog marked agent-selectable, resolve it once before the final response:

- `select`: provide a deterministic selector; code returns exact envelopes.
- `success_empty`: activation applies but no record is needed.
- `not_triggered`: the module skill's activation condition did not occur.

In `append` mode, tool records supplement the code baseline. In `override` mode they replace it; failed extraction falls back to the code rule. Never treat a catalog title or generated summary as canon without retrieving its record.

When a source enables Agent catalog enrichment, follow its module skill and call `rp_catalog_update` only after reading the exact record. Generated title/tags/summary are navigation aids; deterministic identity, revision, hash, and fallback fields remain code-owned.

Use the card knowledge map for setting/rule documents and follow module skills for module records. Compose only the exact main RP prose and let the Web bridge save it. Do not append content owned by an auxiliary-output module to the chat body. After the prose is saved, the runtime resolves all `post-narrative-output` modules in one hidden task through `rp_output_update` and `rp_output_finalize`; emitted records bind to that AI message. A native variable module then runs its own post-narrative task: it receives every effective variable, may call `rp_variable_update` repeatedly, and finishes with `rp_variable_finalize`; one complete snapshot is bound to the same AI message and affects the next creative turn.

The per-chat `draft/` directory is shared temporary workspace for all tasks and is cleared before each new player turn. It is not story state. Interrupted auxiliary-output and variable drafts may remain pending for `/rp-outputs-resume` or `/rp-vars-resume`; neither becomes effective until finalization succeeds.

## Record truth and storage

`messages.jsonl` and module record logs use the common version 1 envelope. `binding.messageId` lets suffix deletion cascade to dependent module records. Session context receipts under `context/receipts/` record automatic selections, Agent queries, fallbacks, and unresolved sources.

```text
sessions/<card-id>/<session-id>/
├── session.json
├── messages.jsonl
├── catalog/messages.json
├── context/receipts/
├── draft/
└── modules/<module-id>/
    ├── binding.json
    ├── records.jsonl
    ├── snapshot.json
    └── catalog.json
```

Only enabled module storage files exist. Never edit `binding.json`, card definitions, retrieval policies, schemas, or views during play.

Truth precedence is stable card canon, the chosen opening, then delivered session events and valid later revisions. Detailed documents outrank routing anchors; character memory limits character knowledge and does not redefine objective truth.
