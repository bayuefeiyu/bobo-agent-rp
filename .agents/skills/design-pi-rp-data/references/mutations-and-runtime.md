# Mutations and runtime behavior

## Standard and custom actions

Prefer standard lifecycle actions when their semantics fit. Use a custom action only for deterministic module behavior such as bounded deltas, validated transitions, structured merge, or a derived update that cannot be safely represented as a full replacement.

A module processor receives frozen copies of declared state, the revision-checked target, operation parameters, contract, runtime context, and batch. It returns the next module-owned data plus optional status, note, or result. It performs no direct file I/O. The runtime owns envelopes, revisions, timestamps, history, indexes, provenance, and commit.

Keep creative or semantic judgment in an Agent node. Keep exact normalization and transition rules in code.

## Change batches

Durable changes use explicit unified change batches. The runtime never scans a directory to discover drafts. Operations use common routing fields plus the action-specific `data`, `targetId`, `expectedRevision`, `groupId`, `note`, and module-owned `params` where allowed.

Every operation against an existing record includes `expectedRevision`. A missing or stale revision produces a conflict receipt and never silently overwrites current data.

Choose commit policy deliberately:

- `atomic` when every operation must succeed together;
- `grouped` when authored groups are independently atomic;
- `best-effort` only when partial application is an intended result and the workflow node explicitly permits it.

Batch IDs and operation IDs are idempotency keys. A committed ID cannot be reused for different content. Commits within one session are serialized, and multi-file failure rolls back replacements within the transaction boundary.

## Submission and recovery

An authorized Agent may call `rp_data_submit`. A workflow may also submit exact declared outputs at node end. Both paths use the same transaction service; node-end handling must recognize an already committed batch rather than duplicate it.

Design receipt handling for validation failures, permission denial, revision conflicts, rollback, and corrected resubmission. Retrying a failed batch may reuse its identity only according to the runtime receipt contract; never turn a conflict into an unconditional overwrite.

Message-suffix deletion removes bound revisions through the common store and restores the latest surviving effective state. Manual maintenance and migration also use the unified write service.

## Migration boundary

Schema and contract version identifiers do not authorize generic migration. Small explicit migrations may use ordinary guarded changes; larger migrations may use temporary deterministic code. Name the target card and sessions, backup scope, transformation, validation, and recovery plan before editing authority. Card customization without explicit session-migration scope never changes session records.
