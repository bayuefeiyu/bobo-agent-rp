# Pi RP unified data protocol

This document is the authoritative data contract for Pi RP cards and feature modules. The project is pre-release: the protocol replaces the former feature-module storage, retrieval-policy, catalog, post-narrative-output, variable-draft, and long-term-publication record formats without compatibility requirements.

## Ownership and layout

```text
features/<module-id>/
├── module.json
├── data-contract.json       # data/hybrid only
├── catalog.json             # resource/hybrid only
├── collections/<collection-id>/initial/
├── frontend-view.json
├── runtime/
└── skill/

sessions/<card-id>/<chat-id>/
├── modules/<module-id>/collections/<collection-id>/
├── indexes/
├── workspace/private/<workflow-id>/<run-id>/<node-id>/
├── workspace/public/
├── workspace/transactions/
└── workspace/receipts/
```

`data-contract.json` is the only machine-readable module data declaration. A module owns one or more collections; a collection owns one or more record types. JSON/JSONL collection files are authoritative. Indexes, catalogs, and generated documents are derived and rebuildable.

## Module v6

```json
{
  "schemaVersion": 6,
  "id": "rumor-system",
  "moduleKind": "data",
  "basedOn": null,
  "title": "传闻",
  "description": "记录和传播传闻。",
  "surface": "frontend",
  "contextOrder": 100,
  "displayOrder": 10,
  "dataContractFile": "data-contract.json",
  "resourceCatalogFile": null,
  "frontendViewFile": "frontend-view.json",
  "skillFile": "skill/SKILL.md",
  "workflowFiles": [
    "workflows/query-rumors/workflow.json",
    "workflows/update-rumors/workflow.json"
  ]
}
```

The exact v6 manifest additionally distinguishes three module kinds:

- `data`: owns session collections; `dataContractFile` is required and `resourceCatalogFile` is null;
- `resource`: owns static authored resources; `resourceCatalogFile` is required and `dataContractFile` is null;
- `hybrid`: owns both and requires both files.

Resource-only modules use `surface: "background"` and `frontendViewFile: null`; a frontend requires authoritative data and a frontend view. Background data/hybrid modules also use `frontendViewFile: null`. This avoids fake collections and prevents static authored Markdown from being copied into session authority merely to satisfy a package shape.

Every module owns only complete Workflow v3 definitions listed by `workflowFiles`; it does not publish naked nodes or internal tools. Each listed workflow is `module-external` or `module-internal`, declares the same `ownerModuleId`, has no trigger, and ends in exactly one `workflow-return` node. Substantial card-specific changes use a distinct module ID. `basedOn` may name the source module but never implies data compatibility, synchronization, or permission to change its source package.

Internal workflows default to a whole-owner-module execution lock. A module with deliberately independent collection write domains may declare non-empty collection `writeLocks`; all writable node capabilities must be covered, and locks remain separate from capabilities, transactions, and expected revisions.

## Resource catalog v1

A resource/hybrid module's catalog uses the exact fields `schemaVersion`, `moduleId`, `categories`, `selectionGroups`, and `documents`. Each document is one indivisible delivery unit below `documents/` and declares:

- stable ID, safe Markdown path, title, summary, categories, and optional subcategory;
- `readPolicy`: `required`, `conditional`, `choice`, or `optional`;
- `authority`: `binding`, `canonical`, `advisory`, or `exploratory`;
- applicable phases from `analysis`, `retrieval`, `planning`, `writing`, `checking`, and `archiving`;
- integer priority, optional selection group, `readWhen`, perspective, aliases, related document IDs, and source references.

Choice documents must name a selection group. A group uses `one`, `at-most-one`, `one-or-more`, or `any`, supplies a selection instruction, and may name a fallback member. Catalog metadata routes work but never replaces the authoritative document body.

## Data contract v1

