---
name: st-card-to-pi-rp
description: Analyze and convert SillyTavern character cards and Tavern Sync sources into Pi RP card packs, first presenting a concise proposal and waiting for confirmation, then producing fixed/on-demand context, native code processors, variable or feature modules, openings, provenance, and fidelity checks. Preserve source semantics and wording without executing source EJS, Tavern Helper scripts, or legacy MVU output protocols.
---

# SillyTavern Card to Pi RP

Convert the authored setting and intended RP experience, not SillyTavern's prompt-assembly mechanism. Treat ST activation colors, insertion positions, depth, order, recursion, stickiness, cooldown, and probability as source metadata only. Do not reproduce them as Pi runtime behavior.

## Non-negotiable fidelity rule

Preserve the card author's wording and style as the default transformation strategy.

- Prefer splitting, sorting, moving, and recombining original passages over rewriting them.
- Do not expand sparse settings, normalize the author's voice, resolve deliberate ambiguity, or invent connective canon.
- Add only the shortest summary anchors, navigation lines, headings, or connective sentences necessary to make the reorganized material usable.
- Never let a generated summary replace the authoritative original passage it summarizes.
- Mark every target passage as `verbatim`, `format-only`, `split`, `merged`, `summary-anchor`, `bridge`, or `generated-runtime` in `provenance.json`.
- If faithful classification is uncertain, preserve the original text in `unresolved.md` and report the ambiguity instead of guessing.

## Supported scope

Handle character identity and setting fields, scenario, first and alternate greetings, dialogue examples, plain-text lorebooks, and variable definitions/update semantics that can be represented by the native Pi RP variable engine. Basic macros such as `{{char}}` and `{{user}}` may remain as runtime placeholders.

The generated RP content targets Pi agent. Python 3 is required only for the optional extraction and validation scripts; the optional local Web UI requires Node.js 20 or newer.

If code-dependent content is present, convert supported semantics into native Pi RP processors, module hooks, update workflows, retrieval guidance, or Web views; archive unsupported source unchanged and list it in the report. Never execute embedded HTML, JavaScript, EJS, Tavern Helper imports, or card-provided commands during conversion. Do not parse or preserve legacy `<UpdateVariable>` output as a runtime protocol; translate variable structure, defaults, relationships, constraints, update rules, and references into the native module instead.

## Mandatory proposal and confirmation gate

An ordinary request to convert a card authorizes source inspection and proposal preparation only. Do not create or modify the destination card pack, runtime, frontend, provenance, or session files until the user explicitly confirms that formal conversion should begin. Read-only inspection is allowed; if extraction is necessary for analysis, use a disposable temporary location rather than the intended output directory.

### 1. Analyze before proposing

Inspect the source deeply enough to identify its actual content and mechanics. At minimum determine:

- primary and supporting characters, premise, world material, greetings, examples, and writing/output rules;
- likely fixed context, on-demand domains/entities/rules, and the anchors needed to keep them discoverable;
- persistent state, side panels, or special behavior that may need feature modules;
- code-dependent, externally referenced, contradictory, ambiguous, or unsupported material;
- every EJS block's reads, branches, emitted text, side effects, external APIs, and GENERATE/INJECT/RENDER lifecycle;
- fidelity risks, especially passages whose voice or meaning could be damaged by rewriting.

Also read [global-modules.md](references/global-modules.md) and inspect the current project's `global-modules/*/module.json` packages before preparing the proposal. Global workflow skills, modules inside other cards, converter templates, and session data are not global feature modules.

Do not demand a series of decisions before giving the user a useful first proposal unless the source cannot be inspected at all.

### 2. Present a concise conversion proposal

Summarize the proposed treatment rather than dumping the full inventory. Cover:

1. overall card positioning and intended RP experience;
2. what will remain fixed every turn;
3. how world, character, rule, and opening content will be split or kept on demand;
4. each proposed feature module, including its purpose, visible/background status, storage shape, and retrieval approach;
5. every available project-global module, its relevance or conflict, and the card-specific adaptation it would require;
6. unsupported/adapted behavior and the most important fidelity or design uncertainties.

State that original wording will be preserved primarily through splitting, sorting, and regrouping. When valid global modules exist, explicitly ask which ones to import; do not silently select them, and do not treat a general instruction to begin as a module selection unless the user explicitly delegates the choice. If none exist, state that discovery found none without asking an empty question. End with a small numbered list of decisions that would benefit from discussion, and offer to discuss any or all of them one by one. Unless the user already gave explicit advance confirmation to start directly, end the turn after the proposal and wait without writing output files.

### 3. Discuss and revise when requested

When the user chooses an item, discuss that item at the level needed to make a real decision, record the decision in the conversational proposal, and show only the affected revision. Guide the user to the next unresolved item or to final confirmation; do not force discussion of low-impact choices the user is happy to delegate.

Continue this loop until the user explicitly says to begin, confirms the current proposal, or gives equivalent unambiguous authorization. Agreement with one design detail is not overall authorization. If the initial request explicitly says to skip discussion and start directly, treat that as advance confirmation, but still communicate the concise proposal before making material changes.

### 4. Formal conversion after confirmation

Once confirmed, treat the latest proposal and decisions as the implementation contract. If later source discovery requires a material change to that contract, pause, explain the change, and obtain confirmation again. Minor file naming and mechanical details do not require renewed approval.

## Formal conversion workflow

