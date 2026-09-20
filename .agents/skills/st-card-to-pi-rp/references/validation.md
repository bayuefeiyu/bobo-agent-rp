# Conversion validation

Validation protects structural usability, data ownership, workflow safety, and source fidelity. Passing the script is necessary but not sufficient.

## Structural validation

Run:

```bash
python .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
```

The validator checks card manifest v2, the single fixed foundation path, required card-context-library registration, safe paths, openings, provenance, context processors, module v6 kinds and owned workflow files, resource catalog/document coverage, data-contract v1 collections, record envelope v2 initial data, indexes, views, capabilities, top-level workflow v3 nodes/outputs/access/commits, frontend declarations, and referenced files.

### Loadable Skill headers

Every Skill the runtime reads at bridge startup must open with YAML frontmatter carrying a one-line `name` and a one-line `description` (at most 1024 characters):

```markdown
---
name: local-scene-narrative
description: Create one director-assigned local-scene story candidate, then let the director review and the deterministic publisher commit it.
---
```

This applies to each `module.json.skillFile` and to `manifest.context_skill`. The card refuses to open when a header is missing, so the validator reports it as an **error**, not a warning, and it checks the header itself rather than the file's existence. Block scalars (`description: |`) and empty values do not count as a one-line description, because the runtime injects exactly one line into Agent context. `rp-skill-contract.mjs` enforces the same rules at runtime; change both together.

It reports errors and warnings separately, and `validation passed with N warning(s)` is a complete result. Two kinds of warning are worth distinguishing:

- **`design:` warnings** name a convention of the shipped templates that this card does not follow: a foreground workflow that never prepares card-context-library resources, an `advanced-memory-rp`-style workflow that exports card resources before preparing the effective memory timeline, a narrative Agent that does not expose `narrative-memory/narrative-memory-retrieve`, or a `card-context-library` whose shape differs from the shipped one. **A deliberately customized card is allowed to differ** — cards may rename, replace, or decouple their foreground workflow, which is why these are no longer hard errors. Record every one in `conversion-report.md` with the reason it is intentional.
- **any other warning** is a fidelity or metadata observation (a missing source artifact pointer, an unbased provenance unit, and so on).

### Declared design invariants

A card that wants a convention enforced writes it into `manifest.design_invariants`, and the validator then checks the card against its **own** declaration instead of a template's:

```json
"design_invariants": {
  "foregroundWorkflow": "standard-rp",
  "requiresCardContextResources": true,
  "requiresEffectiveMemoryTimeline": true,
  "requiresNarrativeAgentCallable": ["narrative-memory/narrative-memory-retrieve"]
}
```

- `foregroundWorkflow` is the card-local foreground workflow the other invariants apply to, and it is required whenever anything else is declared.
- every key is optional, and a card that declares none is never judged against a template it left behind;
- a declared invariant is an **error** when violated, and the matching `design:` warning is then suppressed.

**Write the declaration for a card built on the shipped templates.** A card whose foreground workflow is the shipped `standard-rp` declares `foregroundWorkflow` plus `requiresCardContextResources`; one built on `advanced-memory-rp` adds `requiresEffectiveMemoryTimeline` and `requiresNarrativeAgentCallable` for every retrieval entry its narrative Agent is supposed to expose. A card that deliberately renames, replaces, or decouples its foreground workflow declares only what it keeps, or nothing at all.

**Never declare an invariant the card does not satisfy in order to silence a warning.** The declaration is exactly what makes the check binding; a false one converts an honest warning into a failing card.

## Coverage and fidelity

Every non-empty source unit has one explicit disposition: mapped, metadata-only, unsupported, unresolved, or an identified duplicate. Review every non-verbatim transform:

- `format-only` keeps wording and meaning;
- split/merged passages retain their original relationships and uncertainty;
- every summary anchor is supported and points to retained detail;
- bridges add no canon and are removed when headings suffice;
- generated runtime text describes behavior, not invented story facts.

Preserve unusual diction, pacing, motifs, biased narration, deliberate contradictions, and information boundaries. Do not promote a character belief to objective truth or leak opening-specific state.

Confirm that the creator accepted the final foundation/library division before implementation. The foundation must remain compact and source-supported; every other static creative document must be listed exactly once in the card-context-library catalog, use a deliberate indivisible boundary, and retain a provenance route. Treat an exact full-document duplicate between the foundation and a library document as an error.

## Unified-data audit