```json
{
  "schemaVersion": 1,
  "moduleId": "rumor-system",
  "collections": {
    "rumors": {
      "storage": {
        "kind": "hybrid",
        "partition": { "mode": "single" },
        "initialRecordsFile": "collections/rumors/initial/records.json",
        "initialSnapshotFile": "collections/rumors/initial/snapshot.json"
      },
      "recordTypes": {
        "rumor.entry": {
          "dataSchemaVersion": 1,
          "indexes": {
            "spread": {
              "path": "/data/spread",
              "type": "number",
              "default": 0,
              "operators": ["eq", "gte", "lte"]
            }
          },
          "searchableFields": ["/data/content"],
          "views": {
            "rp": {
              "format": "text",
              "fields": [{ "path": "/data/content" }]
            },
            "maintenance": {
              "format": "object",
              "fields": [
                { "path": "/data/content", "label": "传闻" },
                { "path": "/data/spread", "label": "流传度" }
              ]
            }
          },
          "actions": ["create", "update", "revise", "retract", "archive", "restore"]
        }
      }
    }
  },
  "capabilities": {
    "rumor.query": {
      "collections": ["rumors"],
      "actions": ["query"],
      "views": ["rp"]
    },
    "rumor.maintain": {
      "collections": ["rumors"],
      "actions": ["query", "create", "update", "revise", "retract", "archive", "restore"],
      "views": ["rp", "maintenance"]
    }
  }
}
```

An absent indexed value is stored as empty unless the author declared `default`. A present value with the wrong declared type is invalid. Fields outside declared indexes remain module-owned and unrestricted by the public protocol. Module-local schemas and processors are optional.

Index types are `string`, `number`, `boolean`, `enum`, `id`, `id-list`, `string-list`, and `time`. Standard operators are `eq`, `neq`, `contains`, `in`, `gt`, `gte`, `lt`, and `lte` where meaningful.

Storage kinds are `record-log`, `snapshot`, and `hybrid`. Partition modes are `single`, `index`, and `turn-range`. A module processor may implement a more specialized deterministic partition or operation.

A custom record action declares `processors.<action> = {file, export}` inside its record type. The trusted module-local function receives frozen copies of the current collection state, target record, operation, contract, runtime context, and batch, then returns `{record: {data, status?, note?}, result?}`. The runtime creates the revised envelope, revision, timestamps, history entry, indexes, and provenance. Custom actions always target an existing record and therefore require `targetId` plus `expectedRevision`; collection-wide work should expand to ordinary per-record operations.

## Record envelope v2

```json
{
  "protocolVersion": 2,
  "id": "rumor-001",
  "moduleId": "rumor-system",
  "collectionId": "rumors",
  "recordType": "rumor.entry",
  "dataSchemaVersion": 1,
  "sequence": 0,
  "revision": 1,
  "status": "active",
  "createdAt": "2026-09-02T00:00:00.000Z",
  "updatedAt": "2026-09-02T00:00:00.000Z",
  "binding": { "messageId": null, "turn": 0 },
  "data": {},
  "note": null,
  "provenance": {}
}
```

The runtime fills provenance automatically. Ordinary Agents neither supply nor see technical provenance. They may provide the optional natural-language `note` only.

Transcript messages and workflow artifacts use a separate runtime-owned `narrativeSource` value. It records technical producer (`unknown`, `user`, `card`, `agent`, `code`, or `runtime`), narrative layer (`unspecified`, `in-world`, `story`, or `authorial`), and optional stable producer/character IDs. These fields describe semantic origin, not data permission or factual truth. In particular, player input is `in-world`, a story container can contain uncertain character claims, and only a workflow/card author's static declaration can mark generated output as `authorial`. Missing legacy metadata remains `unspecified`.

Stable IDs are used for cross-module references. Module and card authors decide which record types register identities by declaring `identity: {"namePath":"/data/name","aliasesPath":"/data/aliases"}`; omit it for unregistered types. The derived session registry enforces globally unique registered IDs. `rp_data_resolve` resolves an ID, display name, or alias but returns only entries in collections for which the current node has query authority.

## Retrieval and views

Indexes answer which records match; views decide what the caller sees. Every record type exposed to RP must declare its own `rp` view. Missing views are errors and never fall back to the full envelope. Query results always include only `id`, `recordType`, `revision`, and the rendered value, so an Agent can perform guarded updates without receiving automatic provenance.

Query budgets have conservative runtime defaults. A node may receive a higher authored ceiling. The effective budget is the minimum of the runtime ceiling, node ceiling, and request. Truncation is explicit and returns a continuation cursor.

Structured index filters and optional content search can be combined. Content-search fields and implementation are author-declared. Semantic search is optional.

## Changes and commits

```json
{
  "protocolVersion": 1,
  "batchId": "batch-001",
  "status": "pending",
  "commitPolicy": "atomic",
  "operations": [
    {
      "operationId": "op-001",
      "moduleId": "rumor-system",
      "collectionId": "rumors",
      "recordType": "rumor.entry",
      "action": "create",
      "data": { "content": "……" },
      "note": null
    }
  ]
}
```

