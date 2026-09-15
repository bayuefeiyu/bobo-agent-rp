# Configurable fields v1

The configuration UI discovers authored Agents and workflows and exposes only stable supported properties. Use qualified keys to prevent collisions:

- `runtime/agent/<agent-id>`
- `module/<module-id>/agent/<agent-id>`
- `runtime/workflow/<workflow-id>`
- `module/<module-id>/workflow/<workflow-id>`

Agent configuration supports name, description, default model, tools, context permissions, output mode, and prompt. Select the owner first and the Agent second. The `通用` owner contains only Agents with no module owner.

Workflow configuration supports runtime policy, workflow triggers, workflow defaults, and Agent-node bindings. Select the owner first and the workflow second. The `通用` owner contains only workflows with no module owner. Render every node and distinguish its type; only `agent` nodes may expose Agent, model, prompt, and context controls. Other node types remain visible with type-specific metadata and must not display meaningless Agent/model selectors. Store a normalized workflow snapshot in the profile on first edit so array nodes are never partially merged by index. Running workflow instances retain their start snapshot.

Module configuration fields come from schemaVersion 2 `settings-form` regions. Every field must provide a useful label and either region/field help or a description that explains its effect. The UI must expose the authored type, bounds, options, default value, and apply timing. Module profile values initialize new session authority; they do not silently rewrite an existing session.

Every editable control must expose its explanation through mouse hover and keyboard focus using a tooltip plus `aria-describedby`. A missing explanation is a validation error for newly declared configuration fields.