Apply the data-design Skill's complete [validation contract](../../design-pi-rp-data/references/validation.md) to every module. In conversion, additionally verify that every source variable, memory, secret, rumor, auxiliary output, and other persistent feature maps to the common protocol without inventing a separate storage, draft, catalog, or publication mechanism.

## Workflow audit

Validate the DAG, conditions, joins, retries, triggers, instance policy, blocking behavior, and exactly one foreground narrative. For each node, verify:

- its prompt assumptions match declared context and upstream logical outputs;
- module access names exact collections, capabilities, views, and budgets;
- change files are declared outputs with format `unified-change-batch`;
- `dataCommit.onNodeEnd` names exact outputs/paths and runs before downstream nodes;
- concurrent nodes do not write the same authoritative collection incompatibly;
- scoped file/directory artifacts and retention match every later consumer, and every node-to-node transfer appears only in the producer's explicit `workspaceHandoff.include`;
- process records remain user-only.

For each module call, also verify that the target is a declared module workflow, every required input is supplied, export paths and formats match exactly, and any `fixedArguments`/`allowedArguments` policy names only declared parameter inputs. For card-context-library exports, test each requested category set, the generated `DOCUMENTS.md`, whole-document copying, duplicate-path collisions, and choice-group instructions; metadata guides Agent judgment and is not a hard-coded read executor.

Across workflows, build a trigger and ownership map. Detect cycles, duplicate starts, unstable dedupe keys, incompatible concurrent writes, and conflicting assumptions about record status or schema.

For every `after-workflow` trigger, also resolve `trigger.documents` against the workflow it names — do not settle for "the reference is syntactically valid":

- `fromNode` must be a node of that workflow, and `output` must be an output that node really declares;
- the mapped output's `scope` must be `turn`, `session`, or `public`;
- every node's `metadata.triggerInputs` entry must have a matching `trigger.documents` mapping;
- an unreplaced placeholder ID (`DIRECTOR_ENABLED_FOREGROUND_ID`, `DIRECTOR_POST_WORKFLOW_ID`) is an error even though it passes the ID pattern check, because the trigger would silently never fire.

All four are converter errors, and the validator reports them as such. They exist because swapping an integration template for one that produces different outputs — the RC-06 defect — leaves a reference that looks fine and fails during play. Trigger documents reach a consuming node at the authored `trigger/<documentId>` address inside that node's own workspace, so a call node's `documents`, a code node's hardcoded path, and an Agent document index all read the same controlled copy.

## Runtime audit

Simulate the default and one alternate opening, ordinary narration, on-demand lore, and information-boundary temptations. For each module/type, test a relevant and irrelevant turn plus:

- indexed query, content query where declared, pagination/truncation, `rp` view, and custom view;
- denied view/capability and a conservative-budget boundary;
- create/update/revise/archive/restore as declared;
- explicit submit and node-end fallback without duplicate commit;
- atomic/grouped behavior, idempotent replay of an outcome (`committed`/`partial`), revision conflict, and failure receipt — a failed receipt re-executes only after pre-commit failure or confirmed rollback, while an unresolved transaction journal blocks replay;
- frontend rendering based on customized code, background invisibility, and display ordering;
- message-suffix pruning for bound data, including a hybrid collection whose seeded initial record was deleted;
- derived-index damage: an unreadable index rebuilds with a warning while a damaged authoritative file still fails;
- initial data and opening-specific initialization where authored.

For context processors, test each branch boundary, declared input isolation, known-fragment enforcement, and failure policy. Judge preservation of facts, voice, motivation, knowledge, and output separation rather than exact generated wording.

## Severity

- `error`: lost source content, invented canon, unsafe/missing target, invalid contract, unauthorized disclosure/write, conflicting ownership, auxiliary output left in chat prose, or unsupported executable behavior claimed as converted.
- `warning`: ambiguity, preserved contradiction, unknown macro, external dependency, unusually large context/query budget, or a generated anchor needing review.

The card validator rejects unresolved `{{char}}`, `<char>`, and `<bot>` in runtime Markdown and JSON, source `<user>` left unnormalized, and player macros in JSON keys or structural fields. Source archives, provenance quotations, and conversion notes are exempt from this runtime-material rule. Test a new session with a chosen player name: the opening, Agent prompts, exported documents, and initial records must contain the literal name. Existing sessions require explicit maintenance for name changes.
- `note`: intentional metadata exclusion, exact duplicate, or optional refinement.

Do not claim completion while an error remains. List accepted warnings in `conversion-report.md`.
