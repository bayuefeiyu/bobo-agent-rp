# Retrieval, indexes, and views

Indexes answer which records match. Views decide what the caller receives. Keep the two concerns separate.

## Indexes and search

Declare an index only for a stable field used by deterministic filters, ordering, partitioning, or frequent routing. Choose the narrowest valid type and only meaningful operators. An absent indexed value is empty unless the author declares a default; a present value of the wrong type is invalid.

Use searchable fields for authored text that genuinely needs content search. Do not make entire records searchable by default, and do not use content search when an exact index answers the request. Semantic search remains optional and module-authored.

## Named views

Every record type exposed to RP declares its own `rp` view. Missing views are errors; there is no full-envelope fallback.

Create additional views for distinct disclosure needs, such as:

- `processor` for deterministic context selection;
- `narrative` for a foreground writer;
- `maintenance` for an explicitly authorized inspection or repair task;
- feature-specific views when different Agents need different subsets.

Each view lists exactly the fields required for that purpose. Do not expose indexes, provenance, hidden reasoning fields, private knowledge, or maintenance-only values merely because they exist in the record.

Query results contain only `id`, `recordType`, `revision`, and the rendered view value. Preserve the returned revision for guarded updates.

## Identity and budgets

`rp_data_resolve` is available only for record types with authored identity registration and only within collections the current node may query. Names and aliases do not bypass access control.

Set conservative query budgets. The effective limit is the minimum of runtime, node, and request ceilings. Design for explicit truncation and continuation rather than assuming every matching record fits in one prompt.

## Information routing

Normal workflow context assembly is the primary information-routing mechanism. Query permission is a fallback boundary against autonomous over-querying and configuration mistakes.

Grant a node only the view that supports its task. A maintenance view does not belong in ordinary narration. A frontend view is separate from Agent views and may combine collections for display without changing prompt order, query permission, or data ownership.
