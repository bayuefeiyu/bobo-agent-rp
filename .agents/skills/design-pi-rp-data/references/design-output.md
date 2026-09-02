# Data design output

Present the design in chat at the level needed for the surrounding task. Do not automatically create a design document inside a card.

Cover these decisions when applicable:

1. **Target and scope** — exact root source, global module, converted card, runtime, or sessions allowed to change; explicitly excluded layers.
2. **Ownership** — static context, user settings, initial data, session authority, artifacts, derived data, and presentation.
3. **Model** — modules, collections, record types, key fields, identity, binding, storage, and partitioning.
4. **Retrieval** — indexes, searchable fields, named views, budgets, and information boundaries.
5. **Mutation** — actions, processors, batches, commit policy, expected revisions, idempotency, and recovery.
6. **Workflow** — node responsibilities, capabilities, views, outputs, commits, and concurrency.
7. **Presentation** — frontend regions and their read-only relationship to authority.
8. **Validation** — meaningful success, denial, conflict, replay, rollback, and pruning cases.

Resolve low-risk mechanical choices without interrogating the user. Ask only when a choice changes authored semantics, information visibility, history retention, lifecycle behavior, session scope, or migration.

For a single-card customization, discuss and implement only the requested card behavior. Do not include global-promotion sections, reusable-candidate labels, upstream notes, or template recommendations in the design or card artifacts. A separate global change exists only after an explicit user request.
