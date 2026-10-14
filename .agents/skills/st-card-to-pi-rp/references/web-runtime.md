# Card-local Web View

The [workflow execution protocol](../../design-pi-rp-data/references/workflow-executions.md) also governs Web views. Current-turn narrative controls create, preview and adopt attempts; preview uses the attempt's own module/image records, while runtime transcript and future inputs retain the selected state. Workflow re-execution has a generic API, with buttons only where needed. Manual text edits retain revisions without forced dependent recomputation.

`frontend-view.json` schemaVersion 3 supports a `stories` binding consumed by the default `story-browser` renderer for published long-form stories. Its index view carries only a one- or two-sentence directory summary plus fields such as time, place, cast, and series; the full view loads lazily and should omit the duplicate summary. Optional series grouping is presentation-only. With `allowOpenAuthoritySource: true`, an advanced-user button opens the record's actual authoritative JSONL partition. That deliberate DIY escape hatch bypasses data APIs, so the project does not repair version, index, or archive damage caused by hand edits.

The Web mode is a presentation surface for the current Pi session, not an alternative RP runtime.

## Ownership and layout

Publish a staging card with `scripts/package_card_runtime.mjs`. The packager copies the shared contract/client/server into `runtime/packages/`, official platform assets into `web/public/`, and records `web/frontend.json`. Never add a custom `web/server.mjs`; old server entries and package formats are rejected. The play selector starts without Pi and launches a card-bound Pi process only after selection. Pi may keep `play/` as its working directory, but all authored behavior is loaded from the selected card:

```text
play/
├── launcher/                  # independent card selector and recent-card list
├── cards/<card-id>/
│   ├── runtime/engine/        # this card's Pi extension, libraries and Skills
│   ├── defaults/              # authored behavior defaults
│   ├── settings.json          # card-local user choices
│   ├── openings/
│   └── web/                   # frontend manifest, platform assets and optional frontends/
├── pi-sessions/<card-id>/     # Pi's own sessions
└── sessions/<card-id>/        # RP transcript and module authority
```

The generic template is copied, not shared at runtime. A later conversion or manual edit may customize that card's typography, layout, portraits, status panels, or other presentation without changing other cards.

## Orchestration invariant

The browser remains presentation/configuration only. The bound Pi extension is the authoritative scheduler and may create isolated in-memory Pi Agent workers for workflow nodes:

```text
card-local browser view
        ↕ local HTTP
Pi Web bridge + workflow scheduler
        ↙                         ↘
current narrative Pi session      isolated node Agent sessions
```

The browser and card-local server must not:

- persist an API key in browser storage or call a model API directly;
- execute workflow/Agent logic;
- load world knowledge or decide RP behavior;
- construct model prompts or generate assistant text.

The card-owned `runtime/engine/extensions/pi-rp-web.ts` starts its matching Web server, reads authored defaults and editable profiles from this card, registers providers, schedules nodes, injects the narrative node with `pi.sendUserMessage()`, and mirrors completed responses back to the page. Ordinary worker nodes use isolated in-memory Pi sessions and card/chat workspaces. A `team` node instead gives each configured member one isolated persistent session under that node's private workspace so later meeting phases can continue the same member context; members receive only the dedicated team read/control tools. Neither form becomes an alternative browser-side runtime.

Browser and tool callbacks receive ordinary extension context, which cannot replace Pi sessions. Chat reselection stays in this card's frontend. Opening another card returns to the standalone selector, which starts a separate card-bound Pi process. `/rp-web-reset` remains available for this card's own Pi session reset; it must not load a different card in the same process.

Each workflow node owns `workspace/private/<workflow-id>/<run-id>/<node-id>/`. Nodes declare named outputs, scopes, and retention; the runtime registers only those exact files. Nothing in a workspace is authoritative session state. Durable/queryable information is committed through unified change batches to module collections, either explicitly or by exact node-end declarations.

Editing any saved message revises only that message text. It deliberately leaves all later messages and module records untouched. Deleting a saved message truncates that message and the complete suffix, deletes every bound module record, and restores snapshot modules from their latest surviving record where supported.

## Official UI behavior (not a creator layout contract)

Creator gameplay may replace the whole play area and reuse official management navigation. The following describes the default implementation only. Use the [visual-neutral handoff](../../../../FRONTEND-FUNCTIONAL-HANDOFF.md) for a new design and the [creator guide](../../../../FRONTEND-CREATOR-GUIDE.md) for the public boundary.

