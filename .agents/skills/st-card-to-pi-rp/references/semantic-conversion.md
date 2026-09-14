# Semantic Conversion

This conversion reorganizes authored material while preserving its language. It is not a rewrite pass.

## Classification axes

Classify each source unit on four independent axes.

### Function

- `world-fact`: objective setting or history.
- `character`: identity, appearance, motivation, behavior, relationship, voice, capability, knowledge, belief, or secret.
- `writing-rule`: instruction governing prose, pacing, viewpoint, agency, or characterization.
- `scene-rule`: instruction used only in a particular situation.
- `output-module`: status bar, “meanwhile” side story, thought channel, commentary, choice list, summary, or other source-required text outside the main narrative.
- `opening`: visible greeting or facts that only initialize one opening.
- `example`: style/dialogue example, not automatically historical fact.
- `metadata`: author-facing information not used during play.
- `unknown`: meaning cannot be classified safely.

### Scope

- `foundation`: needed to understand most ordinary turns or many other concepts.
- `domain`: a cross-cutting system such as economy, combat scale, magic, cultivation, law, society, travel, medicine, or chronology.
- `entity`: one concrete character, faction, place, object, ability, species, event, or unique concept.

### Loading policy

- `fixed`: belongs in the single compact foundation prompt and may be repeated across many Agent/model calls.
- `on-demand`: read when the topic, scene, participant, or planned content makes it relevant.
- `opening-once`: used to initialize one mutually exclusive opening.
- `conditional-rule`: read only for its declared scene or output condition.
- `archive-only`: retained for fidelity but not used in RP.

### Truth status

- `objective-canon`.
- `character-belief`.
- `rumor-or-disputed`.
- `opening-state`.
- `style-example`.
- `author-meta`.

Do not flatten these statuses. A character's belief and a narrator-facing secret may contradict without either being a conversion error.

## Fidelity transformation labels

Use the least invasive valid transformation.

1. `verbatim`: exact authored text moved as a whole.
2. `format-only`: headings, whitespace, macro form, or list formatting changed without changing wording.
3. `split`: one authored passage divided at natural topic boundaries; words remain unchanged.
4. `merged`: multiple authored passages placed together without rewriting their prose.
5. `summary-anchor`: a short generated statement that makes a detailed document discoverable.
6. `bridge`: a minimal connective sentence required because split passages no longer have their original surroundings.
7. `generated-runtime`: generic runtime instruction, never presented as card-authored canon.

Do not use `summary-anchor` or `bridge` merely to make prose sound smoother. The author's unusual phrasing, repetition, terseness, ambiguity, and emotional cadence may be part of the intended experience.

## Splitting mixed material

An original lore entry may mix several functions. Split only at intact paragraph, list-item, or clearly independent clause boundaries.

Example source:

```text
灵木界的修士主要使用灵石交易。普通客栈一晚通常只需一枚下品灵石。

描写购物时不要随意让昂贵法宝变得廉价。

玄天宗控制着西北最大的灵石矿。
```

Valid result:

- Move the first paragraph verbatim into one `card-context-library/documents/world/economy.md` delivery unit.
- Move the second paragraph verbatim into an economy-related scene rule or keep it adjacent as an authored operational rule, depending on its intended force.
- Move the third paragraph verbatim into one `card-context-library/documents/world/faction-xuantian.md` delivery unit.
- Add only a short anchor such as “灵木界以灵石作为修士社会的主要货币” to the fixed world overview if that fact is foundational.

Do not replace the three paragraphs with a newly written economic system.

## Merging dispersed material

When multiple entries describe the same domain or entity, place their original passages under descriptive subheadings in one authoritative file. Preserve contradictions and mark them in the report. Do not silently choose one version, average values, or invent a reconciliation.

Remove an exact duplicate only when it is textually or semantically certain to be accidental. Record the duplicate mapping in provenance.

## Foundation-prompt test

Place a unit in `core/foundation.md` only when it contributes to one of these compact source-supported roles:

- a high-level introduction to the world, premise, and participant positions needed to understand the card;
- the story's overall tone, principles, or long-term direction, when the source actually states them;
- a minimum identity or relationship anchor without which the premise is unintelligible.

Do not place detailed character material, scene rules, creative guidance, style, formatting, checking instructions, or document routing indexes in the foundation merely because every final response eventually depends on them. Those materials belong in the card context library, where an Agent reads them at the appropriate analysis, planning, writing, or checking phase. Do not promote a detail merely because it was a blue/constant worldbook entry in ST, and do not invent a broad overview when the source lacks one.

## Domain versus entity

- A domain explains how a class of things works across the world.
- An entity explains what one named thing is.

“灵石是主要货币，兑换与物价遵循……” belongs in an economy domain. “赤霞灵石是一枚被诅咒的上品灵石……” belongs in an item dossier.

## Character placement

- Put complete focal-character material in `card-context-library/documents/character/`; export it with the `character` category and mark genuinely indispensable sections `required` at their applicable phases.
- Put supporting or incidental characters in separate `character` documents; use `conditional` plus explicit `readWhen` guidance when they are present, mentioned, investigated, or prepared to enter.
- A large world card may have no primary character. The selected opening and current scene determine which dossiers are loaded.
- Keep character knowledge, belief, secret, and objective truth distinguishable. Do not reveal narrator-only material through character dialogue without a causal path.

## Rules

- Put card-specific author rules in `card-context-library` category `rule`; use `required` when every final narrative must obey them and `conditional` for scene-specific rules.
- Put rules describing how the fictional world works in category `world`, not `rule`.
- Convert every `output-module` into a frontend feature module. Its authored prompts belong in that module's skill, and its generated content is stored and rendered in the Web feature rail rather than appended to the main chat prose.
- Use `rules/outputs/` only for authored rules that influence presentation of the main narrative itself and do not produce a separate output channel.
- Keep the universal player-agency and continuous-RP protocol in the shared runtime, not duplicated in every card.

## Openings

Treat greetings as mutually exclusive story branches. Preserve their visible prose. Opening-specific place, time, relationships, clothing, participants, and already-completed events initialize only that session.

Do not copy every opening fact into global canon. Do not treat alternate greetings as dialogue examples.

## Catalog routing

An anchor must be:

- True according to the detailed source.
- Shorter and less specific than the authoritative detail.
- Sufficient for the Agent to recognize relevance.
- Linked to the authoritative file.

Every static creative document is listed in `features/card-context-library/catalog.json`. Workflow callers select categories; the module returns every matching whole document plus a generated `DOCUMENTS.md` containing summaries and reading metadata. Fixed and code calls are the normal route; Agent `rp_call` is reserved for workflows that genuinely need dynamic retrieval.

### Future author intent for director-enabled cards

When `world-narrative-coordinator` is selected, route prose about unrevealed future events, later world-state changes, intended outcomes, and future handling into `card-context-library` documents categorized `director-future`. Prefer the author's original natural language. Split by coherent future line, add stable anchors, and mark converter inference explicitly. Pure style, tone, pacing, and general creative principles remain in `narrative-guidance`, `rule`, or `style` so both the narrative writer and director can read them. Never export `director-future` from an ordinary narrative context call.
