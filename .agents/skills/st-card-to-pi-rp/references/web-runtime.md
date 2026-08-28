# Card-local Web View

The Web mode is a presentation surface for the current Pi session, not an alternative RP runtime.

## Ownership and layout

Copy `assets/pi-rp-web/` into every converted card as `cards/<card-id>/web/`:

```text
project/
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

## Sole-agent invariant

The already-running Pi session is the only agent and the only model/API client:

```text
card-local browser view
        ↕ local HTTP
Pi Web bridge extension
        ↕ pi.sendUserMessage + Pi session events
current play-pi-rp session
```

The browser and card-local server must not:

- hold an API key or model configuration;
- call a model API, SDK, RPC agent, or second Pi process;
- load world knowledge or decide RP behavior;
- construct model prompts or generate assistant text.

The shared `.pi/extensions/pi-rp-web.ts` extension starts the card's server, opens the page, injects browser input with `pi.sendUserMessage()`, and mirrors completed Pi responses back to the page.

Browser and tool callbacks receive ordinary extension context, which cannot replace Pi sessions. For chat reselection or card switching, dispatch the registered `/rp-web-reset <card-id>` extension command with `pi.sendUserMessage(..., { expandPromptTemplates: true })`. Its command context owns `newSession()` and re-dispatches `/rp-web` from the replacement session. Do not cast a tool/event context and call `newSession()` directly.

Each saved chat owns a public `draft/` directory. The bridge clears it before accepting every new player turn; RP tasks may create arbitrary temporary documents there, but nothing in it is authoritative session state. A native variable update uses a pending draft there and runs as a hidden Pi follow-up after the player-visible prose has been saved. Interrupted variable drafts remain pending and block a new turn until completed; finalized data lives only in the module's complete snapshot records.

Editing any saved message revises only that message text. It deliberately leaves all later messages and module records untouched. Deleting a saved message truncates that message and the complete suffix, deletes every bound module record, and restores snapshot modules from their latest surviving record where supported.

## UI contract

1. Provide navigation panels for story, character cards, user settings, and system settings. Keep settings in repeatable setting-card sections so later fields can be added without restructuring the page. Keep the main application surface left aligned. On sufficiently wide screens, give the story a little less than two thirds of the viewport and place a card-local module rail to its right. The story column shrinks first as the viewport narrows while the rail remains stable; when the two would reach approximately equal width, move the whole rail below the story and let both shrink together. Render messages as one continuous left-aligned reading stream with avatar, speaker name, and body; do not separate user and assistant text into opposing chat bubbles or leave large bubble margins.
2. In story, restore current bridge state before loading optional start choices. If the current Pi session already has a selected opening, enter its chat directly. Put a compact `聊天记录选择` action in the card title bar rather than inside the story body. Activating it creates a fresh Pi session for the same card and reopens the initial saved-chat/opening selector, preserving the prior transcript. Only at a fresh start offer both choices: resume a saved chat or begin from an opening. Display a selected opening unchanged as the first message. Treat repeated selection requests as recovery from a stale view and return the authoritative current state instead of replacing the opening.
3. Read bridge state and render its ordered messages. Submit player text to the bridge; the bridge injects it into the current Pi session.
4. In the character-card panel, list every valid card under `cards/`, with search, display name, and a cover resolved from `manifest.cover`, a root `cover.*`, or the original source image. Switching cards must create a fresh Pi session before opening the selected card so contexts never mix.
5. In start choices, let the player delete inactive saved chats only after explicit confirmation. Resolve the exact session under `sessions/<card-id>/`, refuse the active record, and delete no broader path.
6. In user settings, select saved player profiles by name and edit the active name and description. Allow one PNG, JPEG, or WebP avatar of at most 5 MB per saved nickname. Store image bytes under `settings/avatars/` and only the safe relative avatar reference in that profile's `settings/common.json` entry. Validate both declared MIME type and file signature. Use the current card cover as the assistant avatar and the nickname-specific image as the player avatar, with initial-letter fallbacks. Persist the active profile in current session metadata. Inject the active profile as fixed RP context before the card's primary-character profile; avatars are presentation-only and a description must never override player agency.
7. In system settings, adjust the story font size and persist it in `settings/common.json`. Also list every frontend feature module with a visibility checkbox and accessible up/down controls. Persist module visual order and hidden IDs in `cards/<card-id>/settings.json` under `settings.featureModules`; apply them only to the Web rail. Background modules never appear in this list. Presentation preferences do not enter Pi context, alter transcripts, rewrite module definitions, or change author-controlled `contextOrder`.
8. Poll or subscribe to bridge state and display the completed Pi response.
9. Render frontend card feature modules from `GET /api/modules` inside `#card-module-list`. Use card-local `settings.featureModules` when present; otherwise use authored `displayOrder`. Each module is an independent titled disclosure section, collapsed by default. Keep its expanded state only in current page memory so it survives polling updates but resets on F5; do not persist disclosure state in common settings. Read each module's declarative `view.json` to map regions to its current chat's data. Render `json` regions as recursive key/value fields—nested groups and numbered array items—not as raw JSON source, braces, quoted keys, or monospace code. The endpoint must omit background modules, and visible selection or sorting remains frontend-only. Do not hard-code a placeholder module in the generic frontend.

