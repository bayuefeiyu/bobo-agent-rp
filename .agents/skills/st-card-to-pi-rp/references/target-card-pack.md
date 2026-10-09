# Target Pi RP Card Pack

Generate one data card pack per converted card. Do not generate one discoverable Skill per card.

## Directory layout

```text
play/cards/<card-id>/
├── manifest.json
├── runtime-lock.json
├── settings.json
├── defaults/
├── prompts/
│   ├── system/                 # public common SYSTEM and tool prompts
│   ├── model-heads/            # public model head prompts
│   ├── model-tails/            # public model tail prompts
│   ├── prefix/                 # public common prefix prompts
│   └── tail/                   # public common tail prompts
├── source/
│   ├── original.*
│   ├── extracted.json
│   └── unsupported/
├── core/
│   └── foundation.md
├── features/
│   ├── card-context-library/
│   │   ├── catalog.json
│   │   ├── documents/
│   │   ├── runtime/
│   │   ├── skill/
│   │   └── workflows/
│   └── <other-module-id>/
│       ├── module.json
│       ├── agents/
│       ├── prompts/
│       ├── workflows/
│       ├── runtime/
│       ├── documents/
│       └── ...                 # the complete selected module package
├── context/
│   ├── retrieval-policy.json
│   └── skill/SKILL.md          # required only for Agent-enabled message retrieval
├── runtime/
│   ├── launch.json
│   ├── engine/                 # card-owned Pi extension, libraries and gameplay Skills
│   └── context-processors/     # card-owned deterministic processors
├── openings/
├── web/
│   ├── public/
│   ├── server/
│   └── server.mjs
├── provenance.json
├── unresolved.md
└── conversion-report.md
```

Copy the standard Web view into `web/`; it belongs to this card and may later be customized without affecting other cards. Create `settings.json` even when the card has no unique settings yet. Keep it as a typed empty object rather than inventing controls:

```json
{
  "schemaVersion": 1,
  "cardId": "card-id",
  "settings": {}
}
```

The play root holds the lightweight selector and session storage. Each independent card owns its Pi RP runtime, complete Agent definitions, prompts, behavior defaults, Web frontend and card settings. The card's `defaults/common.json` supplies initial player and display values; user changes are recorded in `settings.json`, and avatars belong to the card. When frontend modules exist, runtime adds `settings.featureModules` with an `order` array and a `hidden` array. This record is a player-facing display preference only and must never be used to assemble Agent context. Credentials remain in the operating-system cache.

Selected foreground and background entry workflows are copied with their owning module and remain card-owned definitions. They retain their authored triggers, and `settings.activeWorkflowId` stores the fully qualified selected foreground ID such as `narrative-controls/standard-rp`. Every referenced Agent needs a complete module-owned `agent.json` registered by its module manifest; a named configuration profile may change its fields under the exact `module/<owner>/agent/<local>` key. Missing card-owned definitions are errors. Read [workflow-system.md](workflow-system.md) before creating either structure.

Every authored Agent prompt and Agent／team node task is a Markdown file in its owning module, referenced by a module-relative `promptFile` such as `prompts/agents/<id>.md` or `prompts/workflows/<workflow>/<node>.md`. Module runtime code uses module-relative `entryFile` paths such as `runtime/<script>.mjs`; no module prompt, Agent, workflow, or runtime file is copied to a card-root directory. Root `prompts/` contains only public common prompts and model heads/tails. New card definitions require file-backed prompts.

## Manifest

Use UTF-8 JSON so the validation script can parse it without additional dependencies.

```json
{
  "schema_version": 2,
  "id": "card-id",
  "name": "角色显示名",
  "cover": "source/original.png",
  "source": {
    "format": "ccv3-json",
    "artifact": "source/original.json",
    "sha256": "..."
  },
  "fixed_context": "core/foundation.md",
  "context_policy": "context/retrieval-policy.json",
  "context_processors": [],
  "feature_modules": [
    "features/card-context-library/module.json",
    "features/narrative-controls/module.json"
  ],
  "openings": [
    {
      "id": "opening-00",
      "title": "默认开场",
      "file": "openings/00.md",
      "source": "first_mes"
    }
  ],
  "default_opening": "opening-00"
}
```

