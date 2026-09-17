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

Batch IDs and operation IDs are idempotency keys. A committed ID cannot be reused for different content. Commits within one session are serialized, and multi-file failure rolls back replacements within the transaction boundary. The receipt is installed last as the commit marker. A failed batch may re-execute only after validation/application failed before commit or rollback was confirmed complete; an unresolved transaction journal blocks replay with `commit_outcome_unknown` until recovery establishes its durable result. Workflow collection locks improve safe concurrency but do not replace transaction serialization, atomicity, or expected-revision checks.

## Submission and recovery

An authorized Agent may call `rp_data_submit`. A workflow may also submit exact declared outputs at node end. Both paths use the same transaction service; node-end handling must recognize an already committed batch rather than duplicate it.

Trusted code nodes may supply an explicit historical binding to `data.submit` only for delayed work whose authoritative ownership belongs to an earlier visible message. The runtime validates the requested message ID against the current transcript, checks its stored turn and the workflow visibility boundary, and applies that single binding to the batch. Do not expose this override to ordinary Agents, accept arbitrary message IDs, or use it to bind data to content the workflow could not see.

The single `binding` answers where a batch belongs in the story timeline. The separate runtime-owned `sourceReferences` answers which exact message revisions and retained artifacts were actually used as inputs. Workflow context assembly accumulates these references automatically. Trusted code may narrow delayed work to exact visible messages with `data.submit(batch, {sourceMessageIds:[...]})`; the runtime resolves current revisions and rejects unknown, duplicate, or future IDs. Ordinary Agents cannot submit this metadata themselves, and all Agent/node-end submissions inherit the run's recorded inputs.

Receipts and record provenance retain the normalized source set. `inspectDataImpact()` is a read-only user-facing audit over receipts: it returns only installed/authorized module targets and identifies legacy receipts whose sources cannot be reconstructed. Editing a message creates a new message revision but never invalidates records, rolls back modules, reruns workflows, or blocks the next turn automatically. A user may use the reported batch/module range to explicitly start an authorized maintenance workflow; repair stays scoped to that chosen workflow and its declared module access.

`inspectDataIntegrity()` may compare current authoritative message revisions with receipt sources and return module-scoped warnings. A module can acknowledge a reviewed range with its own guarded coverage record; the public diagnostic remains read-only and does not decide that a record is false. Declarative frontend alerts may prefill a statically allowed repair workflow, but only a user action starts it.

Design receipt handling for validation failures, permission denial, revision conflicts, confirmed rollback, unresolved commit outcome, and corrected resubmission. Retrying a failed batch may reuse its identity only according to the runtime receipt contract; never turn a conflict or unresolved journal into an unconditional overwrite.

Message-suffix deletion removes bound revisions through the common store and restores the latest surviving effective state. This structural suffix operation remains distinct from in-place editing. Manual repair, maintenance, and migration use explicitly selected workflows and the unified write service.

## Migration boundary

Schema and contract version identifiers do not authorize generic migration. Small explicit migrations may use ordinary guarded changes; larger migrations may use temporary deterministic code. Name the target card and sessions, backup scope, transformation, validation, and recovery plan before editing authority. Card customization without explicit session-migration scope never changes session records.
