# Feature-module workflow placement

Read the data-design Skill's [workflow access](../../design-pi-rp-data/references/workflow-access.md) and [mutation/runtime](../../design-pi-rp-data/references/mutations-and-runtime.md) guidance before adding data nodes.

Use ordinary `agent` or `code` nodes for module work. Give each node only the collections, capabilities, views, and budget required for its task. Keep query-only narration separate from maintenance authority.

Declare every change document as a named output with format `unified-change-batch`. An Agent may call `rp_data_submit`; configure `dataCommit.onNodeEnd` for exact required outputs as the fallback. Never scan a workspace for drafts.

Order dependent changes. Parallel writers require an authored conflict strategy. Enable `best-effort` only when partial application is intentionally correct. Durable queryable results enter the owning module; intermediate files remain scoped workflow artifacts.
