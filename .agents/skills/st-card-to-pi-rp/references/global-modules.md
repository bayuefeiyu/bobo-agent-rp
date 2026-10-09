# Project-global feature modules

Project-global modules are reusable feature-module packages under:

```text
<project-root>/global-modules/<module-id>/module.json
```

They use the same module v7/workflow v4 package structure as card-local modules. Data/hybrid packages additionally use data-contract v1; resource/hybrid packages use resource catalog v1. They are not `.pi/skills`, converter assets, modules embedded in another card, or live session data.

## Preselection before the formal proposal

Before proposing any conversion, inspect `global-modules/*/module.json` when the directory exists. Read each valid definition, data contract, collection/record-type inventory, indexes, views, capabilities, frontend view, skill description, and import guidance. Do not execute module code during discovery.

After enough source inspection to judge relevance, but before building the formal conversion proposal, send a compact **Global module preselection** message containing:

- ID, title, and one-line purpose;
- whether it directly matches a detected source feature, is merely optional, or conflicts with the proposed native conversion;
- visible/background surface and the main data/workflow ownership consequence;
- any material conflict or required card-specific adaptation that affects whether the user should select it;
- for a module whose directory carries `dependencies.json`, who drives it and what it needs: an `orchestratedBy` entry is a selection consequence, not a footnote — the user is choosing against a module that is not standalone, and the message must say so before they choose.

Then explicitly ask which modules the user wants imported. Do not silently import even a strongly recommended module. If the user delegates the choice, state the chosen set and rationale before continuing. If no valid global modules exist, state that discovery found none and do not ask an empty selection question.

Global-module selection remains unresolved until the user chooses, declines all, or explicitly delegates. A general “start conversion” does not select among still-listed modules. Do not issue the formal conversion proposal until this scope is resolved. This preselection never authorizes output writes and never replaces confirmation of the eventual complete proposal.

The formal proposal discusses only the selected set in implementation detail. For a selected `narrative-memory` module, include an explicit carrier-change matrix covering: moved-to-memory material, fixed material, state still owned by other modules, fixed discovery anchors, per-opening initial records, other-module archive-source adapters, delayed source preservation, workflow permissions, and source-revision tracking. Identify any proposed data-shape change to another module, its risks, and its separate approval requirement. Preserve primary-character personality/behavior wording and all moved authored passages under the converter's normal fidelity and provenance rules.

## Import semantics

After formal confirmation, copy each selected package intact from `global-modules/<module-id>/` into `features/<module-id>/`. Preserve its owned Agents, workflows, prompts, scripts, documents, data, and frontend resources together. Never make a card depend on the mutable project-global directory at runtime. Keep the global source unchanged.

The copied package becomes card-owned. Later card conversion or customization never modifies the project-global source, and later source changes never update the card copy implicitly. Do not place promotion, upstreaming, or reusable-candidate notes into the card package.

Validate the copied package as an ordinary card-local module, then make only confirmed card-specific adaptations. Preserve reusable runtime behavior. Put card-specific prompt text in the imported module's card-local skill, initialize only source-supported state, and update manifest paths, workflow grants, context order, and display order for the card.

Register Agents and every workflow kind only through module.json `agentFiles` and `workflowFiles`. All component definitions declare the same ownerModuleId. promptFile and entryFile are module-relative, while runtime references are module-id/component-id; configuration keys are module/<owner>/agent|workflow/<local>. Entry workflows and callable workflows share this ownership rule but retain their different trigger/return/permission behavior. Do not flatten any component into card-root agents/, workflows/, or prompts/modules/. Report owner/component collisions before overwriting and record copied paths. Public engine/tools, shared system/model/common prompts, and cross-module conversion snippets remain in the public layer. Module organization does not imply independent execution.

When IDs or collection ownership collide with a source-derived module, stop before formal import and resolve whether to configure, merge, rename, or skip. A substantial card-specific schema change is a distinct module with `basedOn`; do not keep two modules authoritative for the same state.

Record the global source path/version when available, copied/adapted files, generated configuration, and any changed behavior in provenance and `conversion-report.md`.

## Reconciling copied workflows with the installed module set

A copied module-owned entry workflow must match the modules **this** card installs. Validation rejects any `workflowCalls` binding or module `call` target that names an uninstalled module, so per card:

- generate those declarations from the installed set rather than copying the template's unconditional list;
- drop a node whose only purpose is an absent optional integration, and synchronise everything that referred to it — `dependsOn`, downstream `context.fromNodes`, `documentIndex` entries, `workspaceHandoff.include`, and any snapshot output declared from that node;
- reword the node prompt so it no longer instructs a call the runtime will not expose. An Agent node's `rp_call` only offers targets whose module is installed, so a prompt that names an absent target asks for something impossible.

