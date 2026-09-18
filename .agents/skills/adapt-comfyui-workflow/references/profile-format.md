# Profile format

An adapted profile directory contains exactly the authored profile plus its source API workflow:

```text
profiles/<profile-id>/
├── profile.json
└── workflow.api.json
```

The matching model guide is `skill/guides/<guide-id>/SKILL.md`.

`profile.json` uses schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "flux-portrait",
  "title": "Flux 人像",
  "revision": "1",
  "guideId": "flux-dev",
  "connectionId": "local",
  "workflowFile": "workflow.api.json",
  "bindings": {
    "positive": [{ "nodeId": "6", "input": "text" }],
    "negative": [{ "nodeId": "7", "input": "text" }],
    "seed": [{ "nodeId": "3", "input": "seed" }],
    "filenamePrefix": [{ "nodeId": "9", "input": "filename_prefix" }]
  },
  "prompt": {
    "separator": ", ",
    "positivePrefix": "masterpiece",
    "positiveSuffix": "cinematic lighting",
    "negative": "low quality, artifacts"
  },
  "output": { "nodeIds": ["9"] },
  "seedRange": { "min": 0, "max": 1125899906842624, "source": "Seed (rgthree) node 3 caps at 2^50" }
}
```

Every binding is a `{nodeId,input}` pair that must exist in the API workflow. Positive may contain multiple bindings. Negative, seed, and filenamePrefix may be empty only if the workflow genuinely does not use that input. An output node must ultimately report ComfyUI history image references; opaque custom save nodes are unsupported.

`connectionId` selects a runtime connection. `local` is the conventional loopback connection but is still an explicit configuration record. Credentials never enter this file. Runtime-computed digests are not authored fields.

## Seed range

`seedRange` is **required** and records the integer range the bound seed node actually accepts:

- Take the limit from the bound node itself — its `max` input, a widget range, or the custom node's own source (`Seed (rgthree)` caps at 2^50 = `1125899906842624`, not at the 2^52−1 an unbounded 13-hex-digit derivation produces).
- When the node exposes no usable metadata, state the limit explicitly and say so in `source`. Do not leave the field out and do not copy a number from another node: the field has to describe *this* profile's bound node.
- Both bounds must be non-negative safe integers that survive JSON exactly. A bound above `Number.MAX_SAFE_INTEGER` is rounded on the way in, which is the same silent-off-by-a-lot failure in a new costume.
- With several seed bindings the runtime uses their intersection, and an empty intersection fails before submission.
- The range is part of the frozen profile snapshot, so a retried attempt replays the seed it already submitted. Changing the range produces a new attempt; it never re-submits an existing render with a different seed.

The reason this is a hard requirement: ComfyUI accepts a queue entry whose seed exceeds the node's limit, skips the save branch, and still reports `status_str: "success"` because unrelated nodes ran — so the failure surfaces as "no image" rather than as a rejected request. `validate-profile.mjs` refuses a profile without a range and refuses one whose `max` exceeds a numeric limit it can read from the bound node.

A profile written before this field existed still loads, but it is reported as **unverified** (`seedRangeVerified: false`, `seedRangeWarning` set) and keeps the legacy 0..2^52−1 behaviour. Re-run the adaptation step to verify it.

The backend assembles `positivePrefix + content + positiveSuffix` with `separator`, writes the fixed `negative`, derives a deterministic seed from the render id and attempt number inside the frozen range, and supplies a safe `bobo-agent-rp/<chat-folder>/<request-file-prefix>` filename prefix. No binding may address `_meta`, class type, or a path outside node `inputs`.
