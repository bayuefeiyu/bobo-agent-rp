# Native Pi RP variable modules

Convert the source card's variable meaning, not its SillyTavern/MVU transport. Preserve authored names, hierarchy, defaults, opening differences, types, ranges, enumerations, dynamic keys, readonly or derived fields, update conditions, relationships, information boundaries, display intent, and prompt references. Do not retain `stat_data`, `<UpdateVariable>`, JSON Patch output blocks, message-floor macros, event buses, regex parsing, or `registerMvuSchema`. Never execute source EJS; translate its supported variable reads, deterministic branches, derivations, and side effects through the native processor and hook contracts described in `ejs-conversion.md`.

## Static layout

```text
features/variables/
├── module.json
├── storage.json
├── variable-runtime.json
├── variable.schema.json
├── initial/
│   ├── default.json
│   └── openings/<opening-id>.json
├── initial-records.json
├── initial-snapshot.json
├── record.schema.json
├── snapshot.schema.json
├── retrieval-policy.json
├── view.json
├── runtime/
│   ├── normalize.mjs
│   └── after-update.mjs
└── skill/
    ├── SKILL.md
    └── references/
        ├── variable-bindings.json
        ├── variable-index.md
        └── authored update-rule documents
```

Use hybrid storage with snapshot context and the `variables` storage engine. History records and the current snapshot contain complete state. The default initial file contains a complete state; each opening file is an object overlay. Arrays in an overlay replace arrays rather than merging by index.

Unless the source card needs a deliberately authored presentation, use one declarative `json` region at `snapshot.data.state` in `view.json`. The shared frontend recursively presents its objects and arrays as nested key/value fields rather than raw JSON syntax, exposing the complete effective state without card-specific JavaScript.

## Runtime declaration

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
    "normalizeFile": "runtime/normalize.mjs",
    "afterUpdateFile": "runtime/after-update.mjs"
  },
  "context": { "alwaysForNarrative": ["current_time", "primary_character_state"] }
}
```

Either hook file may be `null`. `normalize(state, context)` handles deterministic single-state normalization and derivation. `afterUpdate(previous, next, context)` handles deterministic previous/next effects. A hook returns a state or `{ "state": ..., "errors": [...] }`, performs no file or model work, and never commits data itself.

## Narrative references

Address variables with RFC 6901 JSON Pointers. Put stable aliases in `skill/references/variable-bindings.json`:

```json
{
  "schemaVersion": 1,
  "bindings": {
    "affection": { "path": "/角色/白娅/依存度", "shape": "scalar", "missing": "error" },
    "character_state": {
      "paths": ["/角色/白娅/依存度", "/角色/白娅/情绪"],
      "shape": "object",
      "missing": "omit"
    }
  }
}
```

Fixed card and primary-character prompts may use `{{rp_var:alias}}` for a scalar alias. Put aliases required every narrative turn in `alwaysForNarrative`. Route every other variable from the module skill: state where it lives and when to call `rp_context_query` with exact `projection.bindings` or `projection.paths`. First-version projections do not use a query expression language.

## Post-narrative update

Variable changes occur after player-visible prose is saved. The update task receives the current user message, saved AI prose, module skill, public draft path, and the complete effective variable state. The responsible Agent may call `rp_variable_update` any number of times, following an authored procedure when present, then calls `rp_variable_finalize`.

The update tool supports idempotent `add`, `replace`, and `cancel` draft actions over `set`, `delta`, `merge`, `append`, and `remove` operations. Finalization applies the concentrated draft, runs hooks and Schema validation, and reports only the failing operation/path/current/attempted value and error. Correct operations remain in the pending draft; the Agent uses the already supplied complete state and authored rules to discover relationships and repair only failed operations. A successful update writes one complete snapshot bound to the AI message. No effective change writes no snapshot.

The session's `workspace/public/turn/` directory is shared disposable workspace for all tasks and is cleared before each new player turn. An interrupted variable draft remains pending and blocks a new turn until resumed or completed; it is not effective state.

## History and direct edits

Deleting a historical chat message deletes that message and every later message, then deletes all bound module records. Restore the latest surviving full variable snapshot. Editing historical message text does not alter later chat, variables, or module records; the user accepts possible inconsistency.

A future validated frontend variable editor directly replaces values in the latest effective snapshot. It creates no new snapshot, revision note, audit field, timestamp, changed-path list, or any other manual-edit record.