`fixed_context` is exactly one card-level foundation document. Do not place a knowledge map, complete character dossier, detailed rule set, style guide, or format guide in this field. Every converted card includes the card-owned `card-context-library` resource module, even when its catalog is initially empty; the standard foreground workflow depends on its export workflow.
Use a filesystem-safe `id` containing only letters, digits, dots, underscores, and hyphens; it is also the card's grouping directory under `sessions/`.
When an authored image is available, `cover` is required and points to its card-relative preserved copy. A PNG/APNG packaged card always has an available cover because the input image is the cover. Preserve and reuse the original bytes rather than generating a replacement. Omit `cover` only when the supplied JSON, CHARX, or Tavern Sync source genuinely contains no usable local character image; record that disposition in the conversion report.

The baseline `context/retrieval-policy.json` is:

```json
{
  "schemaVersion": 2,
  "source": "messages",
  "code": { "profile": "default" },
  "agent": {
    "mode": "disabled",
    "fallback": "code",
    "onNotTriggered": "code",
    "maxRecords": 100
  }
}
```

`context_policy` is required. Use code profile `default` unless the card author has a precise deterministic transcript rule; the default retrieves all message records. Add Agent append or override only when authored semantic selection is needed.

When the message policy enables Agent retrieval, add `"context_skill": "context/skill/SKILL.md"` to the manifest. That skill owns the author's activation, `rp_message_query` selection, and non-activation guidance. A code-only card does not need it. Message catalogs are derived runtime aids and are never Agent-authored data.

`feature_modules` is required and always includes `card-context-library`. Module schema 7 distinguishes `data`, `resource`, and `hybrid` packages and every kind declares both `agentFiles` and `workflowFiles` in `module.json`. Each owned workflow uses schema 4, declares its `ownerModuleId`, and keeps `promptFile`/`entryFile` module-relative; Agent, workflow, and trigger references use fully qualified `module-id/local-id` values. Resource-only modules own static authored files and workflows without inventing session collections; data and hybrid modules use data-contract v1. Every source-required output outside the main narrative remains a frontend data-module record type produced by an ordinary workflow node. Read the authoritative [unified data protocol](../../design-pi-rp-data/references/protocol.md), [feature-modules.md](feature-modules.md), and [variables.md](variables.md) before creating one.

`narrative-controls` is a complete正文 feature module when selected: it owns `narrative-writer`, the `narrative-controls/standard-rp` and `narrative-controls/advanced-memory-rp` foreground entries, and `prepare-recent-narrative-stories`. It is not an isolated optional control panel. If it is declined, the card must install or create another module-owned foreground entry that supplies the full narrative path; no card may leave controls without a valid foreground implementation. `comfy-image-generation`, `narrative-memory`, and `world-narrative-coordinator` follow the same intact-module rule, including their module-local Agents, workflows, runtime components, documents, and any `-entry` wrappers.

`design_invariants` is optional and declares what *this* card promises about its own design, so validation can check the card against its declaration rather than against a shipped template:

```json
"design_invariants": {
  "foregroundWorkflow": "narrative-controls/standard-rp",
  "requiresCardContextResources": true,
  "requiresEffectiveMemoryTimeline": true,
  "requiresNarrativeAgentCallable": ["narrative-memory/narrative-memory-retrieve"]
}
```

`foregroundWorkflow` names the selected fully qualified module foreground workflow and is required whenever another key is present; `requiresCardContextResources` requires a call to `card-context-library/export-context`; `requiresEffectiveMemoryTimeline` requires the effective memory timeline to be prepared before that export; `requiresNarrativeAgentCallable` lists module-workflow references every narrative Agent in that workflow must expose. Declared invariants are validated as errors, and a card that declares none is left alone — a renamed, replaced, or decoupled foreground module is legitimate. Write the declaration for a card built on the shipped templates, as described in [validation.md](validation.md).

`context_processors` is required and contains card-relative processor JSON paths, or `[]` when the card has no deterministic dynamic prompt behavior. Processors run before narrative generation, after fixed card/player/primary-character context and before retrieved message history and upstream workflow output. Module data enters only through the processor's declared `dataQueries` or the active node's authorized data tools. Their authored `contextOrder` controls processor order and is unrelated to Web settings. Read [ejs-conversion.md](ejs-conversion.md) for the strict version 2 contract.

