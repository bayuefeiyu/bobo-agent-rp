export const STORY_METADATA_FIELDS = ["module", "summary", "timeRange", "locations", "characters", "importantEntities"];

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export function validateStoryMetadata(value, expectedModule, label = "story metadata") {
  const metadata = object(value, label);
  const expected = [...STORY_METADATA_FIELDS].sort();
  const keys = Object.keys(metadata).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error(`${label} must use the exact minimal field set.`);
  if (metadata.module !== expectedModule || typeof metadata.summary !== "string" || !metadata.summary.trim() || metadata.summary.length > 500) throw new Error(`${label} module or summary is invalid.`);
  if (!metadata.timeRange || Object.keys(metadata.timeRange).sort().join(",") !== "end,start" || typeof metadata.timeRange.start !== "string" || !metadata.timeRange.start.trim() || typeof metadata.timeRange.end !== "string" || !metadata.timeRange.end.trim()) throw new Error(`${label} timeRange is invalid.`);
  if (!Array.isArray(metadata.locations) || !metadata.locations.length || !Array.isArray(metadata.characters) || !Array.isArray(metadata.importantEntities)) throw new Error(`${label} entity lists are invalid.`);
  for (const values of [metadata.locations, metadata.characters]) if (values.some(item => typeof item !== "string" || !item.trim()) || new Set(values).size !== values.length) throw new Error(`${label} entity labels must be unique non-empty text.`);
  if (metadata.importantEntities.some(item => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== "name,unique" || typeof item.name !== "string" || !item.name.trim() || typeof item.unique !== "boolean")) throw new Error(`${label} importantEntities are invalid.`);
  return metadata;
}

export async function submitCommitted(data, batch, options) {
  const receipt = await data.submit(batch, options);
  if (receipt?.status !== "committed") throw new Error(receipt?.error?.message || receipt?.error || `Story data batch ${batch.batchId} completed with status ${receipt?.status || "unknown"}.`);
  return receipt;
}

export const STORY_RECORD_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["storyId", "seriesId", "sequence", "sourceTurn", "timeRange", "locations", "characters", "importantEntities", "summary", "content", "originStoryId", "candidateId", "approval"],
  properties: {
    storyId: { type: "string", minLength: 1 },
    seriesId: { type: "string", minLength: 1 },
    sequence: { type: "integer", minimum: 1 },
    sourceTurn: { type: "integer", minimum: 0 },
    timeRange: { type: "object", additionalProperties: false, required: ["start", "end"], properties: { start: { type: "string", minLength: 1 }, end: { type: "string", minLength: 1 } } },
    locations: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, uniqueItems: true },
    characters: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
    importantEntities: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "unique"], properties: { name: { type: "string", minLength: 1 }, unique: { type: "boolean" } } } },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    content: { type: "string", minLength: 1 },
    originStoryId: { type: ["string", "null"] },
    candidateId: { type: "string", minLength: 1 },
    approval: { type: "object", additionalProperties: false, required: ["authority", "runId", "decision"], properties: { authority: { type: "string", minLength: 1 }, runId: { type: "string", minLength: 1 }, decision: { enum: ["accept-original", "replace"] } } },
  },
};