**Trimming optional integrations must never remove a required dependency.** A workflow whose flow depends on a module keeps that module's calls; the correct outcome is then that the module must be installed, not that the calls disappear. `advanced-memory-rp` is the reference case: its memory timeline preparation and its narrative Agent's retrieval exposure are enforced by validation, so trimming them produces an invalid card rather than a simpler one. The same rule applies to module dependencies: an integration that is structural (expressed as a declared call) is caught by validation; an orchestration dependency (another workflow drives this module) is a conversion-time decision — record it in the proposal and offer the user the choice between installing the dependency and decoupling inside the card, with workload and risk stated for each.

## Module dependency sidecars

A module directory may carry `dependencies.json`, which records what the module needs and who drives it:

```json
{
  "schemaVersion": 1,
  "moduleId": "local-scene-narrative",
  "structuralRequires": ["narrative-memory"],
  "orchestratedBy": ["world-narrative-coordinator"],
  "decoupling": {
    "whatTheOrchestratorProvides": ["..."],
    "workload": "...",
    "riskIfDecoupled": ["..."]
  }
}
```

- `structuralRequires` lists modules this module's own workflows call. That claim is already enforced structurally by card validation, so the sidecar is a summary the proposal can quote, not a second gate.
- `orchestratedBy` lists modules that drive this one from outside. **No structural check can see this**: nothing inside this module points at the orchestrator, so it is exactly the dependency that used to be guessed at by hardcoding module IDs.
- `decoupling` is the disclosure the conversion gate must present when the orchestrator is not selected: what the orchestrator does for this module, the size of the orchestration a decoupled card has to write, and what is lost by not having it.

**Validation deliberately does not read this file.** A card copies the module and may adapt or remove the sidecar; making it authoritative would turn a conversion-time choice back into a hardcoded module-ID dependency, which is what this record exists to avoid. The shipped sidecars are checked for internal consistency by `scripts/test_real_asset_validation.py` instead.

### Presenting the orchestration choice

When `local-scene-narrative` or `world-scope-narrative` is selected **without** `world-narrative-coordinator`, do not silently drop the integration and do not refuse the selection. Present both paths with the disclosure from that module's `dependencies.json`:

| Path | What it means for this card |
| --- | --- |
| **Install the orchestrator** | Add `world-narrative-coordinator` (which requires `narrative-memory` and the `director-future` category) and copy its module-owned integration workflows. Delegation timing, guidance, review, publication, archive capture and the cross-module conflict check all come from the director. |
| **Decouple inside this card** | Keep the module without the orchestrator and write the orchestration yourself: decide when a story is written, author the guidance, choose whether and how candidates are reviewed, and write the publish and archive path (or accept that stories are never archived). The reference size is the shipped six-node `director-post-with-narratives` template. |

State the risk for the second path explicitly — no world-logic review, no deep-director subjects, no cross-module hard-conflict check — and record the user's choice in the proposal and `conversion-report.md`. Decoupling is a legitimate outcome; an unresolved silence is not.

## Switchable creative requirements integration

The full narrative-controls module owns the narrative-writer Agent, standard-rp and advanced-memory-rp entry workflows, recent-story preparation, and creative-requirements switches. Follow [switchable-prompts.md](switchable-prompts.md) and its IMPORT.md. Preserve every declared option as isolated module documents; only confirm/adapt initial selections. Keep selected requirements with ordinary static creative guidelines at the same level; narration receives only the composed document set, never the option sources. If another narrative implementation is chosen, place its complete Agent/workflow/resources in its own module and explicitly adapt integrations. Hiding or omitting the switch frontend must not leave loose narrative components.

## World narrative coordinator integration

When the user selects `world-narrative-coordinator`, require both `card-context-library` and `narrative-memory`; fail the proposal/validation if either is declined or unavailable. Read its IMPORT.md and adapt its owned pre-director, post-director, deep-wrapper, after-opening, maintenance, and integrity-repair entry workflows inside features/world-narrative-coordinator/workflows/. Bind trigger.workflowId and source-document mappings to this card's actual fully qualified foreground/post entry workflow references. Keep director-integrity-repair-entry (manual entry) separate from director-integrity-repair (callable child). Never generate unregistered root workflows. Do not expose director-future to ordinary narrative context exports. Preserve author-future prose and store only stable document/anchor references in dynamic story-plan records.

The director is a hybrid package with isolated prompt-option resources and chat-local prompt preferences. Follow its `DIRECTOR-CONTROLS.md`: copy all presets and audience comments, keep “other requirements” last with only authored default/player custom, and adapt initial choices only within the confirmed proposal. The supported runtime freezes selected content and filters document annotations by Agent ID before adding it to that Agent's prompt; do not copy the resulting director policy into ordinary static context, narration prompts, or memory. No per-node distribution configuration is required.
