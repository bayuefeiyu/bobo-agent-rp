---
name: codex-delegate-bounded-tasks
description: "Codex-only policy for delegating clear, bounded, independently verifiable subtasks to gpt-5.6-luna at max reasoning. Ignore this skill outside Codex or when native spawn_agent model and reasoning overrides are unavailable. Use for targeted tests, scoped repository or documentation searches, inventories, schema/format checks, exact comparisons, and small mechanical changes with non-overlapping ownership. Do not use for ambiguous debugging, architecture or product decisions, cross-cutting implementation, destructive or external actions, final synthesis, or work that needs a new user decision."
---

# Delegate Bounded Tasks in Codex

Use this policy to offload suitable supporting work while the primary Codex agent retains integration responsibility.

## Enforce the Codex-only runtime gate

Apply this skill only when running in Codex and the native `spawn_agent` capability accepts explicit `model` and `reasoning_effort` overrides.

Confirm that the actual spawn API accepts both overrides before dispatch. If either runtime condition is false, capability is unknown, a parameter is missing, or the call is rejected, ignore the rest of this skill and continue normally in the current agent. Do not retry through another delegation tool or emulate delegation with another agent product, an external service, a subprocess, or a newly created user task. This gate keeps the repository skill from changing Pi or other agent environments that also scan `.agents/skills`.

## Require every eligibility condition

Delegate a subtask only when all of the following are true:

1. The objective, inputs, scope, and expected output can be stated precisely.
2. The subtask has an objective completion check, such as a test result, exact match, finite inventory, schema validation, or cited source.
3. It can run independently from the primary agent's current work. Any writable files have exclusive, explicitly assigned ownership.
4. It does not require a new product decision, interpretation of ambiguous intent, user approval, secret handling, destructive action, deployment, publication, or other external state change.
5. The required context can be supplied in a short, self-contained dispatch prompt; the full conversation history is unnecessary.
6. Delegation has useful value: the primary agent can continue meaningful work in parallel, or the subtask would otherwise consume substantial search, test, or context-processing effort.

Typical eligible work includes:

- Running a named test suite, linter, validator, or reproducible check and returning the exact failing cases.
- Performing a narrowly scoped read-only code, file, history, or documentation search with explicit keywords and boundaries.
- Building a finite inventory, checking manifests or schemas, comparing exact outputs, or verifying links and references.
- Reviewing one isolated file or concern against an explicit checklist.
- Applying a small mechanical transformation when the target files, transformation rule, and verification command are exact and do not overlap the primary agent's edits.

Do not delegate vague investigation, open-ended debugging, architecture or UX choices, broad refactors, coupled multi-file implementation, security-sensitive judgment, release operations, communication with the user, or the final integration summary. Do not delegate a trivial command when dispatch and review would cost more than doing it directly.

## Dispatch with fixed model settings

Call Codex's native `spawn_agent` directly with:

- `model`: `gpt-5.6-luna`
- `reasoning_effort`: `max`
- `fork_turns`: `none` by default; use the smallest positive turn count only when the subtask genuinely depends on recent conversation context
- a unique, descriptive `task_name`

The dispatch message must include the objective, exact scope or paths, constraints, expected output, verification method, and whether edits are allowed. Tell the subagent not to expand scope or delegate further.

Prefer one meaningful delegated subtask. Spawn multiple agents only for genuinely independent workstreams with disjoint write ownership and enough available concurrency. Never spawn an agent merely because a task is easy.

If Luna or `max` is unavailable, do not silently substitute another model or effort. Continue safely in the primary agent when practical and mention the unavailable routing in the final result.

## Integrate and verify

Continue useful primary-agent work after dispatch. When the subagent returns:

1. Check that it stayed within scope and supplied the requested evidence.
2. Independently inspect material edits or surprising claims before relying on them.
3. Resolve conflicts and own the final decision, integration, and user-facing response in the primary agent.
4. Treat the subagent result as supporting evidence, not automatic approval.
