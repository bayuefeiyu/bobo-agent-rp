# Final Discussion Summary and Design

Read this reference only after all five stages have a terminal discussion state.

## Concise summary

Use one row per stage:

| Stage | Decision | Planned treatment | Residual risk |
|---|---|---|---|
| Card-pack semantics | accepted/skipped/not applicable | short phrase | short phrase |

Never turn `skipped` into “passed”. Mention a stage's detailed findings only when necessary to understand the final design.

## Brief implementation design

List:

1. ordered changes grouped by `safe`, `adapt`, `migrate`, `manual`, or `skip`;
2. exact layers and likely files in scope;
3. backup/recovery approach;
4. whether any shared runtime or live session data is included;
5. validation plan;
6. explicit exclusions and residual risks.

For card-local work, do not add global-promotion candidates, upstream suggestions, or template-development notes. The report describes only the named card and explicitly confirmed supporting targets.

End with one request to confirm implementation of exactly this design. If any `manual` item is still undecided, return it to the relevant discussion stage instead of asking for final confirmation.

## Maintenance record after implementation

An optional card-root `maintenance.json` may record schema version, project Git revision, source fingerprint, template baselines, imported module/workflow provenance, and applied upgrade history. It is maintenance metadata and must not enter Agent context or contain promotion/upstream suggestions. Do not create it during read-only audit or discussion.
