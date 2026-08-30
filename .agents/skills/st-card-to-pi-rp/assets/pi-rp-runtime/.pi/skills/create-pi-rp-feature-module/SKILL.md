---
name: create-pi-rp-feature-module
description: Analyze, propose, and after confirmation create or upgrade a card-local Pi RP feature module, including native variable modules, using module version 3, storage version 2, common records, module-owned prompts, declarative Web views, and per-chat storage.
---

# Create Pi RP Feature Module

Package the user's function or an existing mature skill into this project's module contract. The user or source skill decides the feature; this skill decides compliant file placement, record shape, retrieval, prompt ownership, display, and validation.

Read [references/module-schema.md](references/module-schema.md) completely before editing a card.
When the source function uses EJS or other embedded prompt code, also read [references/context-processors.md](references/context-processors.md).

## Mandatory proposal and confirmation gate

An ordinary request to create, convert, or upgrade a module authorizes read-only analysis and proposal preparation, not edits to the card or its sessions. Inspect the target card, relevant authored rules, existing modules, and any source skill first. Do not create module files, change the manifest, or migrate live data until the user explicitly confirms formal creation.

Present a concise proposal covering:

1. the feature boundary, activation conditions, updates, and behavior that will remain unsupported;
2. frontend or background surface and the proposed Web regions;
3. `record-log`, `snapshot`, or `hybrid` storage and the important `data` fields;
4. default/custom code retrieval, Agent disabled/append/override behavior, and catalog enrichment;
5. module-skill prompt placement, `contextOrder`, `displayOrder`, and any interaction with existing modules.

End with only the meaningful choices that may need discussion and offer to handle them one by one. Unless the user already gave explicit advance confirmation to start directly, end the turn after the proposal and wait without editing the card. If the user selects one, resolve it, update the affected portion of the proposal, and guide them to the next unresolved item or final confirmation. Do not force discussion of implementation details the user delegates.

Do not start formal edits until the user explicitly says to begin, confirms the current proposal, or gives equivalent unambiguous authorization. Agreement with one item is not approval of the whole module. An initial instruction to skip discussion and start directly counts as advance confirmation, but still communicate the concise proposal before making material changes. If later discovery materially changes the confirmed behavior, storage, retrieval, or visible UI, pause and reconfirm.

## Preserve source behavior

Read the target card, its manifest and relevant authored rules. When adapting a skill, read that skill and its directly required references. Preserve its terminology, invariants, activation/update conditions, and durable outputs where compatible. Do not invent features or claim unsupported hooks and tools work.

All prompts concerning this module belong inside `features/<module-id>/skill/`. Do not place module prompts in shared runtime files, card core prompts, or separate `fixed.md`/`definition.md` files. Shared fixed context may only identify the module, its skill path, storage path, and retrieval mode.

## Design decisions

1. Choose `surface`: frontend for a visible Web rail, background for identical persistence/context behavior without Web display.
2. Choose `record-log` for addressable history, `snapshot` for one replaceable current state, or `hybrid` only when both are required.
3. Define each record's `data` JSON Schema. Use the common envelope for identity, revision, message/turn binding, tags, and sequence.
4. Use storage `engine: null` for ordinary modules. For a native variable module, read the variable-engine section in the schema reference, use hybrid full-snapshot history, preserve the source variable semantics rather than legacy MVU output syntax, and design exact named/path references. For a source-authored output outside the main narrative, use frontend record-log storage with `engine: { "kind": "post-narrative-output" }`; keep activation and formatting in the module skill and emit `{content}` only through the hidden post-narrative task.
5. Choose code retrieval. Default means all message records and the latest one module record. Custom means an authored deterministic selector.
6. Choose agent retrieval independently: `disabled` for code only, `append` for code plus `rp_context_query`, or `override` for agent selection with code fallback on extraction failure. Put activation and `not_triggered` guidance in the module skill.
7. Choose catalog Agent mode. Deterministic code always supplies the compact fallback catalog. When Agent enrichment is enabled, put exact `rp_catalog_update` triggers, allowed titles/tags/summaries, and information-boundary rules in the module skill.
8. Choose `contextOrder` for model behavior and `displayOrder` for Web presentation. Browser settings never affect context order. Background modules sort after frontend modules.
9. If exact code conditions select module-owned prompt fragments before narrative generation, create a card context processor. Keep its executable code under the module runtime, its selected text under the module skill, and every persistent change in the ordinary module update workflow.

## Build and verify

Create the version 3 structure with storage version 2, register `module.json` in the card manifest, and never write live files under `sessions/`. Keep initial records empty unless the card explicitly authors initial facts. Build a compact declarative `view.json`; it reads `{records, snapshot}`. Variable modules additionally define complete default state, opening overlays, stable bindings, complete-state update rules, and optional deterministic hooks. Their baseline frontend view is one `json` region at `snapshot.data.state`, so the complete effective state remains inspectable without card-specific JavaScript. Every post-narrative variable update receives all effective variables; narrative turns receive only authored fixed references plus exact on-demand projections.

From the `play/` runtime root, run `python ../.agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py cards/<card-id>`. Confirm record-envelope validity, retrieval mode, skill routing, Web display, and suffix-delete cascade behavior.
For a context processor, also test every branch boundary, declared dependency isolation, known-fragment enforcement, failure policy, and the recorded selection receipt.

Finish by reporting the surface, storage kind, context/display order, code profile, agent mode, data ownership boundary, validation result, and any source behavior that could not be represented.
