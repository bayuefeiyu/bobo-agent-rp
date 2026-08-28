# EJS semantic conversion

Convert the behavior expressed by EJS, not the EJS execution environment. Never execute source EJS while inspecting or converting a card. Archive the original source unchanged, inventory every template read, branch, output, side effect, external API, and lifecycle, then map each supported behavior to a native target.

## Classification

Classify every EJS block before choosing a target:

- deterministic prompt selection or interpolation before prose generation: a `before-narrative` context processor;
- deterministic variable normalization, derivation, or previous/next transition: native variable `normalize` or `afterUpdate` hooks;
- persistent non-variable state: the owning feature module's update workflow and tools;
- semantic scene relevance: the owning skill and `rp_context_query`, optionally after deterministic code narrows candidates;
- display-only rendering: declarative module Web view or card-local frontend code;
- message transformation: an explicit message-processing phase, only when the target runtime supports it;
- ST DOM, extension settings, regex activation, worldbook toggles, or remote imports: translate to an existing native feature or mark unsupported. Do not emulate ST merely to preserve an implementation detail.

Separate mixed EJS that both emits text and causes side effects. The emitted authored text and the state change must have different native owners.

## Deterministic context processors

Use a processor when ordinary code can decide which authored prompt fragments apply from declared current state. Do not use one when the decision requires interpretation of plot meaning; use Agent retrieval guidance instead.

Add card-relative processor definition paths to `manifest.context_processors`. Definitions use schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "character-stage",
  "description": "Select the authored character stage from the current dependency value.",
  "phase": "before-narrative",
  "contextOrder": 300,
  "entryFile": "runtime/context-processors/character-stage/index.mjs",
  "dependencies": {
    "currentInput": false,
    "opening": false,
    "player": false,
    "messages": "none",
    "variables": "all",
    "modules": [],
    "settings": false
  },
  "fragments": [
    {
      "id": "dependency-00-19",
      "title": "消极自毁",
      "file": "characters/primary/stages/dependency-00-19.md"
    }
  ],
  "failure": "error"
}
```

All paths inside the definition are card-root-relative safe POSIX paths. `phase` is `before-narrative` in version 1. `messages` and `variables` are `none` or `all`; `modules` lists exact feature-module IDs. Declare only actual dependencies. `failure: error` aborts a turn whose required behavior could not be computed; `omit` records the failure and omits that processor for intentionally optional behavior.

The entry module exports `selectContext(input)` or a default function and returns only declared fragment IDs:

```js
export function selectContext({ variables }) {
  const value = variables.白娅.依存度;
  if (value < 20) return { include: ["dependency-00-19"] };
  if (value < 40) return { include: ["dependency-20-39"] };
  return { include: ["dependency-40-plus"] };
}
```

The frozen input has stable fields:

```text
schemaVersion, card, turn, currentInput, openingId, player,
messages, variables, modules, settings
```

Undeclared optional dependencies are represented by `null`, `[]`, or `{}`. Prior messages exclude the current player input, which has its own field. Module values contain `{records, snapshot}`. The processor must be deterministic for the supplied input, perform no persistent writes, and return exactly `{include: string[]}` with unique known IDs. It cannot return inline prompt text, mutate prompt order, update modules, or select arbitrary files.

The runtime loads selected fragment files, expands supported native variable references, and injects them after fixed card/player/primary-character context but before retrieved history and module records. Processors are ordered by `contextOrder`, independent of Web settings.

## Fidelity and placement

Keep authored fragment prose in its semantic authoritative home. A character-stage passage remains under the primary character; a module-specific prompt remains under that module's `skill/references/`. The processor definition and code may live under `runtime/context-processors/<id>/`, or under the owning module's runtime directory. Reference the authoritative file instead of copying it into code.

Mark the preserved prose with its ordinary fidelity label. Mark processor JSON, native code, minimal routing text, and tests as `generated-runtime`. Map the source EJS control block and every emitted branch in provenance. Archive the complete original EJS and report any unresolved API or lifecycle behavior.

## Testing

Test every branch boundary, missing or malformed dependency behavior, multiple-fragment selection, empty selection when allowed, declared failure policy, fragment order, and any opening-specific condition. Semantic fidelity review must compare each selected fragment with the source branch text; syntax conversion alone is insufficient.