After the bridge accepts a chat reselection or card-switch handoff, permanently make the initiating browser page inert and show that a new page is opening. Never restore its controls with a timeout: the old page belongs to the retired Pi session, so any later request from it is invalid. If an already-stale page receives the bridge's closed-session response, replace its controls with the same inert handoff notice. The player should only continue in the newest Web RP page.

Render authored and generated message content with the card-local safe Markdown renderer. Preserve hard line breaks and support headings, emphasis, strong text, lists, quotes, links, rules, and code. Build DOM nodes with text content; never pass card or model text to `innerHTML` or execute raw HTML. Frontend state is disposable; the current Pi session and its server-side transcript are authoritative.

## Bridge endpoints

- `GET /api/card`: card name and opening previews.
- `GET /api/state`: selected opening, ordered view messages, and whether Pi is busy.
- `GET /api/sessions`: saved chat summaries for this card, newest first.
- `GET /api/cards`: searchable character-card catalog metadata.
- `GET /api/cards/<card-id>/cover`: safe card cover bytes.
- `GET /api/settings`: public common settings and the current card's unique settings.
- `GET /api/modules`: frontend feature-module metadata, declarative view specifications, and current chat-local data in `displayOrder`; background modules are never exposed.
- `GET /api/user-avatar?playerName=<name>`: read one saved nickname's validated avatar.
- `POST /api/opening`: select one opening for the current Pi session.
- `POST /api/card-switch`: create a fresh Pi session and open the selected card.
- `POST /api/resume`: attach a saved card transcript to the current Pi session and continue it.
- `POST /api/input`: transfer player text to the current Pi session.
- `POST /api/user-settings`: update the player display name in the current Pi session.
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
├── catalog/
│   └── messages.json
├── context/
│   └── receipts/
└── modules/
    └── <module-id>/
        ├── binding.json
        ├── records.jsonl
        ├── snapshot.json
        └── catalog.json
```

The card ID is a filesystem-safe manifest ID and forms the first grouping level. Every message is a common version 1 record envelope. The selected opening is sequence `0`, turn `0`, with message role/kind/content in `data`. Each later player message and completed Pi reply share a positive bound turn and receive consecutive sequence values. Pi's native session remains an operational log; before every Web RP model call its older conversation and tool messages are replaced by fresh fixed context plus policy-selected records.

When resuming a saved chat from a newly started Pi session, bind directly to its transcript, continuity files, and feature-module records. Before each new Web turn, rebuild model context from those files and append subsequent Web turns to the selected saved-chat directory. Do not rewrite the existing transcript merely to resume it.

Every displayed assistant or player message may expose local edit and delete controls. Editing revises its envelope. Deleting truncates that message and every later message; the browser states the affected count before confirmation. Resequence survivors and remove every module record whose `binding.messageId` belongs to the deleted suffix. If no message remains, remove that exact chat directory. The next turn rebuilds context from the resulting files.

## Feature modules

Read [feature-modules.md](feature-modules.md) for module v3. The extension supplies each module's skill/storage path and retrieval mode in author-controlled `contextOrder`, with background modules after frontend modules. Every detailed prompt stays in the module skill. The Web endpoint exposes `{records, snapshot}` only for frontend modules and uses `displayOrder`; browser preferences never alter Agent context.

For each source, the runtime executes its default/custom code selector. Agent-enabled sources also expose a compact catalog and require `rp_context_query`; code resolves exact requested records and falls back to the code selector on failure. Each turn writes a context receipt containing automatic IDs, Agent decisions, selected IDs, errors/fallbacks, and any unresolved source.

## Starting Web mode

Use the `play-pi-rp-web` skill. It follows `play-pi-rp` and additionally calls the extension tool `start_rp_web` with the selected card. The extension selects an available local port and opens the card page automatically. No API setup is requested in the page.
