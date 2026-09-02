# Workflow Audit

Read this reference only for the workflow stage. Use the current converter [workflow system contract](../../st-card-to-pi-rp/references/workflow-system.md), data-design [workflow-access contract](../../design-pi-rp-data/references/workflow-access.md), and runtime workflow validator as the authoritative structural contract.

## Within one workflow

- Validate schema, unique IDs, supported node types, acyclic dependencies, reachability, gate routes, join requirements, and required-node completion.
- Check that every node receives the data its task prompt assumes. Verify `fixed`, `previous-output`, `inherit`, and `custom` context choices against actual producers and consumers.
- Check upstream-output shape against downstream expectations, including named parallel sources rather than array-position assumptions.
- Detect parallel writes to the same module collection, conflicting record revisions, undeclared workspace output, or transcript target.
- Preserve exactly one foreground narrative. Verify every module read/write node, node-end commit, and turn-finalization dependency.
- Evaluate retries, model-choice waits, cooldowns, conditions, `blockNextTurn`, instance keys, and silent fallback for deadlock, repetition, starvation, or hidden behavior.

## Across workflows

Build a trigger graph covering manual, `after-workflow`, and node triggers. Check cycles, duplicate starts, unstable dedupe keys, and a workflow that can trigger itself indirectly.

Build a state-ownership map. Flag workflows that concurrently or inconsistently own the same module collection, record type, or player-visible narrative. Check each node's `moduleAccess`, named views, query budget, scoped outputs, and exact `dataCommit` declarations. Durable shared information must enter an owning module through the unified transaction service; scoped artifacts are not authoritative data.

Compare card-owned workflow copies with current global templates by ID and recorded baseline. A difference is not automatically a defect: decide whether it is intentional card adaptation, stale template behavior, or an unresolved merge.

## Discussion result

Present structural errors first, then semantic conflicts, then optional template upgrades. Recommend preserving a working customization unless the new contract or an evidenced bug requires adaptation.
