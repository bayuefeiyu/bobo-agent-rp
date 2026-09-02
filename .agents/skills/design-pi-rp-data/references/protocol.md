# Pi RP unified data protocol

This document is the authoritative data contract for Pi RP cards and feature modules. The project is pre-release: the protocol replaces the former feature-module storage, retrieval-policy, catalog, post-narrative-output, variable-draft, and long-term-publication record formats without compatibility requirements.

## Ownership and layout

```text
features/<module-id>/
├── module.json
├── data-contract.json
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

## Module v4

```json
{
  "schemaVersion": 4,
  "id": "rumor-system",
  "basedOn": null,
  "title": "传闻",
  "description": "记录和传播传闻。",
  "surface": "frontend",
  "contextOrder": 100,
  "displayOrder": 10,
  "dataContractFile": "data-contract.json",
  "frontendViewFile": "frontend-view.json",
  "skillFile": "skill/SKILL.md"
}
```

Substantial card-specific changes use a distinct module ID. `basedOn` may name the source module but never implies data compatibility, synchronization, or permission to change its source package.

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

## Workflow v2 integration

Modules define capabilities. Workflows grant a subset to concrete nodes. Skills explain how to use capabilities but never grant them. Agent tools, code nodes, and node-end submission all inherit the node's effective capabilities.

Node outputs are registered by logical name with `node`, `workflow`, `turn`, `session`, or `public` scope. Change drafts remain node-owned. Node-end commits occur before the node is marked successful and before downstream nodes run.

Normal workflow context assembly is the primary information-routing mechanism. Query access control is a fallback boundary against autonomous over-querying or configuration mistakes.

## Documents and maintenance

- Dynamic authoritative data uses JSON/JSONL.
- Static authored knowledge uses Markdown with optional frontmatter.
- Generated reports are derived, marked as generated, and rebuildable.

The protocol stores version identifiers only. Data migration is an explicit maintenance task discussed with the user; an Agent may directly change a small set or generate temporary migration code for a large set. Migration still uses the unified write service.