1. Provide navigation panels for story, character cards, user settings, system settings, workflow runtime, configuration profiles, and Token statistics. Keep settings in repeatable setting-card sections so later fields can be added without restructuring the page. Keep the main application surface left aligned. On sufficiently wide screens, give the story a little less than two thirds of the viewport and place a card-local module rail to its right. The story column shrinks first as the viewport narrows while the rail remains stable; when the two would reach approximately equal width, move the whole rail below the story and let both shrink together. Render messages as one continuous left-aligned reading stream with avatar, speaker name, and body; do not separate user and assistant text into opposing chat bubbles or leave large bubble margins.
2. In story, restore current bridge state before loading optional start choices. If the current Pi session already has a selected opening, enter its chat directly. Put a compact `聊天记录选择` action in the card title bar rather than inside the story body. Activating it creates a fresh Pi session for the same card and reopens the initial saved-chat/opening selector, preserving the prior transcript. Only at a fresh start offer both choices: resume a saved chat or begin from an opening. Display a selected opening unchanged as the first message. Treat repeated selection requests as recovery from a stale view and return the authoritative current state instead of replacing the opening.
3. Read bridge state and render its ordered messages. Submit player text to the bridge; the bridge injects it into the current Pi session.
4. In the character-card panel, list every valid card under `cards/`, with search, display name, and a cover resolved from `manifest.cover`, a root `cover.*`, or the original source image. Switching cards must create a fresh Pi session before opening the selected card so contexts never mix.
5. In start choices, let the player delete inactive saved chats only after explicit confirmation. Resolve the exact session under `sessions/<card-id>/`, refuse the active record, and delete no broader path.
6. In user settings, select, edit, and delete saved player profiles by name. Keep at least one saved profile. Root preview persists its global development value below `.pi-rp-local/`; independent play cards read their own `defaults/common.json` and save user choices in `settings.json.settings.common`. After an opening is selected, the player name is fixed for that session; changing or deleting its active profile requires explicit root maintenance. Allow one PNG, JPEG, or WebP avatar of at most 5 MB per saved nickname. Store avatar image bytes in the card's `settings-assets/avatars/` and only a safe relative avatar reference in the user profile. Validate both declared MIME type and file signature. Use the current card cover as the assistant avatar and the nickname-specific image as the player avatar, with initial-letter fallbacks. Persist the active profile in current session metadata. Inject the active profile as fixed RP context before the card's primary-character profile; avatars are presentation-only and a description must never override player agency.
7. In system settings, adjust the story font size. Root preview persists it as a global development default; an independent play card uses its own `defaults/common.json` and saves a higher-priority card system category under `settings.json.settings.common`. Also list every frontend feature module with a visibility checkbox and accessible up/down controls. Persist module visual order and hidden IDs in `settings.json.settings.featureModules`; apply them only to the Web rail and keep these card-bound controls disabled in root preview. Background modules never appear in this list. Presentation preferences do not enter Pi context, alter transcripts, rewrite module definitions, or change author-controlled `contextOrder`.
8. Poll or subscribe to bridge state and display the completed Pi response.
9. Discover modules through `GET /api/v1/modules`. SchemaVersion 3 separates validated authority bindings from renderer regions; background modules are omitted. Read/write data through `/bindings/<binding-id>/...`, with request-local readContext, named views and budgets. Settings writes require expectedRevision and operationId. Renderer selection does not grant authority, and presentation order does not change Agent access.
10. Edit model profiles only inside the named configuration-profile panel; do not expose a duplicate API/models page in the sidebar. Support service URL/protocol/model, limits/thinking, optional head/tail prompts, and local credentials. Store API keys only in the project-hashed operating-system cache described in `workflow-system.md`; never echo a saved API key back to the browser or include it in profile JSON.
11. Edit Agents only inside the named configuration-profile panel and select their owner before the Agent; `通用` contains only non-module Agents. Do not expose a duplicate Agent page in the sidebar. Agent default model has lower precedence than a node or workflow default.
12. In the workflow runtime panel, reread definitions, show the active card-local foreground workflow, node types/effective bindings and live status, highlight running/failed states, and provide foreground activation, retry-with-model, recovery, skip, and cancel actions. The current-running button selects an actually running foreground/background workflow at click time and cycles simultaneous workflows. Do not expose generic manual workflow execution in this panel. Team definitions show their configured members and abilities; team run nodes show phase, round, speech/task counts, independent pools, errors, the exact failed member when available, incomplete usage coverage, and an action that opens the allowlisted complete meeting transcript with the operating system's default editor. Retry-with-model on a team node replaces only the selected failed member's frozen model binding. Deterministic team configuration errors and terminal foreground runs are not offered as retries; a failed terminal foreground turn must be followed by a new player turn after correction. Do not edit runtime policy, triggers, or node bindings here; those belong to configuration profiles. For every node with an available process record (including running/failed nodes), show `查看运行记录`. Open an in-page dialog showing exactly one model call, with previous/next/latest buttons, request/response/tool tabs, per-call input/output/cache-read/cache-write/total tokens, model, duration and status. Retry attempts and team members can be filtered. Polling preserves the selected historical call. The allowlisted GET process-record endpoint returns call summaries plus only the selected call content; never expose arbitrary paths or request credentials. Legacy Markdown renders in the dialog with an explicit last-message-only label. The separate complete meeting transcript action remains available. Do not add a drag editor. Active instances retain their start snapshot.
13. In Token statistics, aggregate the current chat's recorded attempts, show each completed workflow's persisted total, and list each successful node's input, output, cache-read, cache-write, and total token usage. Also show a completed workflow's total on its workflow-run card. Successful deterministic nodes without a model call record zero usage. Older records without usage data must be marked as unrecorded, and incomplete attempt coverage must be disclosed instead of presenting the subtotal as exact.
14. Provide configuration profiles as a panel inside the same sidebar and `index.html` shell used for play. In play, manage named card-scoped overlays for model, Agent, workflow runtime policy/triggers/node bindings, and declared module settings. From the repository-root development preview, use the same panel for global-scoped overlays while the story and card surfaces show explicit empty states. Create and activate an editable development-default profile on first root launch while retaining the built-in profile as a read-only baseline. Place 模型指定 between Agents and 工作流. Expand every module and Agent on that tab; use per-Agent dropdowns and a selected-Agent batch dropdown, save each change immediately, and report pending/success/failure beside the affected row. Persist only model assignments so other drafts survive. Keep the shared fallback switch and model on that tab; it defaults off and applies to every workflow in the current profile. Model calls use each selected Agent's assignment exclusively. Missing assignments and invalid models report errors unless fallback is explicitly enabled; `pi:current` must be selected explicitly. Ordinary nodes and team members expose Agent bindings, not independent model bindings. Team nodes retain expert/assistant arrays, agenda limits, concurrency and independent budgets. Resolve module defaults from each `settings` binding's declared collection and initial record. The standalone workflow panel is a runtime view and operational control surface; it displays fallback reasons and supports run-local model retry without saving node defaults. Support create, rename, edit, activate, duplicate, delete, import, and export. Keep credentials in the project-isolated operating-system cache, reject credentials in imports, and omit them from exports. Switching profiles affects later model calls and workflow instances; it must not rewrite an active workflow snapshot or existing session module authority.

