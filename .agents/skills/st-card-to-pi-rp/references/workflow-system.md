# Workflow, Agent, and model contract v3

## Controlled narrative snapshots and turn windows

- A foreground Workflow v3 may declare `turnContext.recentCompleteTurns` (1–50, default 5). Runtime-selected recent prose and any recent module-story preparation must reuse this one value.
- An Agent node may declare a directory output with `format: "document-workspace-snapshot"` and select it through `metadata.documentWorkspaceSnapshot.output`. The runtime freezes only registered documents, returned dynamic-call documents, current player input, and final narrative; it does not scan the workspace. Snapshots carry file hashes and hard count/size/depth limits, and retries reuse the same immutable snapshot.
- `after-workflow` and `node` triggers may map exact source outputs through `trigger.documents.<inputId>={fromNode,output}`. At dispatch, the runtime assigns the consumer run ID and freezes only those mapped documents once under that run's `_trigger-inputs/`; every receiving node reads the same copy. Producer turn cleanup may proceed immediately, while the consumer copy remains until that consumer reaches a terminal status. Only explicit `turn`, `session`, or `public` outputs can cross the workflow boundary, and document transfer never transfers tools or data permissions.
- An Agent `workflowCalls` binding may declare `documentSnapshotInput`. At call time the runtime freezes the documents authorized so far and supplies that target input automatically; the Agent cannot override it. The target input must accept a directory `document-workspace-snapshot`.
- A call binding may declare `maxCalls` (1–100) for a hard per-node-attempt limit. Retrieval size remains independently bounded with fixed caller arguments and the target workflow's query limits.

For module access, change batches, commits, artifacts, and concurrent data writers, follow the data-design Skill's [workflow-access contract](../../design-pi-rp-data/references/workflow-access.md). This document is authoritative for workflow composition, module calls, Agent execution, and foreground publication.

Models store shareable provider/model configuration without credentials. Agents define task behavior, ordinary tools, and output mode. Workflow nodes define the actual task, ordering, context, exact module-workflow calls, scoped data capabilities, named outputs, and node-end submissions. A正文 Agent is an ordinary Agent node whose task happens to be planning and prose creation; it has no privileged executor.

## Workflow kinds and graph boundaries

Top-level kinds are `foreground`, `turn-background`, and `global-background`. Module-owned kinds are `module-external` and `module-internal`. Node types are `agent`, `code`, `call`, `gate`, `join`, `workflow-return`, and `turn-finalize`.

Dependencies form an acyclic graph. Parallel roots may run together; joins support `all`, `any`, `first-success`, `quorum`, and `collect`. A module workflow is never spliced into a parent graph: the complete child graph executes behind one calling parent node. Module workflows have no triggers. Only top-level completion/node events may wake another top-level workflow.

`module-external` is read/transform-only with respect to authority and irreversible effects and may run concurrently. `module-internal` may update its module's authority or cause external effects. An internal workflow without explicit `writeLocks` locks its whole owner module, preserving the legacy serial lane. An internal workflow may instead declare exact owner-module collection locks; disjoint collection locks may run concurrently, while a whole-module lock conflicts with all collection locks in that module. Internal workflows default to one instance. A deliberately keyed multi-instance internal workflow must declare a stable `dedupeKey`, a positive finite `maxConcurrentInstances`, and exact collection locks; its key is resolved from normalized call `arguments`, and the ordinary lock scheduler still serializes instances that touch the same collection. A module workflow may call only `module-external` workflows. Top-level workflows may call either kind.

## One call-and-wait mechanism

All callers use the same synchronous runtime primitive:

- `call` has one fixed `target` and is used for authored graph preparation;
- `agent` and `code` list exact `workflowCalls` and may invoke those targets while executing; a binding may additionally define fixed arguments and scalar-value allowlists as a defensive ceiling;
- no wildcard target grant exists;
- an Agent additionally requires the target workflow's `agentCallable: true`; otherwise no call entry is exposed to that Agent;
- code nodes ignore `agentCallable`, but still require an exact `workflowCalls` entry.

The parent node waits for the child result and releases its scheduler/model slot while waiting. Nested external calls are allowed. The runtime rejects call cycles and depth greater than eight, propagates parent cancellation, and does not roll back a successful internal child write merely because a later parent step fails.