## Fixed foundation

### `core/foundation.md`

Contain only a compact, source-supported overview of the world and premise plus the story's long-term tone, principles, and direction when the source provides them. Add only the minimum identity or relationship anchors needed to understand the card. It is reused in many prompt assemblies, so stage-specific writing, formatting, scene, and style instructions do not belong here even when every creative turn eventually needs them.

Do not invent a broad overview when the source does not provide one. Preserve source wording where possible and map every generated bridge or summary anchor in provenance.

## Card context library

Copy `assets/card-context-library/` into `features/card-context-library/`, then fill its `catalog.json` and `documents/`. Every document is one indivisible delivery unit: the export workflow may deliver the whole file but never a subsection. Preserve original passages through splitting, sorting, and regrouping before deciding these boundaries.

The standard categories are:

- `world`: static world facts, systems, history, places, factions, objects, and concepts;
- `character`: complete character, relationship, knowledge, secret, speech, and behavior material;
- `narrative-guidance`: plot, pacing, theme, conflict, scene, and long-term development guidance;
- `rule`: binding or conditional author rules and prohibitions;
- `style`: narrative voice, viewpoint, language, description methods, and style examples;
- `format`: response structure, paragraphing, markup, length, and special formatting;
- `reference`: exploratory examples, glossaries, inspiration, and completeness aids.

Each catalog entry declares path, title, summary, categories, optional subcategory, `readPolicy`, `authority`, `appliesAt`, priority, optional selection group, `readWhen`, perspective, aliases, related IDs, and sources. `readPolicy` is `required`, `conditional`, `choice`, or `optional`; authority is independently `binding`, `canonical`, `advisory`, or `exploratory`.

Choice documents reference a catalog-level selection group. A group declares `one`, `at-most-one`, `one-or-more`, or `any`, an explicit selection instruction, and an optional fallback member. This lets an Agent choose among multiple authored styles or guides without treating every delivered candidate as simultaneously active.

`card-context-library/export-context` deterministically exports all documents matching the caller's categories as one `document-set`. The set contains `DOCUMENTS.md` plus each independent document. The caller normally uses a fixed `call` node or code call; dynamic Agent calls are an extension point. More selective cards may customize or replace this workflow.

### Optional project prompt templates

The project provides optional starter material below `assets/prompt-templates/`. This directory is a conversion asset rather than part of the Pi runtime template source, so its files remain conversion-only copying sources. They are not card source material, do not create a new runtime prompt layer, and are never included merely because they exist.

- Files below `agent-preferences/` are optional fixed-prompt snippets for explicitly selected Agents. They may target creative, summary, archive, or other Agents. Preserve the Agent's original task, tools, delivery contract, and module-specific responsibilities. `common-creative.md` is prepended once to each selected creative Agent unless the confirmed proposal states another order.
- Files below `task-defaults/` are optional snippets for explicitly selected workflow-node task prompts. The shipped entry points cover output language, continuation or expansion, and length, but creators may freely add other files and subdirectories. A current player instruction may still override a default when the authored card rules allow it.
- Files below `static-materials/` are optional static documents. Import them into `features/card-context-library/documents/` and catalog them together with source-authored documents, recording the template path in their source metadata. Styles, creative guidance, rules, and other static material receive their actual target Agents, categories, `readPolicy`, `appliesAt`, `readWhen`, selection guidance, and fallback behavior from the confirmed proposal; never infer these from a file or directory name. The reserved `static-materials/INDEX.md` is a conversion guide rather than a selectable document.

Discover templates recursively from the actual files, excluding `static-materials/INDEX.md`. Creators may add, delete, rename, and reorganize files and subdirectories without maintaining an exhaustive registry. Empty and HTML-comment-only files are unavailable. Directory layout does not define mutual exclusion, combination order, or runtime behavior.

When `static-materials/INDEX.md` exists, read it as free-form natural language without requiring headings, named fields, lists, or a fixed entry format. Identify the referenced materials and intended use conditions from its meaning; clarify only ambiguous references or conditions. Resolve referenced material paths relative to `static-materials/`. Report missing files and directory references without guessing replacements. The index may cover only some templates and does not select anything. For selected materials with presets, ask compactly whether to reuse the described timing; accept, revise, or decline it per the user's answer, and skip the question when the user already instructed the conversion to use the presets. Do not copy the index into the card.

