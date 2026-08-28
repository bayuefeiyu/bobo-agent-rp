# Project-global feature modules

Project-global modules are reusable feature-module packages under:

```text
<project-root>/global-modules/<module-id>/module.json
```

They use the same module v3/storage v2 package structure as card-local modules. They are not `.pi/skills`, converter assets, modules embedded in another card, or live session data.

## Discovery before proposal

Before proposing any conversion, inspect `global-modules/*/module.json` when the directory exists. Read each valid module definition, its storage declaration, view, retrieval policy, skill description, and any import/configuration guidance provided inside its skill. Do not execute module code during discovery.

In the first conversion proposal, include a compact **Available global modules** section:

- ID, title, and one-line purpose;
- whether it directly matches a detected source feature, is merely optional, or conflicts with the proposed native conversion;
- visible/background surface and important persistent-data ownership;
- any card-specific configuration or authored prompt adaptation required.

Then explicitly ask which modules the user wants imported. Do not silently import even a strongly recommended module. If the user delegates the choice, record the chosen set in the proposal. If no valid global modules exist, state that discovery found none and do not ask an empty selection question.

Global-module selection remains unresolved until the user chooses, declines all, or explicitly delegates. A general “start conversion” does not select among still-listed modules.

## Import semantics

After formal confirmation, copy each selected package into `features/<module-id>/`; never make a card depend on the mutable project-global directory at runtime. Keep the global source unchanged.

Validate the copied package as an ordinary card-local module, then make only confirmed card-specific adaptations. Preserve reusable runtime behavior. Put card-specific prompt text in the imported module's card-local skill, initialize only source-supported state, and update manifest paths/context/display order for the card.

When IDs or data ownership collide with a source-derived module, stop before formal import and resolve whether to configure, merge, rename, or skip. Do not keep two modules authoritative for the same state.

Record the global source path/version when available, copied/adapted files, generated configuration, and any changed behavior in provenance and `conversion-report.md`.
