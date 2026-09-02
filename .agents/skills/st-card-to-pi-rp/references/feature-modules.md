# Card feature modules v4

Read the authoritative [unified data protocol](../../design-pi-rp-data/references/protocol.md) first. For ownership, retrieval, mutation, and workflow-access decisions, follow the sibling [data-design Skill](../../design-pi-rp-data/SKILL.md). This reference covers only conversion-specific module placement. A module is an authored data owner and capability provider. It may contain multiple collections and record types; it no longer owns a separate storage protocol, retrieval policy, catalog, post-narrative-output engine, or variable transport.

## Layout

```text
features/<module-id>/
├── module.json
├── data-contract.json
├── collections/<collection-id>/initial/
├── frontend-view.json
├── runtime/
└── skill/
    ├── SKILL.md
    └── references/
```

Use the exact module v4 shape from the unified protocol. `data-contract.json` declares collections, record types, storage, indexes, searchable fields, Agent return views, actions, and capabilities. A substantial card customization receives a distinct module ID and may identify its origin through `basedOn`.

## Data freedom and indexes

The public runtime validates the strict record envelope and every declared index value. Other `data` fields remain module-owned. Missing indexed values are allowed; an authored default is used when present. A present value of the wrong declared type is an error.

JSON/JSONL session files are authoritative. Derived indexes are never edited by an Agent and must rebuild from authoritative records. Cross-module references use stable IDs only when the module or card author chose to register the referenced concept.

## Retrieval and presentation

Each record type exposed to roleplay declares its own `rp` view. The runtime never guesses a primary content field and never falls back from a missing RP view to full data. Other named views may be authored for narration, review, or maintenance. The Web `frontend-view.json` is independent of Agent views and may display one or many collections.

Nodes receive exact module capabilities through workflow `moduleAccess`. A Skill explains field meaning, activation, update rules, and correct tool use; it does not grant permission. Use `rp_data_query`/`rp_data_get` for targeted reads and a declared unified-change-batch output for writes.

## Updates

Persistent updates are ordinary workflow nodes. A node may write several batches, explicitly call `rp_data_submit`, or rely on `dataCommit.onNodeEnd` for explicitly named outputs. Never scan a directory for drafts. Never update authoritative module files directly from an Agent or module processor.

Source-authored status panels, “meanwhile” scenes, memory, secrets, rumors, variables, and other persistent features all use this same contract. Their semantics differ through collections, record types, views, capabilities, Skills, workflows, and optional processors—not through parallel storage engines.
