# Source Inventory

Use this reference before interpreting or restructuring a card. The inventory is descriptive; it does not determine the target loading policy.

## Accepted sources

### Packaged cards

- Character Card V1/V2/V3 JSON.
- PNG/APNG cards containing a `ccv3` or legacy `chara` text chunk.
- CHARX archives containing `card.json` and optional assets.

Use `../scripts/extract_card.py` to extract these without changing their content. Prefer `ccv3` when a PNG contains both `ccv3` and `chara`.

### Tavern Sync source directories

Read `index.yaml`, every referenced greeting file, every referenced worldbook file, and any card-setting text file. Preserve the file path and the containing YAML entry name in provenance. Symlinked editor-rule directories are documentation, not card content.

## Content inventory

Record all non-empty content before conversion:

- Card name, nickname, author, version, tags, notes, and source metadata.
- Description, personality, scenario, system prompt, post-history instructions, and depth/character notes when present.
- First message, alternate greetings, and group-only greetings.
- Dialogue examples.
- Embedded or bound character lorebook entries available in the supplied source.
- Plain-text status panels, persistent state definitions, field meanings, and update rules, even when their original display mechanism is unsupported.
- Assets and unknown extension fields.
- References to worldbooks, presets, scripts, URLs, or plugins that are not included in the supplied source.

Creator notes are metadata unless their text clearly contains instructions or canon intended for play. Do not silently inject ordinary installation instructions, acknowledgements, changelogs, or author commentary into RP context.

## Source units

Create a stable ID for every independently movable passage. Prefer source-derived IDs:

```text
description:p001
personality:p001
scenario:p002
opening:00:p003
lore:entry-17:p002
```

Do not split prose sentence by sentence merely to increase granularity. Keep together paragraphs whose rhythm, contrast, or wording depends on their surrounding passage. Split a mixed entry only where its topics or functions genuinely diverge.

For each source unit, retain:

- Exact original text.
- Source file and field or entry ID.
- Whether it is metadata, prose, world fact, character material, instruction, example, opening content, or unknown.
- Any macros or external references it contains.
- Any ambiguity or contradiction noticed during extraction.

## Unsupported-content detection

Flag rather than execute or emulate:

- Executable MVU runtime code, legacy variable-output parsing, message-floor APIs, and variable commands. Inventory schemas, `initvar`, field definitions, constraints, relationships, update rules, and prompt references separately for native variable conversion.
- EJS/template code: inventory reads, branches, emitted text, side effects, external APIs, and lifecycle separately. Never execute it; later classify supported behavior using `ejs-conversion.md` rather than marking the whole block unsupported by default.
- JavaScript/TypeScript, HTML scripts, remote imports, or Tavern Helper script libraries.
- Regex whose purpose is required for gameplay or display.
- Generated UI placeholders, iframe frontends, or code-driven status bars.
- Slash commands and plugin-specific executable directives.

Preserve the raw field or file under `source/unsupported/` when possible. A card with unsupported material may still be converted partially, but the report must state which behaviors will not survive.

When unsupported code is accompanied by separable authored variable semantics, inventory those semantics independently. Preserve the raw code as unsupported, but translate the supported structure, defaults, constraints, relationships, update meanings, and references into the native variable module without executing or emulating the original implementation or its output syntax.

## ST metadata policy

Record activation keys, constant/selective flags, insertion position, role, depth, order, probability, recursion, stickiness, cooldown, and delay only in source inventory or provenance when useful for audit.

Do not use those values to decide the Pi loading policy. Determine fixed versus on-demand placement from the content's semantic role and the target RP workflow.

## Macros

Keep `{{char}}`, `<char>`, `<bot>`, `{{user}}`, and `<user>` as runtime placeholders unless the destination explicitly requires fixed names. List unknown macros in the conversion report and preserve them verbatim until their meaning is known.
