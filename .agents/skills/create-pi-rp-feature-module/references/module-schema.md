# Pi RP feature-module package v4

Read the authoritative [data protocol](../../design-pi-rp-data/references/protocol.md), [modeling guidance](../../design-pi-rp-data/references/modeling.md), and [retrieval/view guidance](../../design-pi-rp-data/references/retrieval-and-views.md) before editing a module contract.

## Package layout

```text
<module>/
├── module.json
├── data-contract.json
├── collections/<collection-id>/initial/
├── frontend-view.json
├── runtime/
└── skill/
    ├── SKILL.md
    └── references/
```

Create only module v4 packages. `data-contract.json` is the sole machine-readable data declaration. Initial data belongs below the declared collection. Runtime processors are optional. The module Skill owns feature semantics, activation, field meaning, retrieval guidance, and update rules.

Do not create `storage.json`, `retrieval-policy.json`, `catalog.json`, post-narrative storage engines, variable engines, or legacy envelope formats. A frontend view reads the module's collections and never owns a parallel store.

For a card-local module, use safe card-relative paths and register `module.json` in `manifest.feature_modules`. For a project-global module, keep the package self-contained and include import guidance without linking it as a live runtime dependency. Imported copies become card-owned and do not synchronize with the source package.
