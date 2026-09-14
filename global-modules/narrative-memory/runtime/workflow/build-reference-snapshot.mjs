import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { effectiveEventEntries, yamlLines } from "../lib/core.mjs";
import { queryAll } from "../lib/data-helpers.mjs";
import { catalogEntry, execute as prepareCatalog } from "./prepare-catalog.mjs";

const COLLECTIONS = ["entities", "relationships", "events", "cognitions", "knower-groups"];
const RECORD_TYPE_COLLECTION = {
  "memory.entity": "entities",
  "memory.relationship": "relationships",
  "memory.event": "events",
  "memory.event-summary": "events",
  "memory.cognition": "cognitions",
  "memory.knower-group": "knower-groups",
};
const FILTER_FIELDS = new Set([
  "id", "recordType", "name", "aliases", "catalogSummary", "entityKind", "templateId", "status", "partyIds", "sortValue", "time", "timeRange",
  "locationIds", "coveredEventIds", "sourceEntryIds", "precedingSummaryIds", "subjectRecordIds",
  "propagationStage", "membershipMode", "membershipDefinition",
]);
const FILTER_OPERATORS = new Set(["eq", "neq", "contains", "in", "gte", "lte"]);

function stringList(value, label) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new Error(`${label} must be an array of non-empty strings.`);
  return [...new Set(value)];
}

function compare(actual, operator, expected) {
  if (operator === "eq") return actual === expected;
  if (operator === "neq") return actual !== expected;
  if (operator === "contains") return Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" ? actual.includes(String(expected)) : false;
  if (operator === "in") return Array.isArray(expected) && expected.includes(actual);
  if (operator === "gte") return actual >= expected;
  if (operator === "lte") return actual <= expected;
  return false;
}

function normalizeFilters(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((filter, index) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error(`${label}[${index}] must be an object.`);
    if (!FILTER_FIELDS.has(filter.field) || !FILTER_OPERATORS.has(filter.operator)) throw new Error(`${label}[${index}] uses an unsupported field or operator.`);
    return { field: filter.field, operator: filter.operator, value: structuredClone(filter.value) };
  });
}

function filterEntry(entry, filters) {
  return filters.every(filter => {
    const actual = filter.field === "id" || filter.field === "recordType"
      ? entry[filter.field]
      : filter.field === "sortValue"
        ? entry.data?.time?.sortValue || entry.data?.timeRange?.startSortValue
        : entry.data?.[filter.field];
    return compare(actual, filter.operator, filter.value);
  });
}

