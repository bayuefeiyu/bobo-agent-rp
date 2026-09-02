# Conversion validation

Validation protects structural usability, data ownership, workflow safety, and source fidelity. Passing the script is necessary but not sufficient.

## Structural validation

Run:

```bash
python .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py play/cards/<card-id>
```

The validator checks the manifest, safe paths, openings, provenance, context processors, module v4 definitions, data-contract v1 collections, record envelope v2 initial data, indexes, views, capabilities, workflow v2 nodes/outputs/access/commits, frontend declarations, and referenced files.

## Coverage and fidelity

Every non-empty source unit has one explicit disposition: mapped, metadata-only, unsupported, unresolved, or an identified duplicate. Review every non-verbatim transform:

- `format-only` keeps wording and meaning;
- split/merged passages retain their original relationships and uncertainty;
- every summary anchor is supported and points to retained detail;
- bridges add no canon and are removed when headings suffice;
- generated runtime text describes behavior, not invented story facts.

Preserve unusual diction, pacing, motifs, biased narration, deliberate contradictions, and information boundaries. Do not promote a character belief to objective truth or leak opening-specific state.

## Unified-data audit

Apply the data-design Skill's complete [validation contract](../../design-pi-rp-data/references/validation.md) to every module. In conversion, additionally verify that every source variable, memory, secret, rumor, auxiliary output, and other persistent feature maps to the common protocol without inventing a separate storage, draft, catalog, or publication mechanism.

## Workflow audit

Validate the DAG, conditions, joins, retries, triggers, instance policy, blocking behavior, and exactly one foreground narrative. For each node, verify:

- its prompt assumptions match declared context and upstream logical outputs;
- module access names exact collections, capabilities, views, and budgets;
- change files are declared outputs with format `unified-change-batch`;
- `dataCommit.onNodeEnd` names exact outputs/paths and runs before downstream nodes;
- concurrent nodes do not write the same authoritative collection incompatibly;
- scoped artifacts and retention match every later consumer;
- process records remain user-only.

Across workflows, build a trigger and ownership map. Detect cycles, duplicate starts, unstable dedupe keys, incompatible concurrent writes, and conflicting assumptions about record status or schema.

## Runtime audit

Simulate the default and one alternate opening, ordinary narration, on-demand lore, and information-boundary temptations. For each module/type, test a relevant and irrelevant turn plus:

- indexed query, content query where declared, pagination/truncation, `rp` view, and custom view;
- denied view/capability and a conservative-budget boundary;
- create/update/revise/archive/restore as declared;
- explicit submit and node-end fallback without duplicate commit;
- atomic/grouped behavior, idempotent replay, revision conflict, and failure receipt;
- frontend rendering based on customized code, background invisibility, and display ordering;
- message-suffix pruning for bound data;
- initial data and opening-specific initialization where authored.

For context processors, test each branch boundary, declared input isolation, known-fragment enforcement, and failure policy. Judge preservation of facts, voice, motivation, knowledge, and output separation rather than exact generated wording.

## Severity

- `error`: lost source content, invented canon, unsafe/missing target, invalid contract, unauthorized disclosure/write, conflicting ownership, auxiliary output left in chat prose, or unsupported executable behavior claimed as converted.
- `warning`: ambiguity, preserved contradiction, unknown macro, external dependency, unusually large context/query budget, or a generated anchor needing review.
- `note`: intentional metadata exclusion, exact duplicate, or optional refinement.

Do not claim completion while an error remains. List accepted warnings in `conversion-report.md`.