1. Establish a new output directory. Never modify the source card or source project. This is the first step that may write the formal result.
2. Inventory the input using [source-inventory.md](references/source-inventory.md). For PNG, JSON, or CHARX inputs, use `scripts/extract_card.py` when useful. Read Tavern Sync source directories directly from their `index.yaml` and referenced text files.
3. Create stable source units before reorganizing content. A unit is the smallest passage that can move independently without changing its meaning. Preserve its exact original text and source location.
4. Read [semantic-conversion.md](references/semantic-conversion.md) and classify units by function, scope, loading policy, and truth status. Ignore ST activation configuration when deciding the Pi structure.
5. Build the card pack described in [target-card-pack.md](references/target-card-pack.md). Import only the project-global modules selected or explicitly delegated during the proposal, copying each into the card rather than linking to the global package; follow [global-modules.md](references/global-modules.md) for collision and adaptation rules. Keep foundational world facts, the story premise, primary-character material, core card-specific writing rules, and a compact knowledge map in the fixed context. Move domain details, entity dossiers, supporting characters, conditional scene rules, and optional output modules into discoverable on-demand files. Create the card's message retrieval policy. When source EJS or embedded prompt code exists, read [ejs-conversion.md](references/ejs-conversion.md), classify each behavior, and convert deterministic prompt selection to native context processors without executing the source. When the source contains persistent structured state or a card-specific function, read [feature-modules.md](references/feature-modules.md) and convert it into a version 3 module with storage protocol version 2, common records, its own skill, and an explicit retrieval policy. For source variables, also read [variables.md](references/variables.md) and build a native full-snapshot variable module. Choose Agent `contextOrder` from instruction dependencies and intended model behavior; choose `displayOrder` independently for presentation. Use a background module when the function needs the same data and prompt lifecycle but no visible Web panel.
6. Keep each greeting as a mutually exclusive opening. Preserve its visible prose with only macro and format adjustments. Do not regenerate or paraphrase an opening.
7. Generate `provenance.json`, `unresolved.md`, and `conversion-report.md`. Every non-empty source unit must be mapped, explicitly archived as metadata, marked unsupported, or marked unresolved.
8. Read [validation.md](references/validation.md), run `scripts/validate_card_pack.py`, and perform the semantic fidelity checks it cannot automate.
9. When the destination is intended to be a standalone RP project and does not already contain a runtime, copy the generic files from `assets/pi-rp-runtime/`. Read [web-runtime.md](references/web-runtime.md), create the card's typed `settings.json`, and copy `assets/pi-rp-web/` into the converted card as `<card-pack>/web/`. Keep shared settings in project-level `settings/common.json` and card-defined settings in the card file. Every card owns its frontend so later card-specific presentation can evolve independently. Do not overwrite an existing runtime or frontend without explicit permission.

## Conversion decisions

- A fact belongs in fixed context only when it is broadly required to interpret ordinary turns, foundational to many other concepts, or part of a primary character that must be portrayed every turn.
- A cross-cutting system such as economy, cultivation, combat scale, law, travel, or medicine belongs in a domain module.
- A concrete faction, location, person, item, ability, species, event, or unique concept belongs in an entity dossier.
- A writing instruction belongs in `rules/`; do not misclassify it as world fact.
- A feature module is for persistent structured chat state or a card-specific side panel. Do not create one from ordinary lore merely to fill the Web rail.
- Project-global modules are reusable sources, not runtime dependencies. Discover them before the proposal, ask the user which to import, and copy only the confirmed set into the card. Never infer selection from apparent relevance alone.
- Feature-module context order is authored behavior. Never derive it from frontend selection or display order; frontend preferences cannot alter the Agent's prompt sequence.
- Retrieval is authored behavior. Use code defaults as the reliable baseline, a custom deterministic selector when the source rules are precise, Agent append for semantic additions, and Agent override only when semantic choice must replace the code baseline. Code always performs the final exact extraction through record IDs/selectors.
- When message-history retrieval or its catalog enables Agent behavior, create a card-local `context_skill` containing the author's activation, query, non-activation, and catalog guidance. Code-only message retrieval needs no context skill.
- Keep every module-specific prompt in that module's skill directory. Shared card/runtime prompts may route to the skill but must not duplicate its definitions or activation/update rules.
- A native variable module preserves authored variable structure, defaults, constraints, relationships, semantic update rules, and prompt references. Narrative context receives only authored fixed references and exact on-demand projections; the post-narrative update task always receives the complete effective state.
- EJS is a source behavior description, not a target runtime. Convert exact branches to deterministic code, semantic conditions to skill-guided Agent retrieval, state changes to their owning module workflow, and display-only behavior to Web views. Context processors may select only declared authoritative fragments and never persist changes.
- A statement that is only a character's belief must not be promoted to objective world truth.
- Opening-specific facts initialize that opening's session and do not become universal canon.
- Full details have one authoritative home. Fixed context may repeat only a short, faithful anchor that points to that home.

## Discoverability invariant

No on-demand document may become a dead file. Important concepts receive a direct one-line anchor in `core/knowledge-map.md`. Large collections may use a category index, but every document must be reachable from the fixed knowledge map in at most two reads. Give each module a summary, aliases, `read_when` guidance, related IDs, and source references.

## Required result

Deliver a runnable card pack, the original/extracted source, a complete provenance map, unresolved content, a conversion report, and validation results. A standalone project also includes the shared Pi RP runtime; every card includes its own local Web view copied from the template. Summarize what was preserved verbatim, what was split or merged, every generated anchor or bridge, and all unsupported material.
