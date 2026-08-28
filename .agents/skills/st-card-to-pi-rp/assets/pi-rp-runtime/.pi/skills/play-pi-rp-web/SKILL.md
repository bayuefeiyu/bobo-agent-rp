---
name: play-pi-rp-web
description: Play or resume a converted Pi RP card through its card-local Web interface while keeping the current Pi agent session as the sole roleplay engine.
---

# Play Pi RP in Web

Follow the complete RP behavior, context loading, knowledge lookup, character portrayal, truth precedence, and continuity rules in `../play-pi-rp/SKILL.md`.

The only mode difference is the interface:

1. Identify and prepare the card exactly as in `play-pi-rp`.
2. Do not ask for an opening or saved chat in the terminal. Call `start_rp_web` with the card ID; the card's own page opens and presents both authored openings and resumable chats belonging to that card.
3. Treat the bridge's fresh per-turn context block as authoritative. It contains the code-selected message/module records and catalogs prescribed by the card, immediately reflects Web edits and suffix deletions, and replaces earlier Pi-session conversation, summaries, tool results, and prior injected RP context.
4. Resolve every agent-enabled catalog with `rp_context_query` according to its module skill. Treat Web input from `pi.sendUserMessage()` as the current player message. Tool calls/results made after that input remain available only for that run and are discarded from continuity when the next Web input rebuilds context.
5. Return normal player-visible RP prose. The bridge saves that prose before any post-narrative task. When a native variable module exists, follow the hidden update task afterward: it supplies every effective variable, allows repeated `rp_variable_update` calls, and ends with `rp_variable_finalize`. Do not emit more story prose during that task.
6. Treat `sessions/<card-id>/<chat-id>/draft/` as disposable per-turn workspace for any task. It is cleared before the next player turn; an interrupted variable draft may remain pending but is not effective state.

Do not call a model API, start a second Pi process, create a second agent session, or implement RP logic in the Web server. In Web mode the bridge owns the view transcript under `sessions/<card-id>/<pi-session-id>/`; do not append duplicate transcript records yourself.
