---
name: play-pi-rp-web
description: Play or resume a converted Pi RP card through its card-local Web interface while keeping the current Pi agent session as the sole roleplay engine.
---

# Play Pi RP in Web

Follow the complete RP behavior, context loading, knowledge lookup, character portrayal, truth precedence, and continuity rules in `../play-pi-rp/SKILL.md`.

The only mode difference is the interface:

1. Identify and prepare the card exactly as in `play-pi-rp`.
2. Do not ask for an opening or saved chat in the terminal. Call `start_rp_web` with the card ID; the card's own page opens and presents both authored openings and resumable chats belonging to that card.
3. Treat Web input from `pi.sendUserMessage()` as the current player message. Follow the active workflow's message retrieval and unified-data permissions exactly as in `play-pi-rp`.
4. Return normal player-visible RP prose. Follow any separate post-narrative task that the bridge starts without emitting more story prose.
5. Use the supplied `workspace/public/turn/` path for shared task drafts.

Do not call a model API, start a second Pi process, create a second agent session, or implement RP logic in the Web server. In Web mode the bridge owns the view transcript under `sessions/<card-id>/<pi-session-id>/`; do not append duplicate transcript records yourself.
