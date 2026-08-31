# Feature Module Workflow Placement

Use the card's `workflows/<workflow-id>/workflow.json`; never put an API key or full Agent configuration in a module.

- Use `module-output` for a source-authored auxiliary output generated after narrative.
- Use `variable-update` for the concentrated full-state variable update and validation task.
- Use `agent` for analysis or maintenance that returns an artifact but does not directly commit a module record.
- Use `code` only for deterministic authored processing.

Choose `turn-background` when results bind to the current completed narrative. It blocks the next player input by default; set `blockNextTurn: false` only when later turns can safely continue without the result. Choose `global-background` for long-running current-chat analysis that uses a completed-turn start watermark and publishes structured results only after successful completion.

Allowed background triggers are manual, completion of another workflow, or completion of a named node. Use `cooldownTurns` for work that should run once every several accepted player turns. Use `instancePolicy.mode: multiple` only when simultaneous independent instances are meaningful; define a dedupe key for stable subjects.

Node model precedence is node, workflow default, Agent default, then `pi:current`. The Agent default is only a convenience. Keep the module's activation, update, retry interpretation, validation, and output rules in this skill directory; node prompts should point the worker to those rules rather than copy them.
