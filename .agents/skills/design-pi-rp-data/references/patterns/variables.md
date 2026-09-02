# Variable-state pattern

Variables are ordinary module data. Preserve authored names, hierarchy, defaults, opening differences, types, ranges, enumerations, dynamic keys, derived fields, update conditions, relationships, visibility, display intent, and prompt references. Do not preserve MVU transport, EJS execution, patch-output blocks, event buses, or regex parsing as runtime protocols.

Use a snapshot when only effective current state matters, or hybrid storage when authored history must remain queryable. A state record may keep the complete effective state under `data.state`; split records only when fields have independent ownership, lifecycle, access, or atomicity requirements.

Define coherent capabilities such as query, set, delta, merge, append, remove, and archive. Implement deterministic bounded delta or structured merge as custom actions when ordinary guarded updates are insufficient. Related values that must remain consistent change in one atomic batch.

Narrative nodes receive only the variable views they need. A maintenance view may expose more fields to an explicitly authorized maintenance node. An authored HUD and a maintenance inspector are presentation views over the same authority, not alternate stores.
