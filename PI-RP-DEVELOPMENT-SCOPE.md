# Pi RP development scope

All conversion, module development, data design, card customization, audit, migration, and template work starts from the repository root. `play/` is the isolated play environment, although a root-started development task may explicitly target a converted card below `play/cards/`.

## Independent layers

Treat these as independent modification targets:

1. root Skills, specifications, global modules, runtime templates, Web templates, tests, and documentation;
2. the installed shared runtime and settings under `play/`;
3. each converted card under `play/cards/<card-id>/`;
4. each card's session authority under `play/sessions/<card-id>/`.

Reading one layer for comparison does not authorize writing it. A confirmation such as “start”, “apply the plan”, or “continue” covers only the targets already named in the plan.

## No implicit propagation

- Root development does not update installed runtime, converted cards, or sessions.
- Updating installed runtime does not update root templates, card-local customizations, or sessions.
- Customizing one card changes only that named card. It does not change root Skills, templates, global modules, shared runtime, another card, or sessions.
- Session migration requires an explicitly named card/session scope and does not change the card or root sources unless separately listed.
- A global module, workflow, Agent configuration, or Web template copied into a card becomes card-owned. Source metadata such as `basedOn`, provenance, or a recorded baseline does not create a live dependency or synchronization permission.

When propagation is explicitly requested, resolve its direction, exact source, exact targets, compatibility impact, migration needs, and validation before writing. Do not infer propagation from apparent reuse value or technical convenience.

## Card-customization purity

Card customization serves the user's requested behavior for that card. Do not write global-promotion labels, upstream suggestions, reusable-candidate markers, template-development notes, or unrelated maintenance commentary into any card prompt, Skill, workflow, data file, provenance, conversion report, maintenance record, or other card artifact.

Whether a card-specific change should become a root or global capability is solely the user's decision. An Agent may mention that possibility only in chat, not by default, and must state compatibility and migration risks such as changing future conversions or making uncustomized cards incompatible. It must not act without a separate explicit request.

## Play boundary

The `play/` environment keeps only gameplay Skills and card-owned runtime Skills. Gameplay may update authorized session records through the unified data service. Structural changes to cards, modules, workflows, schemas, frontends, templates, or development Skills are development work and must be started from the repository root.
