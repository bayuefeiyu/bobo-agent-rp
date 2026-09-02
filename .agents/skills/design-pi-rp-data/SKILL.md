---
name: design-pi-rp-data
description: Design or review Pi RP unified-data ownership, collections, record types, indexes, views, capabilities, mutations, processors, transactions, and workflow data access for card conversion, module development, explicitly requested card customization, and explicit data migration. Do not use for ordinary roleplay, static-lore-only work, frontend-only work, or workflows without persistent data.
---

# Design Pi RP Data

Turn authored feature semantics into a compliant Pi RP data design. Keep the public protocol strict while leaving module-owned `data` as flexible as the feature requires.

## Development scope

Run development from the repository root even when the named target is under `play/cards/`. Resolve the write target before proposing or editing anything.

- Root Skill, template, runtime-template, or global-module development does not modify converted cards, installed `play/` runtime files, or sessions unless the user explicitly names them as targets.
- Customizing one converted card modifies only that named card. Do not modify root Skills, templates, global modules, another card, shared runtime, or sessions unless the user explicitly adds that target.
- Never write “global candidate”, “promote upstream”, “template suggestion”, or similar development commentary into a card Skill, prompt, workflow, data file, provenance, report, or other card artifact. Whether a card customization should become global is solely the user's decision.
- If a broadly reusable change is materially worth mentioning, mention it only in Agent chat, not by default, and include the compatibility and migration risks. Do not act without a separate explicit request.
- Session-data migration is a separate material target. Reading a session for evidence or changing a card does not authorize editing session authority.

Read the repository-root `PI-RP-DEVELOPMENT-SCOPE.md` when a request touches more than one of root sources, a converted card, installed runtime, or sessions.

When another development Skill invokes this one, inherit its confirmed target and authorization. Do not add a second confirmation gate. For a standalone design or review request, produce the design in chat; edit only when the user requested implementation.

## Route the task

Read only the references required by the current design:

- Always read [references/protocol.md](references/protocol.md) before creating or changing a machine-readable contract.
- Read [references/modeling.md](references/modeling.md) to decide ownership, collections, record types, storage, identity, and binding.
- Read [references/retrieval-and-views.md](references/retrieval-and-views.md) when an Agent, processor, or frontend must retrieve data.
- Read [references/mutations-and-runtime.md](references/mutations-and-runtime.md) when records change, custom actions are needed, or migration is in scope.
- Read [references/workflow-access.md](references/workflow-access.md) when workflow nodes read, write, submit, or exchange artifacts.
- Read the relevant pattern only when that feature exists: [variables](references/patterns/variables.md), [memory/secrets/rumors](references/patterns/memory-secrets-rumors.md), [auxiliary outputs](references/patterns/auxiliary-outputs.md), or [stateful systems](references/patterns/stateful-systems.md).
- Read [references/validation.md](references/validation.md) before implementing or approving a design.

## Design sequence

1. Classify each item as static authored context, user/profile settings, card initial data, session authority, transient workflow artifact, derived data, or presentation. Do not create module data merely because content is structured.
2. Assign one authoritative owner. Define module, collection, and record-type boundaries around coherent lifecycle and access needs.
3. Define fields, constraints, initial records, identity, binding, storage kind, partitioning, and history semantics.
4. Design indexes and search for candidate selection, named views for disclosure, and conservative query budgets. Every RP-readable type has an explicit `rp` view.
5. Define lifecycle actions, capabilities, processors, expected-revision behavior, batches, commit policy, idempotency, failure receipts, and recovery.
6. Grant each workflow node only the collections, capabilities, views, and budget its task requires. Separate durable module data from scoped artifacts.
7. Keep frontend views independent from Agent views and from data ownership.
8. Validate normal behavior, denial boundaries, stale revisions, replay, concurrent writes, rollback, suffix pruning, and opening initialization as applicable.

## Design result

Use [references/design-output.md](references/design-output.md) to present a compact design in chat. Resolve low-risk mechanical choices yourself. Ask the user only about choices that materially change authored meaning, visibility, history, lifecycle, session scope, or migration.

Implementation writes only the files required by the confirmed target. Skills explain semantics but never grant permissions. Agents and processors never edit authoritative session files directly; all durable changes go through the unified data service.
