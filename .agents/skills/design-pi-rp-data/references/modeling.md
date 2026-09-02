# Data ownership and modeling

## Classify before modeling

Choose the narrowest correct owner:

- Stable authored lore, rules, and character material remain Markdown context.
- Cross-card player identity and preferences belong to user/profile settings unless the feature explicitly requires card-session state.
- Authored defaults belong to card-local initial records.
- Mutable, durable, queryable RP state belongs to a module collection in the active session.
- Node drafts and intermediate results are workflow artifacts, not authoritative records.
- Indexes, catalogs, projections, and reports that can be rebuilt are derived data.
- A frontend view presents authoritative data; it does not own a second copy.

Do not convert static prose to records solely to make it appear structured. Do not keep mutable state in prompt Markdown or frontend settings.

## Ownership boundary

One module owns one coherent feature boundary and may own multiple collections. Split ownership when records have materially different authority, visibility, lifecycle, or update responsibility. Keep related records together when they must change atomically or share one semantic owner.

A collection groups records with compatible storage and access patterns. A record type defines one stable lifecycle and data meaning. Avoid one generic type whose fields mean different things in different workflows; also avoid a separate collection for every field.

Cross-module references use stable record IDs only when the authored design requires durable references. Declare `identity` only for record types whose names or aliases should resolve. Do not register transient values, private implementation rows, or every record automatically.

## State, history, and storage

- Use `snapshot` when callers need the effective current state and earlier values are not ordinary records.
- Use `record-log` when individual events or revisions must remain independently addressable.
- Use `hybrid` when current effective state and retained history are both authored requirements.

Choose partitioning from real access and pruning needs:

- `single` for small collections read as one unit;
- `index` when a stable indexed field defines useful partitions;
- `turn-range` when turn-bound history and suffix pruning dominate.

Custom partition logic belongs to trusted deterministic code only when standard modes cannot express the requirement.

## Initial data and binding

Initial records are card-owned defaults copied into a new session. Opening-specific state is initialized only for the selected opening and does not become universal canon.

Use message/turn binding for state that should disappear when the corresponding message suffix is removed. Do not bind durable facts that must survive transcript pruning. Make deletion, archive, restoration, and effective-state rules explicit.

## Truth and visibility

Separate objective state, a character's belief, rumors, secrets, and player-visible presentation when their truth or disclosure differs. A character belief never becomes objective truth merely because it is stored. Visibility is enforced through workflow routing, capabilities, and named views rather than duplicated records.
