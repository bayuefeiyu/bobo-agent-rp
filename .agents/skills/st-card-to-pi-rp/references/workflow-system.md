# Workflow, Agent, and Model Contract

Read this reference when conversion chooses or creates workflows.

## Separation of concerns

- A model profile stores its shareable API/model configuration under `play/settings/model-profiles.json`. It may include optional head and tail prompts, context/output limits, thinking level, and model concurrency. Credentials never live there: API keys are stored in a project-hashed secret document below the operating system cache directory and are joined only in memory.
- An Agent profile lives under `play/agents/<agent-id>/agent.json`. It defines task-specific behavior and running rules, tools, permissions, output mode, and a low-priority default model ID. A card may override it at `cards/<card-id>/agents/<agent-id>/override.json`. Shared runtime prompts contain only context and storage mechanics; do not place universal roleplay, prose-only, summary, or analysis behavior there.
- A workflow node defines one task and references Agent/model IDs. Resolution order is node model, workflow default model, Agent default model, then `pi:current`.

Do not copy model secrets into cards or workflows. Do not duplicate module-specific prompts in workflow JSON; the node points to the owning module Agent/skill.

The default credential locations are `%LOCALAPPDATA%/bobo-agent-rp/projects/<project-hash>/model-secrets.json` on Windows, `~/Library/Caches/bobo-agent-rp/projects/<project-hash>/model-secrets.json` on macOS, and `${XDG_CACHE_HOME:-~/.cache}/bobo-agent-rp/projects/<project-hash>/model-secrets.json` on Linux. `BOBO_AGENT_RP_CACHE_DIR` overrides the `bobo-agent-rp` cache root. The hash is derived from the absolute `play/` root so separate copies do not silently share credentials. On startup, migrate any legacy `apiKey` fields to this file before rewriting the project profile without them. Never return credential values to the browser.

## Workflow ownership

Global templates live at `play/workflows/<workflow-id>/workflow.json`. A selected workflow is copied to `cards/<card-id>/workflows/<workflow-id>/workflow.json`; the card copy is authoritative and may be edited independently. Starting instances use a snapshot, while Web rereads changed files for the next start.

Kinds:

- `foreground`: must contain exactly one `narrative` node and at least one downstream `turn-finalize` node. It produces the sole player-visible narrative. Finalization marks the turn complete; the numeric turn advances only when the next player input is accepted.
- `turn-background`: attached to one turn, never contains narrative, and does not advance the turn. Nodes default to `blockNextTurn: true`, which the author may disable.
- `global-background`: scoped to the current chat, has an isolated private workspace, never blocks foreground work, and reads only completed turns through its start watermark. On completion it publishes structured output into that chat's public long-term workspace.

Background triggers are `manual`, `after-workflow`, or `node`. A workflow defaults to one active instance; use multiple instances only for a real keyed use case such as analyzing different characters, with a stable `dedupeKey` when possible.

## Node contract

Supported types are `agent`, `code`, `narrative`, `gate`, `join`, `module-output`, `variable-update`, and `turn-finalize`. Use dependencies to form an acyclic graph. Parallel roots may run together; joins may use `all`, `any`, `first-success`, `quorum`, or `collect`. `cooldownTurns` skips a node until enough accepted player turns have elapsed.

Context modes:

- `fixed`: fresh authoritative card/session context; default.
- `previous-output`: selected predecessor outputs plus fresh fixed context.
- `inherit`: inherit the selected predecessor node context; use sparingly because it also carries its working context.
- `custom`: an authored deterministic processor. Set `context.processor` to a safe ID and provide `runtime/workflow-context/<id>.mjs` exporting `buildContext(frozenInput)` that returns a string. The input contains card/player/opening/turn/payload/messages/upstream snapshots; it must not persist authoritative state.

Parallel sources must be named by node ID. Never rely on array position alone.

Each node defaults to three attempts. Without explicit silent fallback, exhaustion enters `awaiting-model-choice`; the player chooses a model and retries. If the global silent-fallback switch is enabled, the configured fallback may run without confirmation, but the actual model remains recorded and visible. Do not author hidden per-node fallback behavior.

On every successful node completion, persist normalized `usage` on both the completed node state and its successful attempt: `input`, `output`, `cacheRead`, `cacheWrite`, and `totalTokens`. Failed attempts retain usage when the executor produced it. Sum all usage-bearing model and tool-result messages produced inside each attempt boundary. When the workflow reaches a terminal state, persist `run.usage` as the sum of every recorded attempt, plus `usageComplete` and recorded/unrecorded attempt counts. Successful deterministic nodes record zeros; legacy or interrupted attempts without `usage` remain distinguishable as unrecorded.

## Workspaces and records

Every chat stores workflow snapshots in `sessions/<card>/<chat>/workflow/runs.jsonl` and artifacts under the same chat. On every successful node completion, also write `workflow/process-records/<run-id>/<node-id>.md` with only the last content received and sent by the Agent. Deterministic nodes still receive a document that explicitly says no Agent was called. A retry overwrites that node's document with the last successful exchange. Run state stores only availability metadata and a relative path: process-record content is user-only diagnostic data and must never enter node context, upstream artifacts, prompts, or long-term publication. Current-turn work uses the public turn workspace; private workflow results become shared only through explicit publication.

Global-background publication uses:

```text
workspace/public/long-term/<namespace>/
├── schema.json
├── records.jsonl
└── current.json
```

Deleting a transcript suffix also removes bound workflow/module records for that suffix. Editing history does not recompute later content.

## Minimal foreground example

```json
{
  "schemaVersion": 1,
  "id": "standard-rp",
  "kind": "foreground",
  "defaults": { "agentId": "narrative-writer", "modelId": "pi:current", "context": { "mode": "fixed" } },
  "trigger": { "type": "manual" },
  "nodes": [
    { "id": "narrative", "type": "narrative", "retry": { "maxAttempts": 3 } },
    { "id": "finalize-turn", "type": "turn-finalize", "dependsOn": ["narrative"] }
  ]
}
```

Keep task prompts brief in the node. Detailed variable or feature-module rules stay in that module's skill.
