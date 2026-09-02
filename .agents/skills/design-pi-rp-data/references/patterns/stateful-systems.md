# Stateful-system patterns

Quests, inventories, relationships, meters, economies, injuries, schedules, and similar systems often combine current state, transitions, and retained events.

Choose records around independently addressable domain objects, not UI panels. Use explicit status or stage fields only when their transition semantics are authored. Put exact bounds, normalization, legal transitions, and derived calculations in deterministic processors; keep narrative interpretation and ambiguous world consequences in Agent tasks.

Use atomic batches when one action must update several records together, such as inventory transfer, paired relationship values, resource costs plus quest advancement, or injury plus capability changes. Use grouped batches only when the groups are intentionally independent.

Do not store a derived total as separate authority unless it cannot be reliably recomputed or the authored feature treats it as independently mutable. Test boundary transitions, repeated operations, stale reads, rollback, archive/restoration, and opening initialization.
