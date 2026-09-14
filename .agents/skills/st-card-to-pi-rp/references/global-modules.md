# Project-global feature modules

Project-global modules are reusable feature-module packages under:

```text
<project-root>/global-modules/<module-id>/module.json
```

They use the same module v6/workflow v3 package structure as card-local modules. Data/hybrid packages additionally use data-contract v1; resource/hybrid packages use resource catalog v1. They are not `.pi/skills`, converter assets, modules embedded in another card, or live session data.

## Preselection before the formal proposal

Before proposing any conversion, inspect `global-modules/*/module.json` when the directory exists. Read each valid definition, data contract, collection/record-type inventory, indexes, views, capabilities, frontend view, skill description, and import guidance. Do not execute module code during discovery.

After enough source inspection to judge relevance, but before building the formal conversion proposal, send a compact **Global module preselection** message containing:

- ID, title, and one-line purpose;
- whether it directly matches a detected source feature, is merely optional, or conflicts with the proposed native conversion;
- visible/background surface and the main data/workflow ownership consequence;
- any material conflict or required card-specific adaptation that affects whether the user should select it.

Then explicitly ask which modules the user wants imported. Do not silently import even a strongly recommended module. If the user delegates the choice, state the chosen set and rationale before continuing. If no valid global modules exist, state that discovery found none and do not ask an empty selection question.

Global-module selection remains unresolved until the user chooses, declines all, or explicitly delegates. A general “start conversion” does not select among still-listed modules. Do not issue the formal conversion proposal until this scope is resolved. This preselection never authorizes output writes and never replaces confirmation of the eventual complete proposal.

The formal proposal discusses only the selected set in implementation detail. For a selected `narrative-memory` module, include an explicit carrier-change matrix covering: moved-to-memory material, fixed material, state still owned by other modules, fixed discovery anchors, per-opening initial records, other-module archive-source adapters, delayed source preservation, workflow permissions, and source-revision tracking. Identify any proposed data-shape change to another module, its risks, and its separate approval requirement. Preserve primary-character personality/behavior wording and all moved authored passages under the converter's normal fidelity and provenance rules.

## Import semantics

After formal confirmation, copy each selected package into `features/<module-id>/`; never make a card depend on the mutable project-global directory at runtime. Keep the global source unchanged.

The copied package becomes card-owned. Later card conversion or customization never modifies the project-global source, and later source changes never update the card copy implicitly. Do not place promotion, upstreaming, or reusable-candidate notes into the card package.

Validate the copied package as an ordinary card-local module, then make only confirmed card-specific adaptations. Preserve reusable runtime behavior. Put card-specific prompt text in the imported module's card-local skill, initialize only source-supported state, and update manifest paths, workflow grants, context order, and display order for the card.

Copy the module's `agents/` profiles into the card's matching `agents/<id>/` locations when its owned workflows reference them. Module workflows remain inside `features/<module-id>/workflows/` and are registered only through `module.json.workflowFiles`; do not copy or splice them into top-level workflows. Generate or copy any selected top-level orchestration separately under the card's `workflows/`, using explicit `call` nodes and top-level trigger/blocking policy. Report collisions before overwriting and record every copied path.

When IDs or collection ownership collide with a source-derived module, stop before formal import and resolve whether to configure, merge, rename, or skip. A substantial card-specific schema change is a distinct module with `basedOn`; do not keep two modules authoritative for the same state.

Record the global source path/version when available, copied/adapted files, generated configuration, and any changed behavior in provenance and `conversion-report.md`.

## World narrative coordinator integration

When the user selects `world-narrative-coordinator`, require both `card-context-library` and `narrative-memory`; fail the proposal/validation if either is declined or unavailable. Read the module's `IMPORT.md` and generate card-specific top-level pre-director, post-director, deep wrapper, after-opening bootstrap, manual maintenance, and manual integrity-repair workflows. Do not expose `director-future` to ordinary narrative context exports. Preserve author-future prose verbatim where possible and store only stable document/anchor references in dynamic story-plan records.
