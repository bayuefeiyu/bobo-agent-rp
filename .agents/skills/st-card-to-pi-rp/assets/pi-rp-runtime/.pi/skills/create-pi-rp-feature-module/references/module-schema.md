# Pi RP feature-module protocol v3 / storage v2

## Static and live ownership

```text
cards/<card-id>/features/<module-id>/
├── module.json
├── storage.json
├── initial-records.json
├── record.schema.json
├── initial-snapshot.json
├── snapshot.schema.json
├── retrieval-policy.json
├── view.json
└── skill/
    ├── SKILL.md
    └── references/

sessions/<card-id>/<chat-id>/modules/<module-id>/
├── binding.json
├── records.jsonl
├── snapshot.json
└── catalog.json

sessions/<card-id>/<chat-id>/draft/
└── task-owned temporary files
```

Only files enabled by `storage.json` are required. Card files define behavior and initial state; session files contain live data. A module skill owns every module prompt. Message-suffix deletion removes records bound to deleted message IDs. The public `draft/` directory is shared temporary workspace, cleared before each new player turn, and never authoritative state.

## `module.json`

Use exactly:

```json
{
  "schemaVersion": 3,
  "id": "example-module",
  "title": "Example module",
  "description": "Player-facing summary.",
  "surface": "frontend",
  "contextOrder": 100,
  "displayOrder": 10,
  "storageFile": "storage.json",
  "viewFile": "view.json",
  "skillFile": "skill/SKILL.md"
}
```

All paths stay inside the module. `contextOrder` and `displayOrder` are independent. Frontend modules precede background modules in context; only frontend modules appear in Web settings.

## `storage.json`

```json
{
  "schemaVersion": 2,
  "kind": "record-log",
  "contextSource": "records",
  "records": {
    "file": "records.jsonl",
    "initialFile": "initial-records.json",
    "schemaFile": "record.schema.json"
  },
  "snapshot": null,
  "catalogFile": "catalog.json",
  "retrievalPolicyFile": "retrieval-policy.json",
  "engine": null
}
```

`kind` is `record-log`, `snapshot`, or `hybrid`. A snapshot stream uses the same three file fields and contains one common envelope. `contextSource` identifies which stream participates in retrieval; Web may show both. Ordinary modules use `engine: null`.

## Native variable engine

A variable module uses hybrid storage, snapshot context, and:

```json
"engine": { "kind": "variables", "configFile": "variable-runtime.json" }
```

The config contains exactly:

```json
{
  "schemaVersion": 1,
  "schemaFile": "variable.schema.json",
  "initial": {
    "defaultFile": "initial/default.json",
    "openingFiles": { "opening-00": "initial/openings/opening-00.json" }
  },
  "bindingsFile": "skill/references/variable-bindings.json",
  "hooks": {
    "normalizeFile": null,
    "afterUpdateFile": null
  },
  "context": { "alwaysForNarrative": [] }
}
```

`defaultFile` is a complete state; opening files are overlays. History and current snapshot records store the complete state in `data.state`. Prompt aliases use RFC 6901 JSON Pointers and are defined in the module skill directory. `alwaysForNarrative` selects the only variable bindings automatically sent during creative turns; other variables are retrieved with exact `rp_context_query` projections.

After AI prose is saved, the update task receives every effective variable, may call `rp_variable_update` repeatedly, and ends with `rp_variable_finalize`. Failed operations remain in the pending public draft and only their path/value/error is returned for Agent correction. Success commits one complete snapshot bound to the AI message. Optional hooks export `normalize(state, context)` or `afterUpdate(previous, next, context)` and return a state or `{state, errors}` without file I/O.

Deleting a message truncates the suffix and restores the latest surviving full snapshot. Editing message text leaves every later message and module record untouched. A future validated frontend variable editor mutates the latest effective snapshot directly and must not create any manual-edit record or metadata.

Use this baseline `view.json` when the author has not designed a more specific variable presentation:

```json
{
  "schemaVersion": 1,
  "regions": [
    {
      "type": "json",
      "title": "当前变量",
      "path": "snapshot.data.state",
      "empty": "尚未建立变量状态。"
    }
  ]
}
```

## Common record envelope

```json
{
  "schemaVersion": 1,
  "id": "memory-001",
  "source": "module:example-module",
  "sequence": 0,
  "revision": 1,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z",
  "binding": { "messageId": null, "turn": 0 },
  "metadata": {
    "recordType": "example",
    "entityIds": [],
    "tags": [],
    "title": "optional compact title"
  },
  "data": {}
}
```

Use consecutive `sequence`; preserve ID and creation time on revision; increment `revision`; bind delivered developments to their causing user message. The module schema validates only `data`.

## Retrieval policy

The four author-facing options use two independent axes:

| Option | `code.profile` | `agent.mode` |
|---|---|---|
| 默认 | `default` | `disabled` |
| 自定义 | `custom` | `disabled` |
| agent 附加 | `default` or `custom` | `append` |
| agent 覆盖 | `default` or `custom` | `override` |

```json
{
  "schemaVersion": 1,
  "source": "module:example-module",
  "code": { "profile": "custom", "selector": { "type": "latest", "limit": 3 } },
  "agent": {
    "mode": "append",
    "fallback": "code",
    "onNotTriggered": "code",
    "maxRecords": 20
  },
  "catalog": { "codeProfile": "default", "agentMode": "disabled" }
}
```

Default code retrieval is `all` for messages and `latest: 1` for modules. Selectors are `all`, `latest`, `ids`, `range`, `around`, and `latest_per_key`. Agent selection calls `rp_context_query`; deterministic code extracts exact envelopes. Failed selection uses code fallback. Intentional empty and non-activation are explicit decisions.

The runtime creates a compact catalog. `catalog.agentMode` is `disabled`, `append`, or `override`: it controls whether `rp_catalog_update` may merge with or replace prior generated navigation metadata. Deterministic record IDs, revisions, hashes, and fallback titles are never Agent-owned. Optional generated title/tags/summary live under `generated` and remain valid only while record revision and content hash match. Put enrichment triggers and safety rules in the module skill.

## Module skill and view

The skill description states activation. Its body owns retrieval choices, field semantics, invariants, and update rules. It tells the Agent when to use `select`, `success_empty`, and `not_triggered`; supporting prompts remain under `skill/references/`.

When deterministic code selects module prompt fragments before narrative generation, use the separate card context-processor contract in [context-processors.md](context-processors.md). Keep selected module text under `skill/`, code under `runtime/`, and persistent changes in the module update workflow.

`view.json` schema version 1 reads `{ "records": [...], "snapshot": {...} }`. Regions support `text`, `markdown`, `key-value`, `list`, `table`, and `json`; paths may address envelope fields such as `data.content` and `binding.turn`. A `json` region recursively renders arbitrary objects and arrays as ordinary key/value fields: nested objects become titled groups, arrays use numbered items, primitives remain readable values, and JSON braces, quotes, commas, and raw source syntax are not shown. Empty top-level containers use the region's authored `empty` text. This is the baseline variable-module view. The view contains no RP logic or JavaScript.
