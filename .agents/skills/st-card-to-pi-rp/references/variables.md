# Variable conversion

Read the data-design Skill's [variable-state pattern](../../design-pi-rp-data/references/patterns/variables.md) and the references it routes to. This file contains only conversion-specific requirements.

Preserve the source card's variable names, hierarchy, defaults, opening differences, types, ranges, enumerations, dynamic keys, derived fields, update conditions, relationships, information boundaries, display intent, and prompt references. Do not retain MVU transport, EJS execution, patch-output blocks, event buses, regex parsing, a variable-specific storage engine, or a special update node type.

Map every source read, write, derived value, constraint, and presentation rule to the owning module design. Opening-specific defaults initialize only the selected opening. Archive unsupported executable source unchanged and report it without claiming conversion.
