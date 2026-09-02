# Updated Source Card Analysis

Read this reference only when the user supplies an updated source card.

Use the current [source inventory](../../st-card-to-pi-rp/references/source-inventory.md), [semantic conversion](../../st-card-to-pi-rp/references/semantic-conversion.md), and [target card-pack](../../st-card-to-pi-rp/references/target-card-pack.md) contracts while mapping the delta.

## Read-only delta preparation

Verify the exact updated artifact. Extract it into a disposable temporary directory using the current converter extraction script; never extract into the existing card pack during analysis. Do not execute source EJS, HTML, JavaScript, Tavern Helper code, imports, or remote references.

Use the preserved source under the existing card plus provenance to build two mappings:

1. old source -> current converted targets;
2. old source -> updated source semantic delta.

Then project the delta onto current targets. Distinguish additions, edits, removals, moves/renames, formatting-only changes, contradictions, new/changed mechanics, assets/covers, openings, variables, auxiliary outputs, and code-dependent behavior.

## Upgrade rules

- Preserve unchanged current targets and all independent card customization.
- Do not reconvert the whole card merely because a new artifact exists.
- A source deletion does not automatically delete converted material when the new source's intent is ambiguous; discuss removal or archival.
- Recheck feature modules, workflows, processors, schemas, views, and frontend only when the source delta affects them.
- Maintain provenance for every changed source unit and preserve unresolved material instead of guessing.

## Discussion result

Group source deltas by resulting card behavior rather than raw JSON field order. Recommend an incremental mapping plan and identify decisions that affect canon, history compatibility, or customization.
