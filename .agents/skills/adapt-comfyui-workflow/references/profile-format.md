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
  "output": { "nodeIds": ["9"] }
}
```

Every binding is a `{nodeId,input}` pair that must exist in the API workflow. Positive may contain multiple bindings. Negative, seed, and filenamePrefix may be empty only if the workflow genuinely does not use that input. An output node must ultimately report ComfyUI history image references; opaque custom save nodes are unsupported.

`connectionId` selects a runtime connection. `local` is the conventional loopback connection but is still an explicit configuration record. Credentials never enter this file. Runtime-computed digests are not authored fields.

The backend assembles `positivePrefix + content + positiveSuffix` with `separator`, writes the fixed `negative`, generates a fresh seed, and supplies a safe `bobo-agent-rp/<chat-folder>/<request-file-prefix>` filename prefix. No binding may address `_meta`, class type, or a path outside node `inputs`.