function definedEntries(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

async function relatedEntries(data, entityIds) {
  const result = Object.fromEntries(COLLECTIONS.map(id => [id, new Map()]));
  for (const id of entityIds) {
    const entity = await data.get({ moduleId: "narrative-memory", collectionId: "entities", id, view: "catalog" });
    if (entity) result.entities.set(entity.id, catalogEntry(entity));
    for (const [collectionId, selectors] of Object.entries({
      relationships: [{ index: "partyIds", recordTypes: ["memory.relationship"] }],
      events: [
        { index: "participantIds", recordTypes: ["memory.event"] },
        { index: "locationIds", recordTypes: ["memory.event", "memory.event-summary"] },
        { index: "relatedEntityIds", recordTypes: ["memory.event"] },
      ],
      cognitions: [
        { index: "subjectRecordIds", recordTypes: ["memory.cognition"] },
        { index: "relatedRecordIds", recordTypes: ["memory.cognition"] },
        { index: "knowerIds", recordTypes: ["memory.cognition"] },
      ],
      "knower-groups": [
        { index: "includeIds", recordTypes: ["memory.knower-group"] },
        { index: "excludeIds", recordTypes: ["memory.knower-group"] },
        { index: "resolvedMemberIds", recordTypes: ["memory.knower-group"] },
      ],
    })) {
      for (const selector of selectors) {
        const items = await queryAll(data, { moduleId: "narrative-memory", collectionId, recordTypes: selector.recordTypes, where: { [selector.index]: { contains: id } }, view: "catalog" });
        for (const item of items) result[collectionId].set(item.id, catalogEntry(item));
      }
    }
  }
  return Object.fromEntries(Object.entries(result).map(([id, entries]) => [id, [...entries.values()]]));
}

async function exactEntries(data, collections, recordIds, recordTypes) {
  const result = Object.fromEntries(collections.map(id => [id, []]));
  const narrowed = recordTypes?.length ? new Set(recordTypes.map(type => RECORD_TYPE_COLLECTION[type]).filter(Boolean)) : null;
  for (const collectionId of collections) {
    if (narrowed && !narrowed.has(collectionId)) continue;
    for (const id of recordIds) {
      const item = await data.get({ moduleId: "narrative-memory", collectionId, id, view: "catalog" });
      if (item) result[collectionId].push(catalogEntry(item));
    }
  }
  return result;
}

async function entryOnlyEntities(data, entityIds) {
  const entries = [];
  for (const id of entityIds) {
    const item = await data.get({ moduleId: "narrative-memory", collectionId: "entities", id, view: "catalog" });
    if (item) entries.push(catalogEntry(item));
  }
  return { entities: entries };
}

async function selectCatalog(data, fullDirectory, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("catalog must be an object when provided.");
  const collections = stringList(request.collections, "catalog.collections") || COLLECTIONS;
  if (collections.some(id => !COLLECTIONS.includes(id))) throw new Error("catalog.collections contains an unsupported collection.");
  const recordIds = stringList(request.recordIds, "catalog.recordIds");
  const recordTypes = stringList(request.recordTypes, "catalog.recordTypes");
  const entityIds = stringList(request.entityIds, "catalog.entityIds");
  const filters = normalizeFilters(request.filters, "catalog.filters");
  const entityMode = request.entityMode || "entry-only";
  if (!new Set(["entry-only", "related-records"]).has(entityMode)) throw new Error("catalog.entityMode must be entry-only or related-records.");
  let source = fullDirectory;
  if (entityIds?.length && entityMode === "entry-only") source = { entities: (fullDirectory.entities || []).filter(entry => entityIds.includes(entry.id)) };
  const selected = {};
  for (const collectionId of collections) {
    const entries = Array.isArray(source[collectionId]) ? source[collectionId] : [];
    selected[collectionId] = entries.filter(entry => (!recordIds || recordIds.includes(entry.id)) && (!recordTypes || recordTypes.includes(entry.recordType)) && filterEntry(entry, filters));
  }
  return selected;
}

function selectTimeline(fullDirectory, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("timeline must be an object when provided.");
  if (request.mode !== undefined && request.mode !== "effective") throw new Error("timeline.mode currently supports only effective.");
  const recordIds = stringList(request.recordIds, "timeline.recordIds");
  const filters = normalizeFilters(request.filters, "timeline.filters");
  return effectiveEventEntries(fullDirectory.events).filter(entry => (!recordIds || recordIds.includes(entry.id)) && filterEntry(entry, filters));
}

function catalogMarkdown(catalog) {
  const out = ["# 叙事记忆目录快照", "", "本文件仅列出确定性目录项，不包含检索结论。"];
  for (const [collectionId, entries] of Object.entries(catalog)) {
    out.push("", `## ${collectionId}`);
    if (!entries.length) out.push("", "无匹配目录项");
    for (const entry of entries) out.push("", `### ${entry.data?.name || entry.id}`, "", ...yamlLines(definedEntries({ id: entry.id, recordType: entry.recordType, revision: entry.revision, ...entry.data })));
  }
  return `${out.join("\n")}\n`;
}

export function timelineMarkdown(timeline) {
  const out = ["# 有效事件时间线快照", "", "事件摘要替代其覆盖的叶事件；本文件只包含当前有效投影。"];
  if (!timeline.length) out.push("", "无匹配事件");
  for (const entry of timeline) {
    const data = entry.data || {};
    const start = entry.recordType === "memory.event-summary" ? data.timeRange?.displayStart : data.time?.displayStart;
    const end = entry.recordType === "memory.event-summary" ? data.timeRange?.displayEnd : data.time?.displayEnd;
    out.push("", `## ${data.name || entry.id}`, "", ...yamlLines(definedEntries({
      id: entry.id,
      recordType: entry.recordType,
      revision: entry.revision,
      time: `${start || "时间未标明"}${end ? `—${end}` : ""}`,
      sortValue: entry.recordType === "memory.event-summary" ? data.timeRange?.startSortValue : data.time?.sortValue,
      status: entry.recordType === "memory.event-summary" ? "summary" : data.status,
      locations: data.locationIds || [],
      catalogSummary: data.catalogSummary || "",
      coveredEventCount: entry.recordType === "memory.event-summary" ? data.coveredEventIds?.length || 0 : 1,
    })));
  }
  return `${out.join("\n")}\n`;
}

export async function execute({ run, data, workspace }) {
  const catalogRequest = run.arguments?.catalog;
  const timelineRequest = run.arguments?.timeline;
  if (catalogRequest === undefined && timelineRequest === undefined) throw new Error("Reference snapshot requires catalog, timeline, or both.");
  let directory = {};
  const catalogEntityIds = catalogRequest === undefined ? null : stringList(catalogRequest?.entityIds, "catalog.entityIds");
  const catalogRecordIds = catalogRequest === undefined ? null : stringList(catalogRequest?.recordIds, "catalog.recordIds");
  const catalogRecordTypes = catalogRequest === undefined ? null : stringList(catalogRequest?.recordTypes, "catalog.recordTypes");
  const catalogCollections = catalogRequest === undefined ? [] : stringList(catalogRequest?.collections, "catalog.collections") || COLLECTIONS;
  if (catalogCollections.some(id => !COLLECTIONS.includes(id))) throw new Error("catalog.collections contains an unsupported collection.");
  if (catalogEntityIds?.length) {
    directory = catalogRequest.entityMode === "related-records"
      ? await relatedEntries(data, catalogEntityIds)
      : await entryOnlyEntities(data, catalogEntityIds);
  } else if (catalogRecordIds?.length) {
    directory = await exactEntries(data, catalogCollections, catalogRecordIds, catalogRecordTypes);
  }
  const mustPrepareCatalog = catalogRequest !== undefined && !catalogEntityIds?.length && !catalogRecordIds?.length;
  const mustPrepareTimeline = timelineRequest !== undefined;
  let timelineDirectory = directory;
  if (mustPrepareCatalog || mustPrepareTimeline) {
    const collections = new Set(mustPrepareCatalog ? catalogCollections : []);
    if (mustPrepareTimeline) collections.add("events");
    const prepared = await prepareCatalog({ data, collections: [...collections] });
    if (mustPrepareCatalog) directory = prepared.directory;
    timelineDirectory = prepared.directory;
  }
  const catalog = catalogRequest === undefined ? null : await selectCatalog(data, directory, catalogRequest);
  const timeline = timelineRequest === undefined ? null : selectTimeline(timelineDirectory, timelineRequest);
  const target = resolve(workspace, "reference-snapshot");
  await mkdir(target, { recursive: true });
  const documents = [];
  if (catalog) {
    await writeFile(resolve(target, "catalog.md"), catalogMarkdown(catalog), "utf8");
    documents.push({ id: "catalog", path: "catalog.md", title: "记忆目录快照", description: "按调用参数筛选的实体、关系、事件、认知和知情群体目录。" });
  }
  if (timeline) {
    await writeFile(resolve(target, "timeline.md"), timelineMarkdown(timeline), "utf8");
    documents.push({ id: "timeline", path: "timeline.md", title: "有效事件时间线", description: "摘要替代覆盖叶事件后的有效事件投影。" });
  }
  await writeFile(resolve(target, "DOCUMENTS.md"), `${[
    "# 叙事记忆参考快照",
    "",
    "以下文档由对外快照工作流根据本次参数确定性生成。",
    ...documents.flatMap(document => ["", `## ${document.title}`, "", `- id: \`${document.id}\``, `- path: \`${document.path}\``, `- description: ${document.description}`]),
    "",
  ].join("\n")}\n`, "utf8");
  return { schemaVersion: 1, documents: documents.map(document => document.id), catalogEntries: catalog ? Object.values(catalog).flat().length : 0, timelineEntries: timeline?.length || 0 };
}
