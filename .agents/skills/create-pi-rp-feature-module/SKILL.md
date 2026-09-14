---
name: create-pi-rp-feature-module
description: Analyze, propose, and after confirmation create or upgrade a Pi RP data, resource, or hybrid feature module in an explicitly named converted card or project-global module target, with scoped workflow access and an optional data-backed frontend. Project-global targets require an explicit user request and are never inferred from card customization.
---

# Create Pi RP Feature Module

Run this development Skill from the repository root. Package the requested function as module v6 (`data`, `resource`, or `hybrid`) with owned Workflow v3 definitions. Use data-contract v1 only for data/hybrid ownership; never invent a collection for static authored resources.

Always follow the repository development-scope boundary and read [references/module-schema.md](references/module-schema.md). For data/hybrid modules, also read [../design-pi-rp-data/SKILL.md](../design-pi-rp-data/SKILL.md) completely. Read [references/module-workflows.md](references/module-workflows.md) whenever the module owns workflows. For embedded deterministic prompt logic, also read [references/context-processors.md](references/context-processors.md).

## Target boundary

Resolve one explicit target before editing:

- a named card under `play/cards/<card-id>/`; or
- a project-global module under `global-modules/<module-id>/` when the user explicitly requested a global module.

A card-local request never modifies root Skills, templates, global modules, other cards, shared runtime, or sessions. Do not write global-promotion notes or reusable-candidate markers into the card. A global-module request does not update cards that imported an earlier copy. Session migration is separate explicit work.

## Proposal gate

An ordinary create, convert, or upgrade request authorizes analysis and a proposal, not edits. Inspect the target, relevant rules, existing modules, workflows, and source function. Present a concise proposal covering:

1. target, `moduleKind`, module boundary, static resources and/or collections and record types, activation/update semantics, and unsupported behavior;
2. authoritative fields, indexes, stable IDs, storage/partition choice, and initial data;
3. named `rp` and custom return views, budgets, and information boundaries;
4. capabilities and the narrower grants/views for each workflow node;
5. frontend/background surface, view regions, module-Skill ownership, and context/display order;
6. internal/external workflow boundary, caller interface, Agent exposure, dependencies, outputs, commits, top-level integration trigger/blocking behavior, and Agent/model references; if the feature affects creative work, identify its pre-creative, post-creative, and/or memory-backed contribution modes, including how a later turn explicitly materializes any post-turn result.

Offer to discuss only meaningful choices. Do not edit until the user confirms the complete proposal or explicitly requested direct execution. When a surrounding conversion or card-upgrade Skill already owns a confirmation gate, inherit that gate rather than asking twice. If later discovery materially changes ownership, access, workflow, or UI, pause and reconfirm.

## Design and packaging rules

- Use the data-design Skill's protocol and modeling rules rather than recreating them here. Stable authored lore, rules, guidance, style, format, and references may use a resource catalog; mutable session authority uses collections.
- Keep all module prompts under `<module>/skill/`. Skills explain semantics and correct tool use but do not grant permission.
- Keep frontend views independent from Agent views and data ownership.
- Persistent changes use explicit unified-change-batch outputs and the common transaction service. Never edit live authority under `sessions/` during creation.
- Deterministic normalization or specialized operations may use module-local processors. Creative judgment remains in authored Agent nodes.
- Durable queryable results go to module collections. Intermediate files use declared workflow outputs and scopes; process records remain user-only.
- Modules expose only complete workflows. Every owned workflow is listed in `module.json.workflowFiles`, has no trigger, and ends in one `workflow-return`; top-level integration uses synchronous `call` nodes instead of graph splicing.
- A module that affects creative work exposes the required material as declared workflow file or directory exports. Classify its integration as pre-creative, post-creative, memory-backed, or a combination; specify ordering, triggers, durable ownership, and the explicit workflow that materializes cross-turn content. Do not rely on a top-level trigger or retained workspace to inject files into a later turn automatically.
- For every Agent node, list only the exact module workflows it may call. Set a target's `agentCallable` deliberately. If an Agent can call a `module-internal` workflow, explicitly warn the creator during design that successful authority changes or external effects survive a later parent/正文 failure; keep that warning out of the RP Agent's runtime prompt.

## Build and verify

Create `module.json`, the required `data-contract.json` and/or resource catalog, initial collection/resource files as needed, a frontend view only for frontend data/hybrid modules, the module Skill, optional runtime processors, and the required complete module workflows. Register a card-local module in that card's manifest. A project-global module remains a reusable source package and is not inserted into any card without an explicit import request.

For a card-local target, run:

```bash
python .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
```

Test relevant indexes, views, granted and denied capabilities, explicit and node-end commits, idempotency/conflicts, processor failures, frontend rendering, suffix pruning, and workflow dependencies. Report only the target's implemented ownership boundary, structure, behavior, validation, and unsupported source behavior.