Auxiliary outputs and state updates are ordinary workflow nodes. Their dependencies define ordering; their `moduleAccess` defines authority; and their declared unified-change-batch outputs commit before downstream nodes run. Bind turn-derived records to the saved assistant message where required, and never append auxiliary output to the main transcript.

After the bridge accepts a chat reselection or card-switch handoff, permanently make the initiating browser page inert and show that a new page is opening. Never restore its controls with a timeout: the old page belongs to the retired Pi session, so any later request from it is invalid. If an already-stale page receives the bridge's closed-session response, replace its controls with the same inert handoff notice. The player should only continue in the newest Web RP page.

Render authored and generated message content with the card-local safe Markdown renderer. Preserve hard line breaks and support headings, emphasis, strong text, lists, quotes, links, rules, and code. Build DOM nodes with text content; never pass card or model text to `innerHTML` or execute raw HTML. Frontend state is disposable; the current Pi session and its server-side transcript are authoritative.

## Public HTTP contract

The generated [API catalog](../../../../packages/rp-web-contract/API.md) is the operation source of truth. All routes use `/api/v1/`; legacy routes and the shared preview mutation are removed. JSON replies use `{data, requestId, readContext}` or structured `{error, requestId}`. Discover version, capabilities and server/card/chat identity at `connection`; send explicit readContext for mutations and preview reads. The DOM-free SDK provides instance-local previews, watchers, resource resolution and cancellation.

Module routes identify `bindingId`. Signed page cursors belong to one binding and readContext. Query a settings operation receipt after an unknown submission outcome. Configuration mutations retain the local configuration token boundary; launcher mutations use its HttpOnly same-origin cookie. Independent `config.html` and `monitor.html` initialize without the play controller.

## Transcript

The extension mirrors Web-visible interaction to a card group keyed first by card ID and then by Pi's own session ID. Starting the bridge or showing the opening/chat selector must not create this directory. Create it lazily only when the player selects an opening or the first Web-visible message is written. Resuming an existing chat binds directly to its saved directory and must not leave an empty directory for the temporary fresh Pi session:

```text
sessions/<card-id>/<pi-session-id>/
├── session.json
├── messages.jsonl             # rebuildable message-envelope projection
├── transcript.json            # pinned module provider and authority fingerprint
├── context/
│   └── receipts/
├── workflow/
│   ├── runs.jsonl
│   ├── artifacts/
│   └── process-records/<run-id>/<node-id>.md (legacy summary) and <node-id>.calls.jsonl (per-call events)
├── workspace/
│   ├── artifacts.jsonl
│   ├── transactions/
│   ├── receipts/
│   └── private/<workflow-id>/<run-id>/<node-id>/
└── modules/
    └── <module-id>/collections/<collection-id>/
        ├── records*.jsonl
        └── snapshot*.json
```

