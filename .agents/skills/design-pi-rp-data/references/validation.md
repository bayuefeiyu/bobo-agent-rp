# Data design validation

Structural validation is necessary but does not prove that ownership, disclosure, or update semantics are correct.

## Contract checks

- Module, contract, collection, type, view, action, and capability identifiers agree.
- Initial records use the declared envelope and data schema versions.
- Indexed values match declared types and operators.
- Every RP-readable record type has an explicit `rp` view.
- Capabilities reference only declared collections, actions, and views.
- Processor paths and exports are safe and present.

## Semantic checks

- Every durable fact has one authoritative owner.
- Static prose, user settings, session state, artifacts, derived data, and frontend presentation are not confused.
- Beliefs, secrets, rumors, and objective truth retain their authored boundaries.
- Storage, partitioning, identity, and binding match actual lifecycle and retrieval needs.
- Views disclose only what each caller needs.
- Query budgets and search fields are justified by real access patterns.
- Custom actions are deterministic; semantic judgment remains in an Agent.

## Runtime cases

Test representative cases for:

- indexed and content queries, truncation, continuation, and each named view;
- denied collection, capability, view, and excessive budget;
- create and every declared existing-record action;
- missing/stale `expectedRevision`;
- idempotent replay and conflicting ID reuse, including that a `failed` receipt re-executes rather than replaying its own failure;
- explicit submission and node-end fallback without duplicate commit;
- atomic/grouped rollback and intentionally authorized best-effort behavior;
- invalid processor parameters and processor failure;
- a corrupted derived index rebuilt with a visible warning, while a corrupted authoritative file still fails;
- concurrent writers and workflow dependency ordering;
- message-suffix pruning and restoration of surviving effective state, including a hybrid collection whose seeded initial record was deleted;
- initial and opening-specific state;
- frontend rendering without changing Agent visibility or authority.

Use the card-pack validator and affected runtime tests. Do not claim semantic success from schema validation alone.
