---
name: st-card-to-pi-rp
description: Analyze and convert SillyTavern character cards and Tavern Sync sources into Pi RP card packs, first presenting a concise proposal and waiting for confirmation, then producing fixed/on-demand context, unified-data feature modules, workflows, openings, provenance, and fidelity checks. Preserve source semantics and wording without executing source EJS, Tavern Helper scripts, or legacy MVU output protocols.
---

# SillyTavern Card to Pi RP

Convert the authored setting and intended RP experience, not SillyTavern's prompt-assembly mechanism. Treat ST activation colors, insertion positions, depth, order, recursion, stickiness, cooldown, and probability as source metadata only. Do not reproduce them as Pi runtime behavior.

Run conversion from the repository root. Creating or reconverting the explicitly named destination card does not authorize changes to root Skills, templates, global modules, another converted card, installed runtime, or sessions. Root development likewise does not authorize updating converted cards. Follow the repository-root `PI-RP-DEVELOPMENT-SCOPE.md`.

## Non-negotiable fidelity rule

Preserve the card author's wording and style as the default transformation strategy.

- Prefer splitting, sorting, moving, and recombining original passages over rewriting them.
- Do not expand sparse settings, normalize the author's voice, resolve deliberate ambiguity, or invent connective canon.
- Add only the shortest summary anchors, navigation lines, headings, or connective sentences necessary to make the reorganized material usable.
- Never let a generated summary replace the authoritative original passage it summarizes.
- Mark every target passage as `verbatim`, `format-only`, `split`, `merged`, `summary-anchor`, `bridge`, or `generated-runtime` in `provenance.json`.
- If faithful classification is uncertain, preserve the original text in `unresolved.md` and report the ambiguity instead of guessing.

## Supported scope

Handle character identity and setting fields, scenario, first and alternate greetings, dialogue examples, plain-text lorebooks, and persistent structured records that can be represented by the unified Pi RP data protocol. Basic macros such as `{{char}}` and `{{user}}` may remain as runtime placeholders.

The generated RP content targets Pi agent. Python 3 is required only for the optional extraction and validation scripts; the optional local Web UI requires Node.js 20 or newer.

If code-dependent content is present, convert supported semantics into deterministic context or module processors, ordinary workflow nodes, unified data operations, retrieval guidance, or Web views; archive unsupported source unchanged and list it in the report. Never execute embedded HTML, JavaScript, EJS, Tavern Helper imports, or card-provided commands during conversion. Do not parse or preserve legacy `<UpdateVariable>` output as a runtime protocol; translate variable structure, defaults, relationships, constraints, update rules, and references into a unified-data module instead.

## Mandatory module selection, proposal, and confirmation gates

An ordinary request to convert a card authorizes source inspection and proposal preparation only. Do not create or modify the destination card pack, runtime, frontend, provenance, or session files until the user explicitly confirms that formal conversion should begin. Read-only inspection is allowed; if extraction is necessary for analysis, use a disposable temporary location rather than the intended output directory.

### 1. Inspect the source and discover global modules

Inspect the source deeply enough to identify its actual content and mechanics. At minimum determine:

- primary and supporting characters, premise, world material, greetings, examples, and writing/output rules;
- source card art and other supplied image assets, including which image is the authored character cover;
- a proposed split between the single compact foundation prompt and the card context library's static documents, including every writing/style/format instruction that should be read only at its relevant work phase;
- every authored output outside the main narrative, such as status panels, “meanwhile” scenes, thoughts, commentary, choices, summaries, or other side channels;
- persistent state, side panels, or special behavior that may need feature modules;
- code-dependent, externally referenced, contradictory, ambiguous, or unsupported material;
- every EJS block's reads, branches, emitted text, side effects, external APIs, and GENERATE/INJECT/RENDER lifecycle;
- fidelity risks, especially passages whose voice or meaning could be damaged by rewriting.

