---
name: audit-and-upgrade-pi-rp-card
description: Audit an already converted Pi RP card and design a bounded upgrade through five user-led discussion stages. Use only when the user explicitly asks to inspect, audit, compare, maintain, migrate, or upgrade a converted card; never invoke automatically during conversion, template development, or play.
---

# Audit and Upgrade a Pi RP Card

Inspect one explicitly named converted card without treating project template changes as permission to rewrite it. Discuss one area at a time, remember the user's decisions, present one concise final design, and wait for final confirmation before changing any card, runtime, frontend, setting, or session file.

## Hard boundaries

- Run only after an explicit user request naming or clearly identifying the converted card. Do not infer an audit from ordinary conversion, play, template development, repository pull, or runtime sync work.
- Audit and discussion are read-only. A request to audit or propose an upgrade does not authorize implementation.
- Never modify `sessions/` during ordinary card maintenance. A session-data migration is a separate material action that must be listed in the final design and explicitly confirmed.
- Card maintenance modifies only the named card and any separately confirmed runtime or sessions. Never modify root Skills, templates, global modules, or another card as a consequence of card customization.
- Do not write global-promotion suggestions, reusable-candidate markers, upstream notes, or template recommendations into the card, its prompts, module Skills, workflows, provenance, reports, or maintenance metadata. Whether a card change should become global is solely the user's decision.
- Preserve card-specific prompts, workflows, modules, and Web customization. Current templates are comparison sources, not overwrite targets.
- Treat a skipped stage as `skipped`, not as passed or issue-free. Keep its residual risk visible in the final summary.
- If implementation reveals a material issue outside the confirmed design, stop and reopen the affected discussion stage.

## Start and inventory

Resolve the exact `play/cards/<card-id>/` target. If more than one card could match, ask one concise identification question before inspecting. Record whether the user supplied an updated source card and whether actual session evidence was explicitly placed in scope.

Read the repository-root `PI-RP-DEVELOPMENT-SCOPE.md`. When the card contains structured persistent data, also read the sibling [data-design Skill](../design-pi-rp-data/SKILL.md) and only the references needed for the affected design.

Run the read-only inventory helper when available:

```bash
python .agents/skills/audit-and-upgrade-pi-rp-card/scripts/inventory_card.py play/cards/<card-id> --project-root . --pretty
```

Also run the current structural validator. Use inventory and validation as evidence, not as substitutes for semantic review. Do not dump their full output unless the user asks.

Read the validation result in three parts rather than one pass/fail: **errors** are real defects; **`design:` warnings** say the card does not follow a shipped-template convention, which is legitimate for a customized card but must be a deliberate answer the audit can state; an existing `manifest.design_invariants` is the card's own promise, so a violated invariant is an error and a card whose design changed may need the declaration updated. Never propose declaring an invariant the card does not satisfy — that turns an honest warning into a failing card.

Maintain an internal discussion ledger with exactly these states: `pending`, `accepted`, `skipped`, `not-applicable`, and `revisit`. Store the user's decision, confirmed scope, and residual risk for each stage. Do not ask the user to remember earlier decisions.

## Discussion order

The five stages are:

1. Card-pack semantics
2. Workflows
3. Project dependencies
4. Frontend
5. Updated-source analysis

When an updated source card is supplied at the start, discuss updated-source analysis first because its delta can change every later stage, then return to stages 1–4. Otherwise use the order above and mark stage 5 `not-applicable` only after telling the user that no updated source was supplied.

At each stage, read only its linked reference and the current project specifications it routes to. Present only:

1. **Findings** — important confirmed problems, changes, and uncertainties;
2. **Recommendation** — the preferred treatment and why;
3. **Decision needed** — only choices that materially change the outcome;
4. **Choices** — accept the recommendation, discuss one finding, skip this stage, or return to the previous stage.

When a discussion item has several paths, number the item and label its paths `A`, `B`, `C` and so on. Put the recommended path at `A` when practical and give its reason; do not invent a recommendation when the paths are equally suitable. Say whether the paths can be combined, so the user can reply concisely, for example `2A+C`. Keep accepted choices stable and relabel a changed choice set before asking again. This format does not create extra decision gates.

After the user decides, acknowledge with a compact ledger update such as `Recorded: preserve the customized workflow and repair two conflicts. Progress: 2/5. Next: project dependencies.` Then continue to the next stage. The user may revisit any completed or skipped stage before final confirmation.

- For card-pack semantics, read [references/prompt-audit.md](references/prompt-audit.md).
- For workflows, read [references/workflow-audit.md](references/workflow-audit.md).
- For project dependencies, read [references/dependency-upgrade.md](references/dependency-upgrade.md).
- For frontend and module UI, read [references/frontend-merge.md](references/frontend-merge.md).
- When an updated source is supplied, read [references/source-upgrade.md](references/source-upgrade.md).

## Final design and confirmation gate

After all five stages are `accepted`, `skipped`, or `not-applicable`, read [references/report-format.md](references/report-format.md) and present a concise summary table plus a brief implementation design. Include confirmed changes, execution order, files or layers in scope, migrations, validation, explicit exclusions, skipped stages, and residual risks. Do not repeat the full findings from every stage.

Ask for one final confirmation to implement exactly that design. A confirmation covers only listed work. It does not reopen skipped stages, authorize unrelated template synchronization, or authorize session migration not shown in the design.

## Confirmed implementation

After final confirmation:

1. Recheck the target and current file hashes so the design has not gone stale.
2. Back up only files that will change under the repository-root ignored `.card-maintenance-backups/<card-id>/<timestamp>/`; keep backups outside `play/` and verify every resolved target remains inside the named card or explicitly confirmed runtime target.
3. Apply the confirmed changes incrementally. Never replace a customized frontend or copied package wholesale when a bounded merge can preserve its behavior.
4. Update provenance/conversion reporting where source meaning or ownership changed. Create or update optional `maintenance.json` only after a confirmed implementation, never during audit-only work.
5. Run structural validation, affected unit tests, workflow checks, and frontend syntax/tests in proportion to the change.
6. Report applied changes, validation results, skipped work, remaining risks, and recovery location.

Use the labels `safe`, `adapt`, `migrate`, `manual`, and `skip` consistently for proposed upgrade actions. Never describe uncertain two-way comparisons as proven three-way merges.