Every module workflow ends in exactly one `workflow-return`. Its declared file or directory exports are copied to caller-selected safe relative paths and only normalized output paths return to the caller. Child outputs never bubble through multiple levels automatically; each intermediate workflow must re-export what its own caller should receive. Existing output-path collisions fail instead of overwriting. Module call document inputs may likewise be explicitly named files or directories from the caller node workspace; a document input declares `kind: "file"`, `"directory"`, or `"either"` and defaults to `"file"`.

An output with format `document-set` is a directory whose required entry point is `DOCUMENTS.md`. The boundary recursively copies regular files and directories, preserves relative structure, rejects symbolic links and unsupported entries, and applies the same collision-safe identical-retry rule to every file. The returned value remains one directory path; dynamic numbers of documents do not change the workflow interface.

Agent tool exposure contains only the mechanically required signature, exact allowed workflow IDs, and declared input/output shape. The node author writes all guidance about whether and when to call. Runtime prompts do not add inferred purpose, recommendations, or risk warnings.

## Runtime services and random rolls

Reusable runtime primitives are independent from module authority and workflow calls. An Agent receives `rp_roll` only when its effective Agent profile lists that exact tool. Any `code` node in a top-level or module workflow may instead declare `runtimeServices: ["random"]`, which exposes `services.random.roll(request)` to its entry file. Other node types cannot declare runtime services, unknown service IDs fail validation, and neither entry is granted implicitly.

Both entries accept the same structured request: a required filesystem-safe `key`, one to ten `{count,sides}` dice groups containing at most one hundred dice in total, an optional integer `modifier`, and an optional short `reason`. Dice have from 2 to 1,000,000 sides and use Node's cryptographic integer generator. The result contains a roll ID and creation time, every individual die, group subtotals, modifier, total, reason, and whether the result was replayed.

A key is idempotent within one workflow run and node. The runtime stores the first result below `workflow/random/<run-id>/<node-id>/`; an identical retry returns it with `replayed: true`, while reusing the key with different parameters fails. These operational audit records do not enter Agent context and are not module authority. If a roll outcome must become durable story state, an authorized workflow must explicitly submit the derived fact to its owning data module.

## Node workspace handoff

Any producing node may declare `workspaceHandoff.include`. Every item must name one declared output, for example `{ "output": "materials" }`. By default the receiver gets that file or directory under `handoff/<producer-node-id>/<declared-output-path>`, so the handoff root is a strict allowlisted mirror of the producer workspace and relative paths in an explicitly transferred knowledge map keep working. Optional `as` deliberately replaces the path below that mirror root; authors accept that this can invalidate references in transferred maps. An output declares `kind: "file"` or `kind: "directory"`; ordinary outputs default to files and `document-set` defaults to a directory. Handoff outputs must use workflow or broader scope and survive at least until run cleanup.

This is an allowlist, not a workspace scan. There is no wildcard, implicit whole-directory transfer, or `exclude`. At node completion every included output must exist with the declared kind. Before an eligible downstream `agent`, `code`, or `call` node starts, the runtime copies only those inclusions to `handoff/<producer-node-id>/<declared-output-path>` or, when deliberately supplied, `handoff/<producer-node-id>/<as>`. Paths that escape either workspace, symbolic links, unsupported filesystem entries, overlapping destinations, missing outputs, kind mismatches, and non-identical collisions fail closed. `context.fromNodes`, when present, selects the producing nodes; otherwise direct dependencies do.

The same copy primitive handles ordinary directories, `document-set` directories, and module-call file/directory inputs and exports, but the boundaries remain explicit. A module workflow still returns only interface exports; a caller node must declare any returned path as its own output and include it again if a later node should receive it. Top-level trigger events do not implicitly carry workspaces. Cross-turn durable/queryable information remains unified module data; retained files are artifacts, not authority, and are never auto-injected into a later run.

## Agent document workspace

Any Agent node may opt into the generic node document workspace with `metadata.documentWorkspace: true`. The runtime serializes ordinary upstream node results, records the inherited mirror roots and already staged explicit workspace handoffs, writes `WORKSPACE-DOCUMENTS.md`, and supplies that index instead of inlining the same handoff files. It does not parse, rewrite, or reconstruct an upstream knowledge map. Such a map transfers only when the producer declares it as an output and explicitly includes it; paths inside it are resolved from `handoff/<producer-node-id>/`. A directory handoff is listed as a directory path; a `document-set` points to its `DOCUMENTS.md`. An Agent without this option keeps ordinary upstream result and selected file-handoff content inline and is still told the mirror roots; directory handoffs remain available there. This is a context-delivery choice available to every Agent node, not a narrative-node capability or privilege.