Also read [global-modules.md](references/global-modules.md), inspect the current project's `global-modules/*/module.json` packages, and inspect `play/workflows/*/workflow.json` before preparing the proposal. If `play/` is not initialized yet, inspect `assets/pi-rp-runtime/workflows/*/workflow.json` instead. Global workflow templates are independent from feature modules.

### 2. Resolve global-module scope before the formal proposal

After the source can be understood well enough to judge module relevance, present one compact **Global module preselection** message before designing the formal conversion proposal. List every valid module with its ID, one-line purpose, direct relevance/conflict, and the main structural consequence of selecting it. Ask which modules to include. This is one necessary scope decision, not a sequence of low-level design questions.

Skip the question when the user already explicitly chose or declined modules, or authorized you to choose. With delegated choice, state the chosen set and rationale. When there are no valid modules, state that once and continue. A general request to start conversion does not silently select a module.

Do not produce a formal conversion proposal while module scope is unresolved. Module selection does not authorize writes and does not replace the later whole-proposal confirmation gate.

### 3. Present a concise conversion proposal

Summarize the proposed treatment rather than dumping the full inventory. Cover:

1. overall card positioning and intended RP experience;
2. how the supplied card cover will be preserved for the Web character catalog and assistant chat avatar, or that no usable image was supplied;
3. the exact proposed `core/foundation.md`, limited mainly to a compact source-supported world/premise overview and source-supported long-term tone, principles, or direction;
4. the proposed card-context-library documents, indivisible document boundaries, categories, read policies, authority, work phases, choice groups, and any opening-specific placement;
5. each proposed feature module, including every authored output outside the main narrative, its purpose, visible/background status, storage shape, update lifecycle, and retrieval approach;
6. the selected project-global modules, their card-specific integration, ownership changes, permissions, workflows, settings, and any conflicts resolved during preselection;
7. the recommended global foreground/background workflow templates, why they fit, and any node/trigger/blocking changes the card needs;
8. unsupported/adapted behavior and the most important fidelity or design uncertainties.

State that original wording will be preserved primarily through splitting, sorting, and regrouping. The foundation/library division changes prompt loading and must be accepted by the user or creator as part of the whole conversion proposal; do not infer approval from source activation metadata. Recommend suitable global workflows, then ask whether the user wants to inspect/add other workflows or adjust the recommended nodes; a general confirmation accepts the stated workflow recommendation and foundation/library division. End with a small numbered list of decisions that would benefit from discussion, and offer to discuss any or all of them one by one. Unless the user already gave explicit advance confirmation to start directly, end the turn after the proposal and wait without writing output files.

If `narrative-memory` is selected, the proposal must contain a distinct **Memory integration and content-carrier changes** subsection. It must identify, with source examples or source-unit groups:

- material moving from fixed prompts or on-demand static documents into initial memory entities, events, relationships, cognitions, knower groups, or information-controlled blocks;
- primary-character personality and behavior guidance that stays fixed, plus any such authored material proposed for migration and why (never shorten it casually);
- facts and state that remain owned by another feature module, with memory holding only references or derived recall where appropriate;
- short discovery anchors that remain fixed after detailed material moves;
- opening-specific initial records and whether each opening uses an authored package or an approved initialization workflow;
- adaptations for every other module source, including delayed source capture, snapshot/history interpretation, archive retrieval, permissions, and source revision tracking;
- any proposed adjustment to another module's data shape, its compatibility risk, and the fact that it requires separate user approval.

Do not summarize this as merely “integrated the memory module.” For card-authored passages moved into memory, preserve wording by splitting and regrouping under the same fidelity and provenance rules used elsewhere.

When the source has persistent variables, include a maintenance-oriented variable view in the proposal by default even if the card has no authored status bar. It is an additional named view and optional frontend region over the same collection, not a second data owner. State that the user may cancel this debugging surface; cancellation makes the variable module background-only without removing storage or updates. An authored status bar remains a separate source-derived frontend module and never replaces the maintenance view.

### 4. Discuss and revise when requested

