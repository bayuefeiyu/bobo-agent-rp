---
name: manage-pi-rp-config-ui
description: Start the shared Pi RP play UI from the repository root in a no-card development preview, and manage global model, Agent, workflow, and module parameter profiles from its configuration panel. Do not use for roleplay or card-local gameplay configuration.
---

# Manage Pi RP configuration

Run only from the conversion repository root. Confirm that `global-modules/` and `.agents/skills/st-card-to-pi-rp/` exist, then start the configuration UI with:

```powershell
node .agents/skills/manage-pi-rp-config-ui/scripts/start-config-ui.mjs
```

The command binds a loopback-only server, opens the same Web UI shell used by `play`, and remains active until interrupted. The story and card pages deliberately contain no card-owned data. Use them to preview the common frontend layout, edit card-independent user/display defaults from **用户设置** and **系统设置**, and open **配置方案** to edit global profiles.

Development preview card, chat, session, and workflow execution state is virtual and read-only: do not create a placeholder card, create a session, copy changes into `play/`, or run RP workflows from this mode. Global configuration profiles are editable. On the first root launch, create and activate an editable **开发默认** profile seeded from authored defaults; keep **内置默认** as a selectable read-only baseline. Keep root and play entrypoints on the same `pi-rp-web/public/index.html`, `app.js`, and `styles.css`; development mode may supply only a bridge adapter and explicit empty-state labels.

The catalog must load authored workflow defaults and each exposed module field's value from the `settings-form` region's declared collection and initial record, not from a hard-coded `settings` collection. In Agent and workflow profile panels, select **通用** or an owning module first and the specific Agent/workflow second. **通用** contains only catalog entries without a module owner.

Treat **配置方案** as the sole user-facing editor for models, Agents, workflow runtime policy, triggers, and node bindings; do not retain duplicate model or Agent pages in the sidebar. Show every workflow node with a clear type, but expose Agent/model controls only for `agent` nodes. Keep the separate workflow page for definition and run inspection plus operational activation/recovery controls, never for configuration. Root user and display settings persist below `.pi-rp-local/`. In play, shared `settings/common.json` is the global fallback while a card's `settings.json.settings.common` may override user or system categories; card values win without rewriting the shared file. Card-bound controls such as module rail order remain unavailable in root preview.

Global profiles are local overlays for development and future explicitly confirmed card conversion. Existing installed cards never update implicitly. API keys and other credentials stay in the project-isolated operating-system cache and never enter profile exports.

When a user-facing discussion item has several viable paths, number the item and label its paths `A`, `B`, `C` and so on. Put a justified recommendation at `A` when practical, say whether paths can be combined, and accept concise replies such as `1A+C`. Preserve earlier decisions and relabel changed paths before asking again. Do not add questions merely for this format.

Read [references/config-profile-v1.md](references/config-profile-v1.md) when changing profile storage, import/export, scope conversion, or credential handling. Read [references/configurable-fields-v1.md](references/configurable-fields-v1.md) when adding a configurable Agent, workflow, or module field.