The card ID is a filesystem-safe manifest ID and forms the first grouping level. The selected opening is sequence `0`, turn `0`; later player messages and completed Pi replies share a positive turn and receive consecutive sequence values. Pi's native session remains an operational log; module records use unified envelope v2 and are queried only through authorized views.

When resuming a saved chat from a newly started Pi session, bind directly to its transcript, continuity files, and feature-module records. Before each new Web turn, rebuild model context from those files and append subsequent Web turns to the selected saved-chat directory. Do not rewrite the existing transcript merely to resume it.

The正文 provider module owns player input, opening, and published narrative documents in a record-log collection; the default is `narrative-controls/conversation/narrative.message`, partitioned by 50 turns. The canonical object view exposes role, kind, content, and narrativeSource. Main display, runtime transcript, recent context and archive input consume this same view, with ranges where needed. `messages.jsonl` is a projection cache and may be rebuilt during resume; it is not read as authority or imported automatically. Legacy JSONL-only sessions are outside this new-runtime baseline; this task provides no migration tool. Provider identity is fixed by `transcript.json` per saved chat, and authority corruption is reported instead of falling back to the cache.

Every displayed assistant or player message may expose local edit and delete controls. Editing appends a module document revision under the same stable ID, guarded by expectedRevision and an idempotent operationId. Current display uses the latest revision; bounded history is available through `GET /api/v1/messages/<sequence>/history`, and ranges through `GET /api/v1/transcript`. Deleting truncates that message and every later message; the browser states the affected count before confirmation. Survivors keep their sequence, and every revision of every module record whose `binding.messageId` belongs to the deleted suffix is removed. If no message remains, remove that exact chat directory. The next turn rebuilds context from the resulting files.

## Feature modules

Read the authoritative [unified data protocol](../../design-pi-rp-data/references/protocol.md) and [feature-modules.md](feature-modules.md) for module v7. The extension registers only Agents and workflows declared by each module (schema 7 agentFiles/workflowFiles, workflow schema 4 ownerModuleId). It resolves prompts and scripts from that owner directory and uses fully qualified module/component references for configuration and execution. Parent nodes invoke exact workflow references; an Agent sees only its authored `workflowCalls` whose targets are `agentCallable`, subject to any fixed/allowed argument policy. Detailed prompts stay in the module skill or calling node prompt. Data/hybrid workflow nodes use `rp_data_query` and `rp_data_get` with exact capabilities, views, and budgets. Resource workflows receive only their normalized catalog and module directory and may return collision-safe `document-set` snapshots. The Web endpoint exposes collection data only for frontend data/hybrid modules and uses `displayOrder`; browser preferences never alter Agent context or access.

## Starting Web mode

Use the `play-pi-rp-web` skill. It follows `play-pi-rp` and additionally calls the extension tool `start_rp_web` with the selected card. The extension selects an available local port and opens the card page automatically. API/model setup is optional when every node uses `pi:current`; otherwise configure reusable profiles in the page before activating those node bindings.

For root development, `manage-pi-rp-config-ui` starts this same public Web shell with a loopback-only preview bridge. The bridge returns no cards, no sessions, and no messages, rejects play mutations and workflow execution, and exposes editable global configuration-profile APIs. Do not confuse read-only preview state with the configuration panel, and do not maintain a second root-only UI shell.

Do not start play mode from the conversion repository root. Pi discovers `.agents/skills` in ancestor directories, so the player must also apply the project-local skill override documented in the repository-root isolation guide before starting a fresh Pi play session from `play/`.

ComfyUI connection edits must survive unrelated module refreshes. Saving persists connection settings and the preferred selection; credentials remain in the secret cache and blank input reuses them. Provide an explicit remove action, including removal of cached credentials. Missing connections disable dependent image profiles without breaking the settings page. Turn-state polling must apply independently of slower module/panel requests and must not overlap or allow an old response to restore a completed turn blocker.

Multi-region feature modules use tabs showing one part at a time. Load tab contents on first selection, retain forms, pagination and selected tabs across refreshes, and isolate caches by chat. Existing archive/maintenance actions remain explicit task buttons. Prompt controls show each selected prompt directly below its own dial, using compact Markdown heading styles without altering authored prompt text.

Module settings have no save buttons. Switches, selects and prompt dials save on change; edited text, numbers and custom prompts save on blur. Validate locally, serialize writes, send only changed field pointers, and read the authoritative revision after each write. Failed saves retain drafts and offer retry. Rebase unrelated revision changes only; conflicting changes to the same field require explicit reload and review. Background refreshes must preserve focused inputs and pending text drafts. Module visibility, ordering and restore-default actions also persist immediately. Running workflows retain the configuration snapshot taken at their start.