When the user chooses an item, discuss that item at the level needed to make a real decision, record the decision in the conversational proposal, and show only the affected revision. Guide the user to the next unresolved item or to final confirmation; do not force discussion of low-impact choices the user is happy to delegate.

Continue this loop until the user explicitly says to begin, confirms the current proposal, or gives equivalent unambiguous authorization. Agreement with one design detail is not overall authorization. If the initial request explicitly says to skip discussion and start directly, treat that as advance confirmation, but still communicate the concise proposal before making material changes.

### 5. Formal conversion after confirmation

Once confirmed, treat the latest proposal and decisions as the implementation contract. If later source discovery requires a material change to that contract, pause, explain the change, and obtain confirmation again. Minor file naming and mechanical details do not require renewed approval.

## Formal conversion workflow

1. Establish a new output directory. In this conversion repository, the destination is `play/cards/<card-id>/`: keep converter sources and inputs at the repository root, while treating `play/` as the standalone RP runtime root. Never modify the source card or source project. This is the first step that may write the formal result.
2. Inventory the input using [source-inventory.md](references/source-inventory.md). For PNG, JSON, or CHARX inputs, use `scripts/extract_card.py` when useful. During formal conversion pass `--asset-directory <card-pack>/source` so an available packaged cover is preserved deterministically; do not use the intended card-pack directory during proposal-only inspection. Preserve the authored card image as a card-local source asset; a PNG/APNG input is itself the cover, while CHARX and Tavern Sync sources require resolving the supplied character-icon asset without fetching remote or missing files. Read Tavern Sync source directories directly from their `index.yaml` and referenced text files.
3. Create stable source units before reorganizing content. A unit is the smallest passage that can move independently without changing its meaning. Preserve its exact original text and source location.
4. Read [semantic-conversion.md](references/semantic-conversion.md) and classify units by function, scope, loading policy, and truth status. Ignore ST activation configuration when deciding the Pi structure.
5. Build the card pack described in [target-card-pack.md](references/target-card-pack.md). Copy `assets/card-context-library/` into every new card and populate it from the confirmed division: `core/foundation.md` is the only card fixed-context file, while complete character material, detailed lore, creative guidance, authored rules, styles, formats, and references become cataloged indivisible documents. Import only the project-global modules selected or explicitly delegated during the proposal, copying each into the card rather than linking to the global package; follow [global-modules.md](references/global-modules.md) for collision and adaptation rules. Read the sibling [data-design Skill](../design-pi-rp-data/SKILL.md) completely, then read its references required by the detected features. Also read [workflow-system.md](references/workflow-system.md), copy every confirmed top-level workflow into the card, and apply only confirmed card-specific changes. Node models default to `pi:current`; reference saved Agent/model IDs rather than duplicating configuration. Convert every persistent structured feature and every authored output outside the main narrative into an appropriate module v6 package with complete owned workflows; only data/hybrid modules use collections and data-contract v1. Variables use the same protocol; read [variables.md](references/variables.md). Top-level nodes call module workflows instead of receiving spliced module nodes. Workflow nodes receive only required module capabilities, write declared unified-change-batch outputs, and may submit explicitly or at node end. When EJS or embedded prompt code exists, read [ejs-conversion.md](references/ejs-conversion.md) and convert behavior without executing the source. Choose `contextOrder` for model behavior and `displayOrder` independently for presentation. Authored auxiliary outputs remain frontend modules and never enter the main chat prose.
6. Keep each greeting as a mutually exclusive opening. Preserve its visible prose with only macro and format adjustments. Do not regenerate or paraphrase an opening.
7. Generate `provenance.json`, `unresolved.md`, and `conversion-report.md`. Every non-empty source unit must be mapped, explicitly archived as metadata, marked unsupported, or marked unresolved.
8. Read [validation.md](references/validation.md), run `scripts/validate_card_pack.py`, and perform the semantic fidelity checks it cannot automate.
9. When `play/` does not already contain a runtime, copy the generic files from `assets/pi-rp-runtime/` into `play/`, so its `.pi/` and `settings/` become runtime-local. Read [web-runtime.md](references/web-runtime.md), create the card's typed `settings.json`, and copy `assets/pi-rp-web/` into the converted card as `<card-pack>/web/`. Keep shared settings in `play/settings/common.json` and card-defined settings in the card file. Every card owns its frontend so later card-specific presentation can evolve independently. Do not overwrite an existing runtime, player settings, sessions, or frontend without explicit permission. Subsequent conversions add or update only the confirmed card pack; runtime-template upgrades are a separate explicit operation.

