---
name: create-pi-rp-feature-module
description: Analyze, propose, and after confirmation create or upgrade a Pi RP unified-data feature module in an explicitly named converted card or project-global module target, with scoped workflow access and an optional frontend. Project-global targets require an explicit user request and are never inferred from card customization.
---

# Create Pi RP Feature Module

Run this development Skill from the repository root. Package the requested function as module v4 with data-contract v1, using `design-pi-rp-data` for data ownership and runtime behavior.

Read [../design-pi-rp-data/SKILL.md](../design-pi-rp-data/SKILL.md) completely and follow its development-scope boundary. Then read [references/module-schema.md](references/module-schema.md). Read [references/module-workflows.md](references/module-workflows.md) when any node reads or changes module data. For embedded deterministic prompt logic, also read [references/context-processors.md](references/context-processors.md).

## Target boundary

Resolve one explicit target before editing:

- a named card under `play/cards/<card-id>/`; or
- a project-global module under `global-modules/<module-id>/` when the user explicitly requested a global module.

A card-local request never modifies root Skills, templates, global modules, other cards, shared runtime, or sessions. Do not write global-promotion notes or reusable-candidate markers into the card. A global-module request does not update cards that imported an earlier copy. Session migration is separate explicit work.

## Proposal gate

An ordinary create, convert, or upgrade request authorizes analysis and a proposal, not edits. Inspect the target, relevant rules, existing modules, workflows, and source function. Present a concise proposal covering:

1. target and module boundary, included collections and record types, activation/update semantics, and unsupported behavior;
2. authoritative fields, indexes, stable IDs, storage/partition choice, and initial data;
3. named `rp` and custom return views, budgets, and information boundaries;
4. capabilities and the narrower grants/views for each workflow node;
5. frontend/background surface, view regions, module-Skill ownership, and context/display order;
6. workflow trigger, dependencies, outputs, commits, retry/blocking behavior, and Agent/model references.

Offer to discuss only meaningful choices. Do not edit until the user confirms the complete proposal or explicitly requested direct execution. When a surrounding conversion or card-upgrade Skill already owns a confirmation gate, inherit that gate rather than asking twice. If later discovery materially changes ownership, access, workflow, or UI, pause and reconfirm.

## Design and packaging rules

- Use the data-design Skill's protocol and modeling rules rather than recreating them here.
- Keep all module prompts under `<module>/skill/`. Skills explain semantics and correct tool use but do not grant permission.
- Keep frontend views independent from Agent views and data ownership.
- Persistent changes use explicit unified-change-batch outputs and the common transaction service. Never edit live authority under `sessions/` during creation.
- Deterministic normalization or specialized operations may use module-local processors. Creative judgment remains in authored Agent nodes.
- Durable queryable results go to module collections. Intermediate files use declared workflow outputs and scopes; process records remain user-only.

## Build and verify

Create `module.json`, `data-contract.json`, initial collection files as needed, `frontend-view.json`, the module Skill, optional runtime processors, and the required workflow nodes. Register a card-local module in that card's manifest. A project-global module remains a reusable source package and is not inserted into any card without an explicit import request.

For a card-local target, run:

```bash
python .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
```

Test relevant indexes, views, granted and denied capabilities, explicit and node-end commits, idempotency/conflicts, processor failures, frontend rendering, suffix pruning, and workflow dependencies. Report only the target's implemented ownership boundary, structure, behavior, validation, and unsupported source behavior.
