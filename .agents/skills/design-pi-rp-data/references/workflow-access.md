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

Agent tool allowlists, node capabilities, workflow-call lists, and code-node runtime-service declarations all apply independently. A code node receives the common random service only through `runtimeServices: ["random"]`; an Agent receives the equivalent `rp_roll` only through its tool allowlist. Code nodes and context processors otherwise receive only declared inputs. A deterministic context processor may select declared prompt fragments from authorized query results, but it never persists state or performs semantic judgment.

## Outputs and commits

Register every workflow output by logical name, safe relative path, file/directory kind, format, scope, and retention. Use `node`, `workflow`, `turn`, `session`, or `public` scope according to its real consumers. If a later node needs workspace access, add that output to the producing node's explicit `workspaceHandoff.include`; outputs not included there must not be staged or inlined as handoff material. Omit `as` to preserve the declared output path below the producer's handoff mirror root. Use `as` only for an intentional rename after accounting for any relative references in transferred maps.

A change draft has format `unified-change-batch`. `dataCommit.onNodeEnd` names exact logical outputs or paths and never scans a directory. Required registration and commit finish before the producing node succeeds and before downstream nodes are released.

Durable, queryable results belong in an owning module collection. Intermediate analysis, drafts, and handoff material remain scoped artifacts. Cross-turn authority never uses workspace handoff, and top-level workflow triggers do not imply artifact transfer. Process records are user-only diagnostics and never become Agent context or workflow artifacts.

## Ordering and concurrency

Split dependent reads and writes into ordered nodes or batches. Parallel writers to the same collection require an authored ownership and conflict strategy; otherwise serialize them. Use expected revisions even when the workflow normally runs sequentially.

A `module-internal` workflow without `writeLocks` takes the legacy whole-owner-module lock. When the module contract deliberately separates independently writable collections, the workflow may declare exact owner-module collection locks. Disjoint collection locks may run concurrently; a whole-module lock conflicts with every collection lock in that module. Locks control workflow execution, while expected revisions and atomic batches still control data correctness.

Across workflows, inspect trigger cycles, duplicate starts, unstable instance keys, and multiple owners of the same record type. Foreground narration remains singular; background data work cannot emit a competing main narrative.
