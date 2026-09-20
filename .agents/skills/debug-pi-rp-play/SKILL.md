---
name: debug-pi-rp-play
description: Diagnose an active or saved Pi RP play session from the repository root, especially each workflow's latest run, then propose or apply explicitly selected card-level, project-level, and issue-recording actions. Use for play bugs and workflow evidence, not a general card audit or ordinary roleplay.
---

# Debug Pi RP play

Run this development Skill from the repository root while the user plays in a separate `play/` session. The user manages their Pi processes. Read the repository-root `PI-RP-DEVELOPMENT-SCOPE.md` before proposing changes. Diagnose from generated evidence first; use `audit-and-upgrade-pi-rp-card` for a requested broad card audit rather than turning this investigation into five-stage maintenance.

## Locate and inspect

Resolve the intended `play/cards/<card-id>/` and `play/sessions/<card-id>/<session-id>/`. If either is ambiguous, ask only for the missing identity. Do not infer that the newest session belongs to the user's current play without evidence. For a named symptom, begin there; for a general check, summarize the most recent run of every workflow found in the target session, then inspect abnormal runs and their parent/child dependencies.

Use `session.json` and `messages.jsonl` for chat/turn context; `workflow/runs.jsonl` for run state; `workflow/artifacts/<run-id>/` and `workflow/process-records/<run-id>/<node-id>.md` for node outputs and final Agent exchanges; `workspace/private/` and relevant module records, transaction receipts, and source definitions when needed. Other generated files may add evidence. Read only the relevant files and avoid dumping private session material in chat or reports.

`runs.jsonl` contains successive snapshots of a run: group by run ID and use its last complete recorded snapshot. Per workflow, distinguish the latest run from the latest completed run; show status, turn, time, run ID, and parent/child relation where available. Workflows may run at different frequencies: do not equate their latest records with one shared turn. A run still changing during play is provisional; recheck its state before concluding. Process records show only the Agent's **last** received and sent content, not the full exchange; a retry may replace the node's record. Missing artifacts or records may reflect cleanup, pruning, an unfinished run, or a failure; establish which before calling it a bug.

Trace an apparent mismatch from the user-visible result backward through the producing node, declared inputs/outputs, workflow definition, module ownership, prompts, runtime code, and durable writes as needed. Compare observed behavior with the actual card and installed runtime; project sources are comparison material unless the user selected them as repair targets. Separate confirmed defects, plausible hypotheses, and expected behavior. Give each finding a stable issue number, specific evidence paths/run IDs, likely cause, user impact, and what remains uncertain.

## Discuss and act on findings

For each issue, present only meaningful paths. Number issues `1`, `2`, etc. and label alternatives `A`, `B`, `C` and so on; put a justified recommendation at `A` when practical. State whether paths are exclusive or combinable and accept replies such as `1A+C`. When a set changes, show its new labels. Preserve decisions already made and do not force an extra question for low-impact mechanics.

Possible actions include a repair confined to the named card, a project-level repair, continued investigation or a temporary workaround, and recording without a repair. A card repair changes only that card's owned files. For a project repair, identify the exact root source, installed shared runtime, or both; explain how the change reaches the current play session and whether it affects other cards or future conversions. A code repair does not silently edit existing session authority. A session-data repair or migration is a separate named target with its own scope. Actions can be combined: `A+C` may repair the current card and record the issue while leaving a project repair unselected. Do not treat diagnosis or a card choice as authorization for root, runtime, or session writes.

Before applying a selected repair, state the exact files/layers, expected behavior, validation, and any play-session restart or reload needed. Use the user's selected scope without repeatedly requesting the same authorization. If new evidence materially changes the selected repair, explain the change and resolve that decision. When play remains active, avoid competing writes to its session files; establish the safe target state before an explicitly selected session-data repair. Verify the behavior with focused checks and report what was and was not observable.

## Issue record

When the user selects recording, create or update `local-development-records/docs/play-debug/<card-id>/<session-id>.md`. This directory is Git-ignored local development material. Use filesystem-safe IDs, a stable issue number, minimal evidence references, diagnosis confidence, selected actions, verification, and unresolved work. Do not copy full private transcripts, secrets, or large model outputs. Update the same issue after a partial repair, for example `card repaired; project repair not selected`, rather than marking the whole issue resolved. Recording alone does not modify card, project, runtime, or session authority.
