# Workflow, Agent, and model contract v2

For module access, change batches, commits, artifacts, and concurrent data writers, follow the data-design Skill's [workflow-access contract](../../design-pi-rp-data/references/workflow-access.md). This document remains authoritative for the broader workflow graph, Agent, and model structure.

Models store shareable provider/model configuration without credentials. Agents define task behavior, ordinary tools, and output mode. Workflow nodes define execution order, context, scoped module capabilities, named outputs, and node-end data submission. Model precedence remains node, workflow default, Agent default, then `pi:current`.

## Workflow kinds and nodes

Kinds are `foreground`, `turn-background`, and `global-background`. Node types are `agent`, `code`, `narrative`, `gate`, `join`, and `turn-finalize`. `module-output` and `variable-update` were removed: all module work now uses ordinary nodes plus unified data capabilities.

Dependencies form an acyclic graph. Parallel roots may run together; joins support `all`, `any`, `first-success`, `quorum`, and `collect`. Foreground workflows contain exactly one narrative node and at least one downstream finalizer. Background triggers are manual, after-workflow, or completion of a named node.

## Node data access

`moduleAccess` grants exact collection capabilities and return views to one node. The module defines capabilities; the workflow/card author grants a subset. Agent Skills explain use but cannot expand permission.

```json
{
  "moduleAccess": [{
    "moduleId": "rumor-system",
    "collectionId": "rumors",
    "capabilities": ["rumor.query", "rumor.write"],
    "views": ["rp"],
    "queryBudget": { "maxRecords": 50, "maxCharacters": 12000 }
  }]
}
```

## Outputs and commits

Declare every file output by logical name, safe relative path, scope (`node`, `workflow`, `turn`, `session`, `public`), retention, and optional format. Physical files live below the producing node workspace; later nodes resolve logical artifacts rather than hard-coded producer paths.

Change drafts use format `unified-change-batch`. `dataCommit.onNodeEnd` names exact outputs or paths and never scans a directory. Registration and required commits happen before the node is marked successful and before downstream nodes run. Explicit `rp_data_submit` uses the same transaction service; node-end handling recognizes the existing receipt and does not duplicate it. `best-effort` batches additionally require `dataCommit.allowBestEffort: true`; ordinary nodes default to atomic/grouped behavior.

## Context and records

Context modes remain `fixed`, `previous-output`, `inherit`, and `custom`. A custom deterministic processor receives frozen declared inputs and cannot persist authoritative state. Shared output requires an authored scope; durable queryable information must be submitted to a module collection rather than a separate long-term-publication record format.

Each successful node keeps its user-only process record. Process records never enter Agent context or artifacts. Run state records normalized token usage. Retry and model-choice behavior remain explicit.
