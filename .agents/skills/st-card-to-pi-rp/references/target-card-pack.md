# Target Pi RP Card Pack

Generate one data card pack per converted card. Do not generate one discoverable Skill per card.

## Directory layout

```text
play/cards/<card-id>/
├── manifest.json
├── settings.json
├── source/
│   ├── original.*
│   ├── extracted.json
│   └── unsupported/
├── core/
│   ├── story.md
│   ├── world.md
│   ├── active-cast.md
│   └── knowledge-map.md
├── characters/
│   └── primary/
├── world/
│   ├── domains/
│   └── entities/
│       ├── factions/
│       ├── locations/
│       ├── characters/
│       ├── items/
│       ├── abilities/
│       ├── species/
│       ├── events/
│       └── concepts/
├── rules/
│   ├── core.md
│   ├── scenes/
│   └── outputs/
├── features/
│   └── <module-id>/
├── context/
│   ├── retrieval-policy.json
│   └── skill/SKILL.md          # required only for Agent-enabled message retrieval/catalog
├── runtime/
│   └── context-processors/
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

The standalone runtime root is `play/`. It owns `play/settings/common.json` for settings shared by every card, such as player name and story font size. Card-specific controls and values belong only in the card's `settings.json`. When frontend modules exist, runtime adds `settings.featureModules` with an `order` array and a `hidden` array. This record is a player-facing display preference only and must never be used to assemble Agent context.

## Manifest

Use UTF-8 JSON so the validation script can parse it without additional dependencies.

```json
{
  "schema_version": 1,
  "id": "card-id",
  "name": "角色显示名",
  "cover": "source/original.png",
  "source": {
    "format": "ccv3-json",
    "artifact": "source/original.json",
    "sha256": "..."
  },
  "fixed_context": [
    "core/story.md",
    "core/world.md",
    "core/active-cast.md",
    "rules/core.md",
    "core/knowledge-map.md"
  ],
  "knowledge_map": "core/knowledge-map.md",
  "primary_characters": [
    "characters/primary/character-name.md"
  ],
  "context_policy": "context/retrieval-policy.json",
  "context_processors": [],
  "feature_modules": [],
  "openings": [
    {
      "id": "opening-00",
      "title": "默认开场",
      "file": "openings/00.md",
      "source": "first_mes",
      "recommended_context": []
    }
  ],
  "default_opening": "opening-00",
  "default_output_modules": []
}
```

Remove nonexistent optional fixed-context paths from the actual manifest. A world card may use an empty `primary_characters` array.
Use a filesystem-safe `id` containing only letters, digits, dots, underscores, and hyphens; it is also the card's grouping directory under `sessions/`.
When an authored image is available, `cover` is required and points to its card-relative preserved copy. A PNG/APNG packaged card always has an available cover because the input image is the cover. Preserve and reuse the original bytes rather than generating a replacement. Omit `cover` only when the supplied JSON, CHARX, or Tavern Sync source genuinely contains no usable local character image; record that disposition in the conversion report.

The baseline `context/retrieval-policy.json` is:

```json
{
  "schemaVersion": 1,
  "source": "messages",
  "code": { "profile": "default" },
  "agent": {
    "mode": "disabled",
    "fallback": "code",
    "onNotTriggered": "code",
    "maxRecords": 100
  },
  "catalog": { "codeProfile": "default", "agentMode": "disabled" }
}
```

`context_policy` is required. Use code profile `default` unless the card author has a precise deterministic transcript rule; the default retrieves all message records. Add Agent append or override only when authored semantic selection is needed.

When the message policy enables Agent retrieval or Agent catalog enrichment, add `"context_skill": "context/skill/SKILL.md"` to the manifest. That skill owns the author's activation, selection, non-activation, and catalog-enrichment guidance for message records. A code-only card does not need it.

`feature_modules` is required and contains card-relative `module.json` paths. Keep it empty only when the source has no persistent structured feature, side panel, or auxiliary output. Every source-required output outside the main narrative is a frontend module using the post-narrative output engine. Module definitions use strict version 3 with storage version 2; read [feature-modules.md](feature-modules.md) before creating one. Each module owns its prompts in a card-local skill, record/data schemas, and retrieval policy. Native variable modules additionally follow [variables.md](variables.md). Its `contextOrder` is authored Agent behavior, while `displayOrder` affects only the frontend. Background modules remain in Agent context and per-chat storage but never appear in the Web UI.

`context_processors` is required and contains card-relative processor JSON paths, or `[]` when the card has no deterministic dynamic prompt behavior. Processors run before narrative generation, after fixed card/player/primary-character context and before retrieved history/module records. Their authored `contextOrder` controls processor order and is unrelated to Web settings. Read [ejs-conversion.md](ejs-conversion.md) for the strict version 1 contract.

## Fixed files

### `core/story.md`

Contain only the stable premise, themes, player position, long-running conflict, and viewpoint needed to understand the intended story. Use original passages where they already express these points. Generated connective text must be minimal and mapped as `bridge`.

### `core/world.md`

Contain foundational facts required for most ordinary turns. Detailed systems and named entities remain in on-demand modules. Include short anchors such as “灵木界以灵石作为修士社会的主要货币” only when necessary to make the world intelligible.

### `core/active-cast.md`

List primary characters and short authored or faithfully derived identity anchors. Full primary-character text lives in `characters/primary/` and is also listed in the manifest.

### `rules/core.md`

Contain only card-specific rules that apply to nearly every response. Do not duplicate the universal runtime protocol.

### `core/knowledge-map.md`

Route the Agent to domain documents, important entity dossiers, category indexes, and conditional scene rules. Feature-module routing is supplied by the runtime and each module skill; do not duplicate module prompts here.

## On-demand module frontmatter

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

The body after frontmatter is authoritative authored detail. Preserve original passages under helpful headings. Frontmatter summaries and `read_when` lines are generated routing aids, not new canon.

Category indexes use the same principle and list one faithful anchor plus the target path for each contained entity.

## Primary-character files

Use only sections supported by source material. Typical headings include identity and appearance, stable personality, desires and fears, abilities and limits, initial relationship, other relationships, speech and behavior, known information, mistaken beliefs, and secrets.

Do not add empty headings or fill missing sections. Preserve authored prose and lists under the closest applicable heading.

## Openings

Each opening is a Markdown file with minimal routing metadata followed by the original greeting:

```yaml
---
id: opening-00
title: 山门初遇
participants:
  - "{{char}}"
location: 玄天宗山门
recommended_context:
  - world/entities/factions/xuantian.md
  - world/entities/locations/xuantian-gate.md
---
```

Metadata may be generated only from facts explicit in the opening. Preserve the visible greeting verbatim except for necessary macro or formatting normalization.

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
          "file": "world/domains/economy.md",
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
