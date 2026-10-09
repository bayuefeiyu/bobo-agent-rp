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
  "compatibility": { "moduleProtocol": 7, "workflowProtocol": 4 }
}
```

`agentOverrides` keys use `module/<owner>/agent/<local>` and `workflowOverrides` keys use `module/<owner>/workflow/<local>`. These are the only component override forms; there is no unqualified fallback. Agents and workflows come from the module registry and keep their source under the module package (`global-modules/<id>/` or an imported card `features/<id>/`). Without an active profile, saving updates the existing module `componentFile`; it cannot create an unregistered component. With an active profile, saving writes the selected override and leaves the module source unchanged. The common engine, tools, system models, and cross-module prompt templates remain public host resources; there is no `module-workflow-overrides.json` layer.

Profile IDs are stable filesystem-safe identifiers. Renaming changes only `name`. Duplicating creates a new ID and does not copy credentials. Deleting a profile also deletes its project-local credential slots after explicit UI confirmation.

The profile editor may retain an incomplete model as a local draft while its model name or URL is being entered. Runtime model lists omit incomplete drafts instead of failing the whole Web UI; the configuration panel continues to show them for completion.

Exports contain exactly the normalized profile document. Reject imports containing credential fields such as `apiKey`, `token`, `password`, or `secret`; do not silently discard them. Reject a scope mismatch unless a separate explicit scope-conversion action has been requested.

Development profiles live under the Git-ignored `.pi-rp-local/config-profiles/`. Card profiles live under `play/cards/<card-id>/config-profiles/`. Active-profile pointers are local state, not part of exported bundles.

The effective configuration is authored source plus the selected overlay. A development profile does not propagate into `play/`. A conversion proposal may explicitly offer to copy one global profile into the new card after the user confirms that target.

Card-independent user identity and display defaults are stored separately from named configuration profiles. Root preview uses `.pi-rp-local/common.json`; play uses shared `settings/common.json` as a fallback and optional card-level `settings.json.settings.common` categories as higher-priority overrides. These values do not contain model credentials.
