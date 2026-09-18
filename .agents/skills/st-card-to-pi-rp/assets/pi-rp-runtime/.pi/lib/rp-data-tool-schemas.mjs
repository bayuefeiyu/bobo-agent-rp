/**
 * Provider-facing parameter schemas for the RP data tools.
 *
 * Function-calling providers require the **root** parameter schema to be a JSON Schema object.
 * `Type.Any()` compiles to `{}` (typebox 1.x), so a `rp_data_query` root built from it reaches
 * models as `type: null` and the request is rejected before the Agent ever runs — which is what
 * happened in RC-02. These descriptors mirror `rp-data-query.mjs` exactly, so the model sees the
 * real mechanical interface instead of an empty object.
 *
 * The runtime's own validation is unchanged and remains authoritative: capabilities, granted
 * views, index operators, record types, budgets, cursors and commit policy are all still enforced
 * by `queryData`/`getDataRecord`. A wider model schema never grants access.
 */

/** Index/content query request accepted by `queryData` (`rp-data-query.mjs`). */
export const DATA_QUERY_PARAMETERS = {
  moduleId: { type: "string", minLength: 1, description: "Owning feature module, exactly as listed in this node's moduleAccess." },
  collectionId: { type: "string", minLength: 1, description: "Collection inside that module." },
  recordTypes: { type: "array", items: { type: "string" }, description: "Optional record-type filter. Every listed type must exist in the collection." },
  where: {
    type: "object",
    description: "Index conditions keyed by declared index id. Each value must carry exactly one operator object, for example {\"sourceTurn\":{\"gte\":4}}. Multiple indexes are ANDed; one index cannot carry two operators.",
    additionalProperties: { type: "object", minProperties: 1, maxProperties: 1 },
  },
  search: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    description: "Optional content search over the record type's declared searchable fields.",
    properties: {
      query: { type: "string", minLength: 1 },
      fields: { type: "array", items: { type: "string" }, description: "Subset of the declared searchable paths. Omit to search every searchable field." },
    },
  },
  sort: {
    type: "array",
    description: "Optional ordering. Only `turn`, `sequence`, and declared index ids are accepted.",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["field"],
      properties: {
        field: { type: "string", minLength: 1 },
        order: { type: "string", enum: ["asc", "desc"] },
      },
    },
  },
  view: { type: "string", minLength: 1, description: "Named return view. It must be granted to this node's capability." },
  limit: { type: "integer", minimum: 1, description: "Requested page size; the effective value is the smaller of this, the node budget, and the runtime budget." },
  maxCharacters: { type: "integer", minimum: 1, description: "Requested character ceiling; also capped by the node and runtime budgets." },
  cursor: { type: ["string", "null"], description: "Pagination cursor returned as nextCursor by the previous page." },
  includeInactive: { type: "boolean", description: "Include inactive records. Defaults to active records only." },
};

/** Exact-record read request accepted by `getDataRecord` (`rp-data-query.mjs`). */
export const DATA_GET_PARAMETERS = {
  moduleId: { type: "string", minLength: 1, description: "Owning feature module, exactly as listed in this node's moduleAccess." },
  collectionId: { type: "string", minLength: 1, description: "Collection inside that module." },
  id: { type: "string", minLength: 1, description: "Stable record id." },
  view: { type: "string", minLength: 1, description: "Named return view. It must be granted to this node's capability." },
  includeInactive: { type: "boolean", description: "Allow reading an inactive record. Defaults to active records only." },
};

export const DATA_QUERY_REQUIRED = ["moduleId", "collectionId"];
export const DATA_GET_REQUIRED = ["moduleId", "collectionId", "id"];
