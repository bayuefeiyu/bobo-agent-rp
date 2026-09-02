# Frontend and Module UI Merge

Read this reference only for the frontend stage. Use the current converter [Web runtime contract](../../st-card-to-pi-rp/references/web-runtime.md) as the behavioral contract.

## Establish the baseline

Compare the card's `web/` with the current `pi-rp-web` template. Recover the creation/last-upgrade template revision from `maintenance.json`, conversion reporting, file hashes, or Git history when possible.

The preferred comparison is:

```text
historical template baseline -> current customized card frontend
historical template baseline -> current frontend template
```

If no baseline is recoverable, perform a two-way comparison and explicitly separate confirmed differences from inferred customization.

## Classification

- Exact current-template match: no frontend upgrade is needed.
- Exact historical-template match with no customization: a template refresh may be `safe` after API compatibility checks.
- Customized frontend: preserve card HTML, JS, CSS, server endpoints, layout, module rendering, and card-specific behavior; propose a file-level merge.
- Unknown origin: do not replace wholesale. Isolate common template features and discuss uncertain regions.

Include module UI: every frontend module's `view.json`, module-specific CSS/JS or renderer hooks, settings controls, and server contracts. Check that template updates do not hide modules, change Agent context order, expose background modules, execute unsafe HTML, or break user/profile/card-cover behavior.

Prioritize security fixes, runtime protocol/API changes, handoff/session correctness, and data-loss prevention over visual parity. A visual redesign is optional unless required by the new contract.

## Discussion result

List files by `safe`, `adapt`, `manual`, or `skip`; identify merge hotspots and retained custom behavior. Do not present copying the latest template over a customized card as an upgrade strategy.
