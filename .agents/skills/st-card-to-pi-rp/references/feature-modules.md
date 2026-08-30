# Card Feature Modules v3 / storage v2

Use a module for persistent structured per-chat state, a card-specific function, or a source-authored output outside the main narrative. Ordinary lore and rules that only govern the main prose remain normal card documents.

## Ownership and structure

```text
features/<module-id>/
├── module.json
├── storage.json
├── initial-records.json / initial-snapshot.json
├── record.schema.json / snapshot.schema.json
├── retrieval-policy.json
├── view.json
└── skill/
    ├── SKILL.md
    └── references/
```

The module skill owns every prompt related to that module: activation, retrieval decisions, field meaning, invariants, update rules, and source-authored feature instructions. Do not create `fixed.md` or `definition.md`, and do not duplicate module prompts in shared runtime context. Shared context only routes to the skill and reports paths/modes. Agent-enabled message-history retrieval uses the separate card `context_skill`; it must not borrow a module skill.

## Strict module definition

```json
{
  "schemaVersion": 3,
  "id": "character-memory",
  "title": "角色记忆",
  "description": "记录角色形成的长期记忆。",
  "surface": "frontend",
  "contextOrder": 100,
  "displayOrder": 10,
  "storageFile": "storage.json",
  "viewFile": "view.json",
  "skillFile": "skill/SKILL.md"
}
```

Use exactly these fields. Frontend modules appear in Web; background modules have identical records and context behavior but do not appear there. All frontend modules precede background modules in Agent context, each sorted by `contextOrder`; `displayOrder` and browser preferences affect only presentation.

## Storage and records

`storage.json` version 2 selects `record-log`, `snapshot`, or `hybrid`, names the enabled initial/live/schema files, catalog, retrieval policy, and which stream supplies context, and declares `engine`. Ordinary modules use `engine: null`; native variable modules use `{ "kind": "variables", "configFile": "variable-runtime.json" }`. Live copies belong under `sessions/<card>/<chat>/modules/<module>/`.

All message and module data uses a version 1 envelope containing ID, source, sequence, revision, timestamps, `binding.messageId`, `binding.turn`, metadata, and a module-defined `data` object. Define `data` in JSON Schema. Preserve envelope identity on revision. Bind ordinary facts to the delivered message that established them. Bind a post-narrative auxiliary output to the saved assistant message beside which it is displayed, so suffix deletion can cascade precisely.

Initial record logs are normally `[]`; do not invent state absent from the source card. A snapshot initial file contains one valid envelope.

For source variables, read [variables.md](variables.md). Use hybrid storage with a complete-state record log and current snapshot. Narrative turns receive only authored fixed bindings and exact on-demand path projections. The post-narrative update task receives every effective variable and commits one full snapshot after concentrated validation.

## Auxiliary output engine

A source-authored status panel, “meanwhile” scene, thought channel, commentary, choice list, summary, or similar output outside the main narrative uses record-log storage and:

```json
"engine": { "kind": "post-narrative-output" }
```

Its record schema defines exactly one required string field, `content`, and disallows additional properties. Preserve a source's internal structure as authored Markdown inside that field. The module skill owns activation, non-activation, cadence, information boundaries, and original formatting instructions. After the main prose is saved, one hidden runtime task resolves every post-narrative output module, validates each emitted record, and binds it to that assistant message. The task records `not_triggered` explicitly without inventing empty content. The auxiliary output must not also appear in the main chat body.

Use `record-log` so outputs survive resume and follow suffix deletion. Choose retrieval based on authored continuity: latest one is the baseline, while a continuing off-screen storyline may require a recent range or Agent selection. The declarative Web view may show the latest output or a short authored history.

## Retrieval policy

Code and Agent decisions are orthogonal:

- `code.profile: default`: messages select all; module streams select latest one.
- `code.profile: custom`: an authored deterministic selector replaces the default.
- `agent.mode: disabled`: code only.
- `agent.mode: append`: code result remains and `rp_context_query` may append exact records.
- `agent.mode: override`: only the Agent query is used; failed extraction falls back to code.

Thus the four ordinary author choices are default, custom, Agent append, and Agent override without a closed four-value enum. Supported selectors are `all`, `latest`, `ids`, `range`, `around`, and `latest_per_key`. The Agent chooses selectors from a compact catalog; code performs exact extraction. `success_empty` distinguishes an intentional empty selection, and `not_triggered` distinguishes an inactive authored condition. Put those conditions in the module skill.

The runtime generates catalog identity, revision, hash, tags, and short title deterministically. `catalog.agentMode` may enable `rp_catalog_update` in append or override mode. The module skill must say when enrichment is worthwhile and define allowed title/tag/summary content. Generated navigation fields stay under `generated` and are invalidated when record revision or content hash changes; deterministic fields remain the fallback.

## Fidelity and display

Preserve source feature prompts by splitting and moving them into the module skill and references. Add only minimal routing language. Track original targets in provenance; mark runtime record/view/schema scaffolding as generated runtime.

`view.json` schema version 1 reads `{records, snapshot}` and supports `text`, `markdown`, `key-value`, `list`, `table`, and `json`. Paths may reach envelope fields (`binding.turn`) or module data (`data.content`). It contains no executable logic. Background modules still require a valid view.

When source EJS deterministically selects module-owned prompt text before narrative generation, add a card context processor. Keep executable selection under the module's `runtime/` directory and every selected prompt fragment under its `skill/` directory. Register the processor in the card manifest; it must not update module state. Persistent changes remain in the module workflow.