The batch uses this exact top-level field set. Operations use the common routing fields plus optional `targetId`, `data`, `expectedRevision`, `groupId`, `note`, and module-owned `params`; custom operation arguments belong only in `params`.

A turn may produce any number of batches. An Agent may submit one explicitly, or a workflow node may submit explicitly named output documents at node end. The runtime never scans a directory to guess which document is a change draft.

Commit policies are `atomic`, `grouped`, and `best-effort`. `best-effort` is rejected unless the owning workflow node explicitly declares `dataCommit.allowBestEffort: true`. Batch and operation IDs are idempotency keys. Every operation against an existing record must carry `expectedRevision`; missing or mismatched revisions produce conflict receipts and never silently overwrite data. Commits for one session are serialized.

Idempotent replay applies to receipts that recorded an outcome: re-submitting a batch whose receipt is `committed` or `partial` with identical content returns that receipt, and with different content is refused as an idempotency conflict. A `failed` receipt produced before commit, or after a confirmed complete rollback, is not an outcome — nothing was accepted — so re-submitting the identical batch **re-executes** it. The durable receipt is the transaction's commit marker and is installed only after every other transaction target. If a host reports an error after that marker exists, the runtime returns the persisted outcome instead of overwriting it. If rollback is incomplete or the durable outcome cannot be established, the transaction journal remains unresolved and the batch is blocked with `commit_outcome_unknown` until recovery confirms commit or rollback; it must never be re-executed speculatively because a create may have no target ID or revision guard. Derived indexes follow the same principle in the other direction: an unreadable index file is treated exactly like a missing one and rebuilt from authoritative records, with the damage announced rather than silently repaired, while a damaged authoritative file stays an error.

Runtime transaction context may include normalized `sourceReferences` for every actually used message revision and retained artifact. This set is copied into record provenance and the durable receipt; it is distinct from the single story-position `binding`. Ordinary Agents cannot author it. A trusted code node may select exact visible message IDs for delayed batching, after which the runtime resolves their current revisions. Impact inspection reads receipts only and never changes record validity; in-place message edits require an explicit, scoped maintenance workflow if the user wants derived data repaired.

Session-wide integrity inspection can report that a currently visible message revision differs from a revision used by an authorized module transaction. It is diagnostic only. Modules that support user-selected review ranges may persist their own coverage acknowledgements through normal guarded changes; these acknowledgements do not rewrite transcript history or grant cross-module repair authority.

## Workflow v3 integration

Modules define capabilities and own complete internal/external workflows. Top-level workflow nodes invoke them through the common call-and-wait boundary; module nodes may invoke external workflows only. Workflows grant a subset of data capabilities to concrete nodes. Skills explain semantics but never grant access. Agent tools, code nodes, and node-end submission all inherit the node's effective capabilities.

Node outputs are registered by logical name with file/directory kind and `node`, `workflow`, `turn`, `session`, or `public` scope. `workspaceHandoff.include` is the only node-to-node filesystem allowlist: every entry references one declared output. Its destination defaults to the declared output path below `handoff/<producer-node-id>/`, preserving an allowlisted mirror in which transferred knowledge maps retain their relative references. Optional `as` deliberately overrides that path and may invalidate such references. The runtime never scans or transfers a whole node workspace, and it supports no wildcard or exclusion-list form. Missing or mismatched included outputs fail before downstream release. Change drafts remain node-owned. Node-end commits occur before the node is marked successful and before downstream nodes run.

Module results cross the boundary only as declared file or directory exports placed at caller-selected safe paths. A caller must redeclare and explicitly include a returned path before another node receives it; nested results never bubble automatically. Normal workflow context assembly, explicit workspace handoff, and workspace-document indexes are the primary information-routing mechanisms. Top-level trigger events do not implicitly transfer workspaces, and durable cross-turn authority remains module data. Query access control remains a fallback boundary against autonomous over-querying or configuration mistakes.

## Documents and maintenance

- Dynamic authoritative data uses JSON/JSONL.
- Static authored knowledge uses Markdown with optional frontmatter.
- Generated reports are derived, marked as generated, and rebuildable.

The protocol stores version identifiers only. Data migration is an explicit maintenance task discussed with the user; an Agent may directly change a small set or generate temporary migration code for a large set. Migration still uses the unified write service.
