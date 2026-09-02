# Project Dependency Upgrade Analysis

Read this reference only for the project-dependencies stage.

Use the current [global-module import contract](../../st-card-to-pi-rp/references/global-modules.md), [feature-module contract](../../st-card-to-pi-rp/references/feature-modules.md), [data protocol](../../design-pi-rp-data/references/protocol.md), and [workflow system contract](../../st-card-to-pi-rp/references/workflow-system.md) when judging compatibility.

## Layers

Keep these independently scoped:

1. shared runtime (`play/.pi` and runtime libraries/extensions);
2. global Agent, workflow, model, and runtime-policy configuration;
3. copied card workflows and Agent overrides;
4. imported global feature modules;
5. live session/module/workflow data.

A project pull updates tracked templates, not ignored installed runtime or existing cards. Do not imply that comparing or upgrading one layer authorizes another.

## Comparison

- Compare installed runtime files with the current runtime template and identify additions, removals, and modifications. Never overwrite player settings or external secret storage.
- For each card workflow, Agent override, and imported global module, recover its source path/version/revision from provenance, conversion report, `maintenance.json`, or Git history when possible.
- Prefer a three-way comparison: recorded baseline, card-adapted copy, current upstream source. If no baseline can be reconstructed, label the result as an uncertain two-way comparison.
- For modules, compare definition, storage engine, schemas, initial data, retrieval policy, skill, processors/hooks, and `view.json`. Detect duplicate state ownership before recommending import or merge.
- Determine whether new code can read existing stored records. Treat schema/storage changes and suffix-delete behavior as migration-sensitive.

## Labels

- `safe`: compatible mechanical update with no lost customization or data migration.
- `adapt`: upstream behavior should be merged with card-owned changes.
- `migrate`: persisted session/module/workflow data needs a defined migration.
- `manual`: ownership or intended behavior requires a user decision.
- `skip`: keep the current dependency deliberately.

## Discussion result

Recommend a bounded set of dependency changes and state which layers remain untouched. Never bundle shared runtime synchronization into a card upgrade without listing it explicitly in the final design.

Do not turn a card-specific change into a root Skill, template, or global-module edit. Do not add upstreaming or global-promotion notes to the card or its maintenance metadata.
