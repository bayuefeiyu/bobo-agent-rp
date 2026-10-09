# Pi RP feature-module package v7

Read the authoritative [data protocol](../../design-pi-rp-data/references/protocol.md), [modeling guidance](../../design-pi-rp-data/references/modeling.md), and [retrieval/view guidance](../../design-pi-rp-data/references/retrieval-and-views.md) before editing a module contract.

## Package layout

```text
global-modules/<module-id>/                 # reusable source package
├── module.json
├── data-contract.json                         # data/hybrid only
├── collections/<collection-id>/initial/       # data/hybrid only
├── catalog.json                               # resource/hybrid only
├── documents/                                 # resource/hybrid only
├── frontend-view.json                         # frontend data/hybrid only
├── agents/<agent-id>/agent.json
├── prompts/                                    # module-owned prompt files
├── runtime/
├── workflows/<workflow-id>/workflow.json
└── skill/
    ├── SKILL.md
    └── references/
```

Create only module v7 packages. `moduleKind` is `data`, `resource`, or `hybrid`. `module.json.agentFiles` explicitly registers every Agent profile owned by the module, and `module.json.workflowFiles` lists every complete workflow owned by the module. Data/hybrid modules use `data-contract.json`; resource/hybrid modules use a resource catalog whose Markdown documents are indivisible delivery units. Initial data belongs below the declared collection. Module-local runtime processors and code entry files are optional. The module Skill owns feature semantics, activation, field meaning, retrieval guidance, and update rules.

All v7 manifests keep the exact field set, including `agentFiles` and `workflowFiles`. Use null for inapplicable files: resource-only modules set `dataContractFile` and `frontendViewFile` to null; data-only modules set `resourceCatalogFile` to null; background modules set `frontendViewFile` to null. Only data/hybrid modules may use `surface: "frontend"`.

A module owns every Agent, workflow, node, code entry file, and prompt that it ships. Keep module-local executable node entry files under `runtime/`; `entryFile` and `promptFile` values are module-relative. Workflow v4 entry kinds (`foreground`, `turn-background`, and `global-background`) are module-owned entry workflows and may have triggers without a required `workflow-return`; `module-external` and `module-internal` workflows have no trigger and exactly one `workflow-return`. Runtime references use normalized `module-id/local-id` values. The common engine, tools, system models, and cross-module prompt templates are public host resources and stay outside the package, so a module need not run independently and must not copy those shared components. When something outside the module drives it, record that in an optional `dependencies.json` next to `module.json`, with what the host provides and what decoupling would cost. That dependency is invisible to every structural check, so the record is the only way an importer can disclose it; see the converter's [global-modules.md](../../st-card-to-pi-rp/references/global-modules.md) for the format.

A `module-internal` workflow normally omits `writeLocks` and receives the legacy whole-owner-module lock. Declare a non-empty list of exact owner-module collection locks only when the data contract intentionally separates independent write domains; every writable node capability must be covered by a whole-module or matching collection lock. If the workflow declares `instancePolicy.mode: "multiple"`, it must also declare a stable `dedupeKey`, a positive finite `maxConcurrentInstances`, and only exact owner collection locks. Locks coordinate workflow lifetimes and do not grant data authority.

Do not create legacy data catalogs, `storage.json`, per-module retrieval-policy files, post-narrative storage engines, variable engines, or legacy envelope formats. `catalog.json` is reserved for resource catalog v1 and must not duplicate dynamic collection authority. A frontend view reads the module's collections and never owns a parallel store.

## Declarative frontend views

`frontend-view.json` schemaVersion 1 remains available for legacy read-only `text`, `markdown`, `json`, `key-value`, `list`, `table`, and built-in service regions. Use schemaVersion 2 when the module needs interactive regions. A v2 file still contains only `{schemaVersion, regions}` and cannot reference or execute JavaScript.

Every interactive region has a stable `id`, `type`, non-empty `title`, optional `description`, and optional `spoiler`. Supported interactive types are:

- `record-browser`: declares one collection, explicit record types, a dedicated frontend view, one query capability, page size (1–100), character budget, inactive-record policy, and optional filters bound to author-declared indexes/operators. The runtime uses stable sequence/ID keyset pagination; the browser cannot choose another collection, view, filter field, sort key, or budget. Every returned record can expose paginated rendered revision history through the same capability/view.
- `settings-form`: declares one stable record ID/type, frontend read view/capability, update capability, and editable pointers below that record's `data`. Field types are `text`, `textarea`, `integer`, `number`, `boolean`, `select`, and `json`, with optional required/minimum/maximum/options/help. The backend reads the current authority, applies only declared fields, validates the complete record schema, and submits an `update` with `expectedRevision`.
- `prompt-controls`: uses the same settings-record target and read/update capabilities, plus a safe module-relative `controlsFile`. It renders exclusive prompt groups with a final custom-text option by default; `allowNone: false` omits the no-addition option, `allowCustom: false` omits the custom option for a preset-only group, and one `last: true` group stays last. Both flags must be boolean when provided. The resource catalog owns all preset prose; no source option is placed in the module Skill or Agent workspace. Editable pointers derive only from declared groups. The settings API validates selections and updates atomically with expectedRevision; choices survive transcript suffix deletion. Narration uses a pre-creative workflow to export selected prose into the ordinary static document set at the same status. Director controls may instead declare `delivery: {mode: "agent-prompt", agents: [...], instruction: "..."}`: the host freezes selected text with the run, filters standalone `director-only` document comments by Agent ID in original order, and appends plain text to that Agent's existing prompt message. Source blocks never become shared workspace documents, new message roles, or per-node distribution grants. The frontend view must expose `/data` as `settings` for the trusted prompt snapshot reader.
- `workflow-controls`: declares an exact list of background `module-id/workflow-id` references and typed parameters. Parameters use the same field types and may add a default. The server rejects undeclared workflows and payload keys; foreground workflows cannot be started from a module control. The common workflow engine remains responsible for instance policy, blocking, status, cancellation, retry, and receipts.
- `integrity-alerts`: presents read-only source-revision warnings and optional turn-coverage gaps. A coverage declaration names exact support record types, IDs, frontend view/capability, and data pointers; its action may only prefill integer turn parameters on a workflow already whitelisted by a declared `workflow-controls` region. Detection never invalidates data or starts repair automatically.

Capabilities named in a frontend declaration must already exist in `data-contract.json` and grant the exact collection/action/view. Frontend permission is independent from Agent `moduleAccess`. Mark comprehensive debug/maintenance browsers `spoiler: true`; this is a local-user presentation warning, not a substitute for capability checks.

Example:

```json
{
  "schemaVersion": 2,
  "regions": [
    {
      "id": "entries",
      "type": "record-browser",
      "title": "All entries",
      "collectionId": "entries",
      "recordTypes": ["example.entry"],
      "view": "frontend",
      "readCapability": "example.frontend.read",
      "pageSize": 20,
      "filters": [{ "id": "state", "label": "State", "index": "state", "operator": "eq", "control": "select", "options": ["open", "closed"] }]
    }
  ]
}
```

For a card-local module, install the complete package at `features/<module-id>/`, use module-relative component paths, and register `module.json` in `manifest.feature_modules`. Card packages have no root `agents/`, `workflows/`, `prompts/agents/`, `prompts/workflows/`, or `prompts/modules/` component trees; root `prompts/` keeps only public system/common/model sources. For a project-global module, keep the package self-contained and include import guidance without linking it as a live runtime dependency. Imported copies become card-owned and do not synchronize with the source package.
