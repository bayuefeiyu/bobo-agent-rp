# Card-Pack Semantic Audit

Read this reference only for the card-pack semantics stage.

## Evidence to inspect

Read the manifest, provenance, conversion report, unresolved material, fixed context, primary-character files, knowledge map, on-demand documents, rules, context policy/processors, openings, feature-module definitions and module skills. Use the current converter references for [semantic placement](../../st-card-to-pi-rp/references/semantic-conversion.md), [target structure](../../st-card-to-pi-rp/references/target-card-pack.md), [modules](../../st-card-to-pi-rp/references/feature-modules.md), [variables](../../st-card-to-pi-rp/references/variables.md), [EJS conversion](../../st-card-to-pi-rp/references/ejs-conversion.md), and [validation](../../st-card-to-pi-rp/references/validation.md), plus the data-design Skill's [modeling](../../design-pi-rp-data/references/modeling.md) and [retrieval](../../design-pi-rp-data/references/retrieval-and-views.md) contracts; do not rerun conversion or reinterpret ST activation metadata as Pi behavior.

Session transcripts are out of scope unless the user explicitly requested diagnosis from a named session. A prompt can be defective without a bad generated example, and one bad generated example does not by itself prove a prompt bug.

## Checks

- Missing, stale, unsafe, or ambiguous file/module/Agent/workflow references.
- Contradictory or duplicated instructions across fixed rules, character files, context skills, module skills, processors, Agent profiles, and workflow node prompts.
- A prompt that assumes state, records, paths, tools, or upstream output the owning runtime stage cannot provide.
- Foundational facts absent from fixed context, dead on-demand documents, or detailed lore duplicated into fixed context without need.
- Character beliefs promoted to world truth, secrets leaked across information boundaries, or instructions that decide the player's actions, feelings, or consent.
- Source-authored auxiliary output left in main prose, or a module prompt duplicated into main narrative rules.
- Variable/module schemas, field meanings, bindings, update rules, views, and prompt references that disagree.
- Opening-specific state leaking into other openings or universal canon.
- Macros, placeholders, IDs, selectors, and output formats that cannot resolve.

Classify each finding as confirmed bug, compatibility risk, fidelity uncertainty, or optional improvement. Attach exact file/section evidence and state the runtime consequence. Do not treat stylistic preference as a bug.

## Discussion result

Recommend only changes that resolve evidenced defects or confirmed upgrade needs. Group coupled edits so the user can accept or skip a coherent treatment rather than decide file by file.