## Conversion decisions

- Fixed context is one compact foundation prompt, not the collection of everything eventually required each turn. Prefer source-provided high-level world/premise orientation and source-provided long-term tone, principles, and direction. Put stage-specific writing, style, format, checking, scene, and detailed character instructions in the card context library even when each creative turn eventually needs them.
- A cross-cutting system such as economy, cultivation, combat scale, law, travel, or medicine belongs in a domain module.
- A concrete faction, location, person, item, ability, species, event, or unique concept belongs in one indivisible card-context-library document unless another selected module becomes its confirmed authority.
- A writing instruction belongs in `rules/`; do not misclassify it as world fact.
- “Main narrative” means the player-visible story prose and dialogue. A source-required status bar, “meanwhile” scene, thought channel, commentary, choice list, summary, or other separately formatted response is an auxiliary output, not main narrative.
- Every auxiliary output is a card-specific frontend module record type. Move its activation, content, and formatting instructions into the module skill, then generate it from an ordinary authorized workflow node; do not emit it in the chat body.
- A feature module is also appropriate for persistent structured chat state or another card-specific side panel. Ordinary lore, character dossiers, world facts, and internal writing rules are Agent context rather than auxiliary output; do not create modules from them merely to fill the Web rail.
- Project-global modules are reusable sources, not runtime dependencies. Resolve their selection before the formal proposal, then copy only the selected and proposal-confirmed set into the card. Never infer selection from apparent relevance alone.
- Feature-module context order is authored behavior. Never derive it from frontend selection or display order; frontend preferences cannot alter the Agent's prompt sequence.
- Retrieval is authored behavior. Declare indexes for deterministic filtering, searchable fields only where needed, and named views for exact disclosure. Agent nodes call `rp_data_query`/`rp_data_get`; code performs extraction under the node's capabilities and conservative query budget.
- Keep every module-specific prompt in that module's skill directory. Shared card/runtime prompts may route to the skill but must not duplicate its definitions or activation/update rules.
- A variable module preserves authored state, defaults, constraints, relationships, update meanings, and prompt references as ordinary record types. Its RP view exposes only authored fields; a maintenance node may receive a broader named view. Frontend inspection is a normal module UI and may be customized.
- EJS is a source behavior description, not a target runtime. Convert exact branches to deterministic code, semantic conditions to skill-guided Agent retrieval, state changes to their owning module workflow, and display-only behavior to Web views. Context processors may select only declared authoritative fragments and never persist changes.
- A statement that is only a character's belief must not be promoted to objective world truth.
- Opening-specific facts initialize that opening's session and do not become universal canon.
- Full details have one authoritative home. Fixed context may repeat only a short, faithful anchor that points to that home.

## Resource delivery invariant

No static creative document may become a dead file. Every document is listed exactly once in `features/card-context-library/catalog.json`, exists below that module's `documents/`, and is delivered only as a whole document. The catalog independently declares categories, `readPolicy`, authority, applicable phases, priority, optional selection group and instruction, perspective, `readWhen`, aliases, related IDs, and sources. The module's export workflow always returns a `DOCUMENTS.md` index with its selected category snapshot.

## Required result

Deliver a runnable card pack under `play/cards/`, the original/extracted source, a complete provenance map, unresolved content, a conversion report, and validation results. `play/` also includes the shared Pi RP runtime; every card includes its own local Web view copied from the template. Summarize what was preserved verbatim, what was split or merged, every generated anchor or bridge, and all unsupported material.