The conversion proposal records each selected passage, destination, and prompt-snippet order. Fixed-prompt snippets and static documents may contain similar guidance; preserve that choice without automatic splitting, moving, or deduplication, and report concrete behavioral conflicts. Unselected templates do not enter the card. Imported templates must be identified in the conversion report as optional project-provided starter material rather than source-authored text. Once copied, all such text belongs to the card and may be edited without changing the project template or any other card.

Template-derived and source-authored static documents form one final resource collection. Build their catalog and `DOCUMENTS.md` with the same rules, then inspect the collection as a whole. When an Agent needs a top-level reminder before entering the document set—for example, “read the creative guidelines before writing” or “select the style matching this scene”—put that concise reminder in the relevant workflow call node's `metadata.documentIndex.description`. Keep document-specific conditions and choice details in the catalog-generated `DOCUMENTS.md`. Perform this check even when no template static material was selected but the source card itself contains multiple styles or authored guidance.

## Optional document frontmatter

Use a consistent Markdown frontmatter schema:

```yaml
---
id: domain-economy
kind: domain
summary: 灵木界以灵石作为修士社会的主要货币。
read_when:
  - 涉及购买、出售、价格、收入或资源价值
aliases:
  - 经济
  - 货币
  - 灵石
related:
  - entity-faction-merchant-league
sources:
  - lore:entry-17:p001
---
```

The body after frontmatter is authoritative authored detail. Catalog metadata is the machine-readable routing authority; frontmatter may mirror useful fields for human maintenance but must not contradict the catalog.

## Character documents

Use only sections supported by source material. Typical headings include identity and appearance, stable personality, desires and fears, abilities and limits, initial relationship, other relationships, speech and behavior, known information, mistaken beliefs, and secrets.

Do not add empty headings or fill missing sections. Preserve authored prose and lists under the closest applicable heading.

## Openings

Each opening is a Markdown file with minimal routing metadata followed by the original greeting:

```yaml
---
id: opening-00
title: 山门初遇
participants:
  - "确定的角色姓名"
location: 玄天宗山门
recommended_resources:
  - world-faction-xuantian
  - world-location-xuantian-gate
---
```

Opening Markdown may contain human-facing resource hints using catalog document IDs, but the manifest no longer has a runtime `recommended_context` field. The resource snapshot and its index are prepared by workflow calls. Preserve the visible greeting verbatim except for necessary macro or formatting normalization.

## Provenance

`provenance.json` is not runtime context. It proves coverage and records every transformation:

```json
{
  "schema_version": 1,
  "source_units": [
    {
      "id": "lore:entry-17:p001",
      "source": "character_book.entries[17].content paragraph 1",
      "original": "灵木界的修士主要使用灵石交易。",
      "status": "mapped",
      "targets": [
        {
          "file": "features/card-context-library/documents/world/economy.md",
          "section": "基础货币",
          "transform": "verbatim"
        },
        {
          "file": "core/world.md",
          "section": "基础世界观",
          "transform": "summary-anchor"
        }
      ],
      "notes": ""
    }
  ],
  "generated_passages": [
    {
      "file": "core/world.md",
      "section": "基础世界观",
      "kind": "summary-anchor",
      "text": "灵木界以灵石作为修士社会的主要货币。",
      "based_on": ["lore:entry-17:p001"]
    }
  ]
}
```

Allowed source-unit statuses are `mapped`, `metadata-only`, `unsupported`, `unresolved`, and `duplicate`. Allowed transform labels are `verbatim`, `format-only`, `split`, `merged`, `summary-anchor`, `bridge`, and `generated-runtime`.

## Conversion report

Report:

- Input type and detected card features.
- Files produced and openings available.
- Which content remains fixed and which is on demand.
- Counts of each transform label.
- Every generated anchor or bridge and its source units.
- Contradictions preserved.
- Unsupported, unresolved, missing, or externally referenced material.
- Every EJS/template block's native target, preserved branches, and unsupported APIs or lifecycle effects.
- Available project-global modules, the user's selected set, source package paths/versions, and every card-local adaptation.
- Validation commands and results.
