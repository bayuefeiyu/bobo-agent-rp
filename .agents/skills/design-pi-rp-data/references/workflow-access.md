# Workflow data access

Modules declare capabilities. Workflows grant a subset to concrete nodes. Skills explain correct usage but cannot expand authority.

## Node grants

For every node that reads or changes module data, declare the exact:

- module and collection;
- capability names;
- allowed named views;
- query budget;
- output documents and scopes;
- node-end commit targets, if any.

Separate query-only narration from maintenance or write authority. Do not grant a broad maintenance capability merely because one field might change.

Agent tool allowlists and node capabilities both apply. Code nodes and context processors receive only declared inputs. A deterministic context processor may select declared prompt fragments from authorized query results, but it never persists state or performs semantic judgment.

## Outputs and commits

Register every workflow output by logical name, safe relative path, format, scope, and retention. Use `node`, `workflow`, `turn`, `session`, or `public` scope according to its real consumers.

A change draft has format `unified-change-batch`. `dataCommit.onNodeEnd` names exact logical outputs or paths and never scans a directory. Required registration and commit finish before the producing node succeeds and before downstream nodes are released.

Durable, queryable results belong in an owning module collection. Intermediate analysis, drafts, and handoff material remain scoped artifacts. Process records are user-only diagnostics and never become Agent context or workflow artifacts.

## Ordering and concurrency

Split dependent reads and writes into ordered nodes or batches. Parallel writers to the same collection require an authored ownership and conflict strategy; otherwise serialize them. Use expected revisions even when the workflow normally runs sequentially.

Across workflows, inspect trigger cycles, duplicate starts, unstable instance keys, and multiple owners of the same record type. Foreground narration remains singular; background data work cannot emit a competing main narrative.
