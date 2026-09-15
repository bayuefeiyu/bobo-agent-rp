# Card-local Web View

`frontend-view.json` schemaVersion 2 supports `story-browser` for published long-form stories. Its index view carries only a one- or two-sentence directory summary plus fields such as time, place, cast, and series; the full view loads lazily and should omit the duplicate summary. Optional series grouping is presentation-only. With `allowOpenAuthoritySource: true`, an advanced-user button opens the record's actual authoritative JSONL partition. That deliberate DIY escape hatch bypasses data APIs, so the project does not repair version, index, or archive damage caused by hand edits.

The Web mode is a presentation surface for the current Pi session, not an alternative RP runtime.

## Ownership and layout

From the conversion repository root, copy `assets/pi-rp-web/` into every converted card as `play/cards/<card-id>/web/`. At runtime, start Pi with `play/` as its working directory, so all paths below remain runtime-relative:

```text
play/
├── settings/
│   └── common.json
├── .pi/
│   ├── extensions/pi-rp-web.ts
│   └── skills/
│       ├── play-pi-rp/
│       └── play-pi-rp-web/
├── cards/
│   └── <card-id>/
│       ├── manifest.json
│       ├── settings.json
│       ├── openings/
│       ├── world/
│       └── web/
└── sessions/
    └── <card-id>/
        └── <pi-session-id>/
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

The shared `.pi/extensions/pi-rp-web.ts` extension starts the card's server, opens the page, persists submitted model profiles under `play/settings/`, registers providers, schedules nodes, injects the narrative node with `pi.sendUserMessage()`, and mirrors completed responses back to the page. Ordinary worker nodes use isolated in-memory Pi sessions and card/chat workspaces. A `team` node instead gives each configured member one isolated persistent session under that node's private workspace so later meeting phases can continue the same member context; members receive only the dedicated team read/control tools. Neither form becomes an alternative browser-side runtime.

Browser and tool callbacks receive ordinary extension context, which cannot replace Pi sessions. For chat reselection or card switching, dispatch the registered `/rp-web-reset <card-id>` extension command with `pi.sendUserMessage(..., { expandPromptTemplates: true })`. Its command context owns `newSession()` and re-dispatches `/rp-web` from the replacement session. Do not cast a tool/event context and call `newSession()` directly.

Each workflow node owns `workspace/private/<workflow-id>/<run-id>/<node-id>/`. Nodes declare named outputs, scopes, and retention; the runtime registers only those exact files. Nothing in a workspace is authoritative session state. Durable/queryable information is committed through unified change batches to module collections, either explicitly or by exact node-end declarations.

Editing any saved message revises only that message text. It deliberately leaves all later messages and module records untouched. Deleting a saved message truncates that message and the complete suffix, deletes every bound module record, and restores snapshot modules from their latest surviving record where supported.

## UI contract

1. Provide navigation panels for story, character cards, user settings, system settings, workflow runtime, configuration profiles, and Token statistics. Keep settings in repeatable setting-card sections so later fields can be added without restructuring the page. Keep the main application surface left aligned. On sufficiently wide screens, give the story a little less than two thirds of the viewport and place a card-local module rail to its right. The story column shrinks first as the viewport narrows while the rail remains stable; when the two would reach approximately equal width, move the whole rail below the story and let both shrink together. Render messages as one continuous left-aligned reading stream with avatar, speaker name, and body; do not separate user and assistant text into opposing chat bubbles or leave large bubble margins.
2. In story, restore current bridge state before loading optional start choices. If the current Pi session already has a selected opening, enter its chat directly. Put a compact `聊天记录选择` action in the card title bar rather than inside the story body. Activating it creates a fresh Pi session for the same card and reopens the initial saved-chat/opening selector, preserving the prior transcript. Only at a fresh start offer both choices: resume a saved chat or begin from an opening. Display a selected opening unchanged as the first message. Treat repeated selection requests as recovery from a stale view and return the authoritative current state instead of replacing the opening.
3. Read bridge state and render its ordered messages. Submit player text to the bridge; the bridge injects it into the current Pi session.
4. In the character-card panel, list every valid card under `cards/`, with search, display name, and a cover resolved from `manifest.cover`, a root `cover.*`, or the original source image. Switching cards must create a fresh Pi session before opening the selected card so contexts never mix.
5. In start choices, let the player delete inactive saved chats only after explicit confirmation. Resolve the exact session under `sessions/<card-id>/`, refuse the active record, and delete no broader path.
6. In user settings, select, edit, and delete saved player profiles by name. Keep at least one saved profile. Root preview persists the global development value below `.pi-rp-local/`; play reads shared `settings/common.json` as fallback and saves the current card's higher-priority user category under `cards/<card-id>/settings.json.settings.common`. Deleting the active profile selects the first remaining profile, updates current-session metadata and fixed player context immediately, and removes its avatar file when no remaining profile references it. Allow one PNG, JPEG, or WebP avatar of at most 5 MB per saved nickname. Store image bytes under the current environment's settings avatar directory and only a safe relative avatar reference in the user profile. Validate both declared MIME type and file signature. Use the current card cover as the assistant avatar and the nickname-specific image as the player avatar, with initial-letter fallbacks. Persist the active profile in current session metadata. Inject the active profile as fixed RP context before the card's primary-character profile; avatars are presentation-only and a description must never override player agency.
7. In system settings, adjust the story font size. Root preview persists it as a global development default; play inherits shared `settings/common.json` and saves a higher-priority card system category under `cards/<card-id>/settings.json.settings.common`. Also list every frontend feature module with a visibility checkbox and accessible up/down controls. Persist module visual order and hidden IDs in `cards/<card-id>/settings.json` under `settings.featureModules`; apply them only to the Web rail and keep these card-bound controls disabled in root preview. Background modules never appear in this list. Presentation preferences do not enter Pi context, alter transcripts, rewrite module definitions, or change author-controlled `contextOrder`.
8. Poll or subscribe to bridge state and display the completed Pi response.
9. Render frontend card modules from `GET /api/modules` inside `#card-module-list`. Use card-local display settings when present; otherwise use authored `displayOrder`. SchemaVersion 1 regions retain their read-only behavior. SchemaVersion 2 may additionally declare `record-browser`, `settings-form`, `workflow-controls`, and `integrity-alerts`; fetch their data only through the region-scoped APIs, never by loading all module collections into `/api/modules`. Record browsers use stable keyset pagination and rendered history, settings submit declared fields with `expectedRevision`, workflow controls start only static background IDs with typed parameters, and integrity alerts remain read-only until the user explicitly starts their statically linked repair workflow. Render JSON values recursively, never as executable content. `查看数据` remains a generated user-only diagnostic document. The browser never edits authority files directly or treats frontend access as Agent permission. Omit background modules and keep display selection/order frontend-only.
10. Edit model profiles only inside the named configuration-profile panel; do not expose a duplicate API/models page in the sidebar. Support service URL/protocol/model, limits/thinking, optional head/tail prompts, and local credentials. Store API keys only in the project-hashed operating-system cache described in `workflow-system.md`; never echo a saved API key back to the browser or include it in profile JSON.
11. Edit Agents only inside the named configuration-profile panel and select their owner before the Agent; `通用` contains only non-module Agents. Do not expose a duplicate Agent page in the sidebar. Agent default model has lower precedence than a node or workflow default.
12. In the workflow runtime panel, reread definitions, show the active foreground workflow, node types/effective bindings and live status, highlight running/failed states, and provide operational activation, retry-with-model, recovery, skip, and cancel actions. Team definitions show their configured members and abilities; team run nodes show phase, round, speech/task counts, independent pools, errors, the exact failed member when available, incomplete usage coverage, and an action that opens the allowlisted complete meeting transcript with the operating system's default editor. Retry-with-model on a team node replaces only the selected failed member's frozen model binding. Deterministic team configuration errors are not offered as model retries. Do not edit runtime policy, triggers, or node bindings here; those belong to configuration profiles. For every node whose completed run state reports an available process record, show an `打开过程记录` action beside that run node; the bridge opens the matching Markdown file with the operating system's default editor. The browser must not fetch or render the diagnostic or meeting content, and the runtime must not expose arbitrary paths. Do not add a drag editor. Active instances retain their start snapshot.
13. In Token statistics, aggregate the current chat's recorded attempts, show each completed workflow's persisted total, and list each successful node's input, output, cache-read, cache-write, and total token usage. Also show a completed workflow's total on its workflow-run card. Successful deterministic nodes without a model call record zero usage. Older records without usage data must be marked as unrecorded, and incomplete attempt coverage must be disclosed instead of presenting the subtotal as exact.
14. Provide configuration profiles as a panel inside the same sidebar and `index.html` shell used for play, not as a separate frontend. In play, manage named card-scoped overlays for model, Agent, workflow runtime policy/triggers/node bindings, and declared module settings. From the repository-root development preview, use the same panel for global-scoped overlays while the story and card surfaces show explicit empty states. Create and activate an editable development-default profile on first root launch while retaining the built-in profile as a read-only baseline. Load workflow defaults from authored definitions; choose `通用` or a module before the workflow; render every node with its type. Ordinary Agent nodes expose their Agent/model binding. Team nodes expose Leader/Secretary bindings, dynamic expert and assistant arrays, agenda limits, concurrency, and independent budget pools; models remain profile-level bindings and are never hardcoded in the module. Resolve module defaults from each `settings-form` region's declared collection and initial record. The standalone workflow panel is a runtime view and operational control surface, not a configuration editor. Support create, rename, edit, activate, duplicate, delete, import, and export. Keep credentials in the project-isolated operating-system cache, reject credentials in imports, and omit them from exports. Switching profiles affects later model calls and workflow instances; it must not rewrite an active workflow snapshot or existing session module authority.

