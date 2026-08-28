# Conversion Validation

Validation must protect both structural usability and the author's voice. Passing the script is necessary but not sufficient.

## Structural validation

Run:

```bash
python scripts/validate_card_pack.py <path-to-card-pack>
```

The script checks the manifest, message retrieval policy, deterministic context-processor definitions/dependencies/fragments, module v3 definitions, storage v2 contracts and engines, initial common record envelopes, native variable configs/bindings/hooks, schemas, module-skill frontmatter, required files, opening IDs, path safety, provenance statuses, transform labels, and target-file existence.

## Coverage audit

Confirm that every non-empty source unit has exactly one explicit disposition:

- Mapped into runtime content.
- Metadata-only and intentionally excluded from RP.
- Unsupported and archived.
- Unresolved and preserved for review.
- Duplicate with an identified authoritative occurrence.

No source passage may disappear because it was difficult to classify or seemed unimportant.

## Fidelity audit

Review every target passage not copied verbatim.

- `format-only`: verify that wording and meaning did not change.
- `split`: read the pieces in their new context and verify that omitted surrounding text did not alter meaning.
- `merged`: verify that proximity does not falsely imply a relationship or chronology.
- `summary-anchor`: verify every claim against its source and ensure the authoritative detail still exists.
- `bridge`: remove it if headings or ordering already make the relationship clear.
- `generated-runtime`: verify it is generic behavior, not invented card canon.

Preserve unusual diction, repeated motifs, emotional pacing, uncertainty, biased narration, and deliberate contradictions. Do not score polished prose as higher fidelity merely because it is easier to read.

The report must enumerate all generated anchors and bridges. There is no universal acceptable percentage, but every rewrite or expansion requires a concrete necessity; stylistic improvement alone is not sufficient.

## Semantic placement audit

Check that:

- Foundational facts needed in ordinary turns are present or anchored in fixed context.
- Detailed systems are in domain modules.
- Named objects are in entity dossiers.
- Primary-character material is fixed; supporting-character material is discoverable on demand.
- Writing rules are not treated as world facts.
- Character beliefs are not promoted to objective truth.
- Opening-specific state has not leaked into other openings or global canon.
- Examples have not been treated as historical events without evidence.
- Feature modules exist only for genuine persistent structured state or card-specific functions; every module-specific prompt is owned by its module skill and not duplicated in shared fixed context.
- Every module declares the strict version 3 field set, storage version 2 kind/engine, common record/data schema, retrieval policy, view, and skill. `contextOrder` is chosen by the converter or card author and is never derived from browser preferences; `displayOrder` affects only visible frontend modules.
- A native variable module preserves authored structure, defaults, opening overlays, constraints, relationships, update meanings, and prompt references without retaining legacy MVU output syntax. Narrative context contains only authored fixed references and exact on-demand projections; the post-narrative update task receives every effective variable.
- Code retrieval defaults are all messages and latest one module record. Custom selectors are deterministic and valid. Agent append/override is used only when semantic selection is actually needed, and each module skill explains `select`, `success_empty`, and `not_triggered` behavior.
- Background modules are omitted from the Web UI, remain fully persisted, and follow every frontend module in Agent context.
- Every source EJS block has a lifecycle and behavior disposition. Native context processors declare exact dependencies, select only declared authoritative fragments, contain no persistent update behavior, preserve authored processor order, and never hide unsupported ST APIs behind a claim of compatibility.

## Reachability audit

Starting only from `core/knowledge-map.md`, verify that every on-demand file is discoverable in at most two reads.

- Important concepts should have direct anchors.
- Large collections should have category indexes.
- Aliases should cover card-specific terms and alternative names actually present in source.
- `read_when` guidance should describe narrative relevance, not ST activation settings.

Do not list every low-value detail directly in fixed context when a category index keeps it reachable.

## Runtime audit

Simulate at least:

- Starting the default opening.
- Starting one alternate opening when present.
- A normal character-focused turn requiring no extra lore.
- A turn requiring one domain module.
- A turn mentioning a specific entity dossier.
- A turn that could tempt the Agent to use a narrator-only secret as character knowledge.
- A turn that could tempt the Agent to decide the player's action or feelings.
- For every declared feature module, one turn that should read or update it and one ordinary turn that should leave it untouched. Also verify that frontend modules default to `displayOrder`, system settings can hide and rearrange them without changing Agent context, background modules never appear in the Web endpoint or module-settings list, and Agent routing follows frontend-then-background `contextOrder` regardless of frontend state.
- One code-only turn, one successful `rp_context_query` turn for every Agent-enabled mode, one failed selector that uses code fallback, and one message-suffix deletion that removes every module record bound to the deleted IDs. Inspect the generated context receipt.
- For a native variable module: fixed and exact-path references, default plus opening initialization, repeated draft calls, idempotent operation IDs, a locally invalid operation followed by Agent correction, hook/schema validation, one full snapshot bound to the AI message, interruption/resume, suffix deletion restoring the latest surviving snapshot, and historical text editing that deliberately leaves later records unchanged.
- For every context processor: each branch boundary, empty selection where allowed, required and optional failure behavior, selected-fragment order, declared input isolation, and one context receipt containing the selected IDs.

Judge preservation of facts, voice, motivation, information boundaries, and output rules. Do not require exact generated wording.

## Failure severity

- `error`: lost source content, invented canon, unsafe path, missing target, invalid opening, inaccessible on-demand file, or an unsupported executable behavior presented as successfully converted.
- `warning`: ambiguity, preserved contradiction, unknown macro, external dependency, unusually large fixed context, or generated anchor needing review.
- `note`: intentional metadata exclusion, exact duplicate, or optional refinement.

Do not claim completion while any `error` remains. Warnings may remain only when listed clearly in `conversion-report.md`.
