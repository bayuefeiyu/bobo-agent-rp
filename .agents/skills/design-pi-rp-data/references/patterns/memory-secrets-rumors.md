# Memory, secret, and rumor patterns

Model these features by truth, knower, provenance, lifecycle, and disclosure rather than by their UI label.

- A memory normally belongs to the remembering subject and may be inaccurate without changing objective history.
- A secret separates the fact's authority from who may know or reveal it.
- A rumor records a claim, source, audience or spread, confidence/status, and possible relation to an objective fact without equating the two.

Use stable IDs for people, places, events, or claims only when durable cross-record links are required. Index common deterministic selectors such as subject, knower, status, location, or spread stage. Keep full text in a view only when that caller is allowed to know it.

Creation, revision, revelation, retraction, forgetting, and archive have different meanings; do not collapse them into unconditional overwrite or deletion. When one event changes several knowledge states, use an atomic batch or an ordered workflow with an explicit conflict strategy.