Auxiliary outputs and state updates are ordinary workflow nodes. Their dependencies define ordering; their `moduleAccess` defines authority; and their declared unified-change-batch outputs commit before downstream nodes run. Bind turn-derived records to the saved assistant message where required, and never append auxiliary output to the main transcript.

After the bridge accepts a chat reselection or card-switch handoff, permanently make the initiating browser page inert and show that a new page is opening. Never restore its controls with a timeout: the old page belongs to the retired Pi session, so any later request from it is invalid. If an already-stale page receives the bridge's closed-session response, replace its controls with the same inert handoff notice. The player should only continue in the newest Web RP page.

Render authored and generated message content with the card-local safe Markdown renderer. Preserve hard line breaks and support headings, emphasis, strong text, lists, quotes, links, rules, and code. Build DOM nodes with text content; never pass card or model text to `innerHTML` or execute raw HTML. Frontend state is disposable; the current Pi session and its server-side transcript are authoritative.

## Bridge endpoints

- `GET /api/card`: card name and opening previews.
- `GET /api/state`: selected opening, ordered view messages, and whether Pi is busy.
- `GET /api/sessions`: saved chat summaries for this card, newest first.
- `GET /api/cards`: searchable character-card catalog metadata.
- `GET /api/cards/<card-id>/cover`: safe card cover bytes.
- `GET /api/settings`: public common settings and the current card's unique settings.
- `GET /api/modules`: frontend feature-module metadata and declarative view specifications in `displayOrder`; schemaVersion 2 regions fetch their data separately, and background modules are never exposed.
- `GET /api/data-impact`: read-only transaction/source impact lookup for one message revision, optionally limited to one installed module.
- `POST /api/modules/<module-id>/open`: open that module's generated data document or definition through the trusted bridge.
- `GET /api/modules/<module-id>/regions/<region-id>/records`: query one declared `record-browser` page; the matching `.../records/<record-id>/history` endpoint returns rendered revision history.
- `GET|PUT /api/modules/<module-id>/regions/<region-id>/settings`: read or update one declared `settings-form` using its current revision.
- `GET /api/modules/<module-id>/regions/<region-id>/integrity`: read one declared `integrity-alerts` result without changing module authority.
- `POST /api/modules/<module-id>/regions/<region-id>/workflows/<workflow-id>/run`: start one statically allowed background workflow with validated parameters.
- `GET /api/image-generation`: read the installed ComfyUI module's preferences, profiles, requests and renders. The associated preferences, run, connection, profile override/open, image proxy and regenerate endpoints remain scoped to this built-in service and its installed module.
- `GET|POST|DELETE /api/models...`: list/redact, save, discover, smoke-test, or delete model profiles.
- `GET|PUT|POST /api/agents...`: list effective Agent layers, save card/global configuration, or restore the card default.
- `GET /api/workflows`, `GET /api/workflow-runs`: reread definitions and live instances.
- `POST /api/workflows/<id>/activate`, `PUT .../nodes/<id>/binding`, `PUT .../trigger`: activate/copy a workflow, change a card node binding, or configure a supported background trigger.
- `POST /api/workflow-runs/<id>/nodes/<id>/retry`, `POST .../cancel`, `POST .../skip`: explicit failure and blocking-run recovery. `POST .../nodes/<id>/process-record/open` opens a completed node's user-only process record; `POST .../nodes/<id>/team-transcript/open` opens only that team's registered transcript.
- `GET|PUT /api/workflow-policy`: concurrency and explicit silent-fallback policy.
- `GET /api/user-avatar?playerName=<name>`: read one saved nickname's validated avatar.
- `POST /api/opening`: select one opening for the current Pi session.
- `POST /api/card-switch`: create a fresh Pi session and open the selected card.
- `POST /api/resume`: attach a saved card transcript to the current Pi session and continue it.
- `POST /api/input`: transfer player text to the current Pi session.
- `POST /api/user-settings`: update the player display name in the current Pi session.
- `DELETE /api/user-profile?playerName=<name>`: delete one saved profile, retaining at least one and switching the current profile when necessary.
- `POST /api/module-display-settings`: save card-local frontend module order and hidden IDs without changing Agent context.
- `POST /api/user-avatar?playerName=<name>`: upload one validated nickname-specific avatar as raw image bytes.
- `POST /api/system-settings`: update shared presentation settings.
- `PUT /api/messages/<sequence>`: replace one message's saved local text.
- `DELETE /api/messages/<sequence>`: truncate the saved local transcript from that message onward.
- `DELETE /api/sessions/<session-id>`: delete one inactive chat after client confirmation.