## Foreground Agent and publication

A foreground workflow contains exactly one `turn-finalize`. It maps `{fromNode, output}` to a preceding declared output whose format is `narrative`. The source may be any ordinary Agent/code node, which preserves an extension point for future parallel prose candidates and a later selector.

`standard-rp` uses one ordinary Agent for initial planning, optional dynamic module calls, revised planning, and prose. Its initial context contains the model/Agent/node prompts, the card's compact foundation prompt, the most recent five complete turns, current input, the generic workspace document index, and any exposed call signatures. A fixed upstream call to `card-context-library/export-context` normally prepares all relevant static categories as one document set. Prepared analysis, memory, detailed lore, character material, guidance, rules, style, and formatting material live as workspace documents.

The workspace index records at least path, `readPolicy` (`required`, `conditional`, `choice`, or `optional`), `authority` (`binding`, `canonical`, `advisory`, or `exploratory`), `appliesAt`, `perspective`, numeric `priority`, and a short description. For a document set, its path points to `DOCUMENTS.md`, whose entries carry the per-document values and any selection-group instruction. These guide a capable Agent but are not hard read-tracking controls. Fixed upstream preparation uses explicit `call` nodes. On every Agent or code node, `workflowCalls` lists only dynamic calls available during that node's task and does not duplicate fixed upstream calls; a narrative-writing Agent is not a special node type and follows the same rule.

## Feature contribution timing

A feature that influences creative work must expose the needed material through one or more declared module-workflow file or directory exports, regardless of how the module stores its own authority, records, or source content. Its integration may use any combination of these non-exclusive modes:

- **pre-creative**: prepare material before scene analysis, planning, or prose so it can affect the current task;
- **post-creative**: process the completed narrative and make the result available to a later turn through an explicit later export/preparation step;
- **memory-backed**: archive the result in an owning memory or data module for later retrieval, without requiring the generated material itself to enter prose context immediately.

The workflow author must declare which modes apply, their ordering, triggers, exported documents, durable owner, and next-turn delivery path. A top-level trigger never transfers a workspace by itself, so post-creative or memory-backed material crosses turns through module authority or another explicitly retained source and is materialized again by a later workflow. These modes describe integration timing; they do not create a special narrative-node API or bypass ordinary `call`, `workflowCalls`, output, handoff, or data-access rules.

## Blocking the next turn

`blockNextTurnUntilReady` belongs to a top-level `turn-background` trigger binding and defaults to `false`. Use `true` only when the entire post-turn contribution must settle before accepting another turn, such as critical memory archival or authority updates. It is not a module-workflow property and cannot be enabled by Agent output or module data.

The engine reports every unfinished node of a blocking run. Completion, explicit skip, failure resolution, or cancellation releases the run. Persisted interrupted nodes recover as `awaiting-model-choice` so the creator can retry, replace the model, skip, or cancel explicitly. A code node that has already caused, or may have caused, an external side effect reports `recovery-required`; the node and run then remain `awaiting-recovery`. Recovery continues the same run and external identity. A deterministic failure remains failed and propagates through a calling parent instead of being wrapped as success.

`after-opening` is also a valid top-level trigger. It fires only after the selected opening has been persisted and displayed. Use a blocking `turn-background` binding when opening-derived authority must settle before the first player input.

## Data access, outputs, and records

`moduleAccess` grants exact collection capabilities, views, and budgets to one node. It is independent from `workflowCalls` and `runtimeServices`. A query budget may declare hard `maxRecords`/`maxCharacters`, optional lower `defaultRecords`/`defaultCharacters`, and an optional object-valued payload `parameter`; a caller request can select values only within the authored maxima. Declare every file or directory output by logical name, safe relative path, kind, scope, retention, and optional format. `workspaceHandoff.include` is the separate explicit subset allowed to reach later node workspaces. Change drafts use `unified-change-batch`; `dataCommit.onNodeEnd` names exact outputs or paths and never scans directories.

Context modes remain `fixed`, `previous-output`, `inherit`, and `custom`. Messages and retained artifacts carry normalized `narrativeSource`; this semantic provenance never grants access. Each successful node keeps a user-only process record that does not enter Agent context. Run state retains normalized token usage and explicit retry/model-choice history.
