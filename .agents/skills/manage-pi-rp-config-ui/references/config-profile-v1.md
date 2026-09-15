# Configuration profile v1

A profile is a named, non-secret overlay. Its `scope` is `global` in repository development mode and `card` in a card's play UI.

```json
{
  "schemaVersion": 1,
  "kind": "pi-rp-config-profile",
  "scope": "global",
  "id": "my-profile",
  "name": "My profile",
  "description": "",
  "models": [],
  "agentOverrides": {},
  "workflowOverrides": {},
  "moduleOverrides": {},
  "compatibility": { "moduleProtocol": 6, "workflowProtocol": 3 }
}
```

Profile IDs are stable filesystem-safe identifiers. Renaming changes only `name`. Duplicating creates a new ID and does not copy credentials. Deleting a profile also deletes its project-local credential slots after explicit UI confirmation.

The profile editor may retain an incomplete model as a local draft while its model name or URL is being entered. Runtime model lists omit incomplete drafts instead of failing the whole Web UI; the configuration panel continues to show them for completion.

Exports contain exactly the normalized profile document. Reject imports containing credential fields such as `apiKey`, `token`, `password`, or `secret`; do not silently discard them. Reject a scope mismatch unless a separate explicit scope-conversion action has been requested.

Development profiles live under the Git-ignored `.pi-rp-local/config-profiles/`. Card profiles live under `play/cards/<card-id>/config-profiles/`. Active-profile pointers are local state, not part of exported bundles.

The effective configuration is authored source plus the selected overlay. A development profile does not propagate into `play/`. A conversion proposal may explicitly offer to copy one global profile into the new card after the user confirms that target.

Card-independent user identity and display defaults are stored separately from named configuration profiles. Root preview uses `.pi-rp-local/common.json`; play uses shared `settings/common.json` as a fallback and optional card-level `settings.json.settings.common` categories as higher-priority overrides. These values do not contain model credentials.