These are view/transport endpoints, not an agent API.

## Transcript

The extension mirrors Web-visible interaction to a card group keyed first by card ID and then by Pi's own session ID. Starting the bridge or showing the opening/chat selector must not create this directory. Create it lazily only when the player selects an opening or the first Web-visible message is written. Resuming an existing chat binds directly to its saved directory and must not leave an empty directory for the temporary fresh Pi session:

```text
sessions/<card-id>/<pi-session-id>/
├── session.json
├── messages.jsonl
├── context/
│   └── receipts/
├── workflow/
│   ├── runs.jsonl
│   ├── artifacts/
│   └── process-records/<run-id>/<node-id>.md
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

Every displayed assistant or player message may expose local edit and delete controls. Editing revises its envelope. Deleting truncates that message and every later message; the browser states the affected count before confirmation. Resequence survivors and remove every module record whose `binding.messageId` belongs to the deleted suffix. If no message remains, remove that exact chat directory. The next turn rebuilds context from the resulting files.

## Feature modules

Read the authoritative [unified data protocol](../../design-pi-rp-data/references/protocol.md) and [feature-modules.md](feature-modules.md) for module v6. The extension registers only the workflows listed by each module. Parent nodes invoke exact workflow references; an Agent sees only its authored `workflowCalls` whose targets are `agentCallable`, subject to any fixed/allowed argument policy. Detailed prompts stay in the module skill or calling node prompt. Data/hybrid workflow nodes use `rp_data_query` and `rp_data_get` with exact capabilities, views, and budgets. Resource workflows receive only their normalized catalog and module directory and may return collision-safe `document-set` snapshots. The Web endpoint exposes collection data only for frontend data/hybrid modules and uses `displayOrder`; browser preferences never alter Agent context or access.

## Starting Web mode

Use the `play-pi-rp-web` skill. It follows `play-pi-rp` and additionally calls the extension tool `start_rp_web` with the selected card. The extension selects an available local port and opens the card page automatically. API/model setup is optional when every node uses `pi:current`; otherwise configure reusable profiles in the page before activating those node bindings.

For root development, `manage-pi-rp-config-ui` starts this same public Web shell with a loopback-only preview bridge. The bridge returns no cards, no sessions, and no messages, rejects play mutations and workflow execution, and exposes editable global configuration-profile APIs. Do not confuse read-only preview state with the configuration panel, and do not maintain a second root-only UI shell.

Do not start play mode from the conversion repository root. Pi discovers `.agents/skills` in ancestor directories, so the player must also apply the project-local skill override documented in the repository-root isolation guide before starting a fresh Pi play session from `play/`.
