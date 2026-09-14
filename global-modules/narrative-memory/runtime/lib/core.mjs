import { createHash } from "node:crypto";

export const SUMMARY_LIMITS = Object.freeze({
  "memory.entity": 30,
  "memory.relationship": 30,
  "memory.event": 45,
  "memory.cognition": 40,
  "memory.knower-group": 25,
  "memory.event-summary": 50,
});

export const STANDARD_RETRIEVAL_BUDGET = Object.freeze({
  entityQueryLimit: 20,
  initialInspectLimit: 30,
  supplementalInspectLimit: 5,
  informationLimit: 20,
  elasticInformationLimit: 5,
  possiblePerQueryLimit: 2,
});

export const MAXIMUM_RETRIEVAL_BUDGET = Object.freeze({
  entityQueryLimit: 100,
  initialInspectLimit: 200,
  supplementalInspectLimit: 100,
  informationLimit: 200,
  elasticInformationLimit: 100,
  possiblePerQueryLimit: 20,
});

const INFORMATION_MODES = new Set(["common", "restricted", "undiscovered", "unclassified"]);
const COGNITION_MODES = new Set(["common", "restricted", "unclassified"]);

export function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === "string" && value.length))];
}

export function summaryOverLimit(recordType, summary) {
  const limit = SUMMARY_LIMITS[recordType];
  return Number.isInteger(limit) ? [...String(summary || "")].length > limit : false;
}

export function normalizeInformationControl(value, { cognition = false } = {}) {
  const allowed = cognition ? COGNITION_MODES : INFORMATION_MODES;
  const mode = allowed.has(value?.mode) ? value.mode : "unclassified";
  const knowerIds = uniqueStrings(value?.knowerIds);
  if (mode === "restricted" && !knowerIds.length) throw new Error("restricted information requires at least one knower ID.");
  if (mode !== "restricted" && knowerIds.length) throw new Error(`${mode} information cannot carry knower IDs.`);
  return { mode, knowerIds };
}

export function valueAtPath(value, pointer) {
  if (!pointer || pointer === "/") return value;
  return String(pointer).split("/").slice(1).reduce((current, raw) => current == null ? undefined : current[raw.replace(/~1/g, "/").replace(/~0/g, "~")], value);
}

function normalizeFacetValue(value, valueType) {
  if (value == null) return null;
  if (valueType === "string") return typeof value === "string" ? value.trim() : null;
  if (valueType === "string-or-list") {
    if (typeof value === "string") return value.trim();
    if (Array.isArray(value)) return uniqueStrings(value.map(item => String(item).trim()));
    return null;
  }
  return value;
}

export function deriveFacets(data, template) {
  const result = {};
  for (const facet of template?.filterFacets || []) {
    const normalized = normalizeFacetValue(valueAtPath(data, facet.path), facet.valueType);
    if (normalized !== null && normalized !== "" && (!Array.isArray(normalized) || normalized.length)) result[facet.facetId] = normalized;
  }
  return result;
}

export function normalizeRecordData(recordType, source, template = null) {
  const data = structuredClone(source || {});
  for (const key of ["aliases", "partyIds", "relationTags", "participantIds", "locationIds", "relatedEntityIds", "precedingEventIds", "relatedEventIds", "sourceEntryIds", "coveredEventIds", "precedingSummaryIds", "subjectRecordIds", "relatedRecordIds", "precedingCognitionIds", "includeIds", "excludeIds", "resolvedMemberIds"]) {
    if (key in data) data[key] = uniqueStrings(data[key]);
  }
  if (recordType === "memory.entity") data.derivedFacets = deriveFacets(data, template);
  if (data.overviewInformationControl) data.overviewInformationControl = normalizeInformationControl(data.overviewInformationControl);
  if (data.knowerScope) data.knowerScope = normalizeInformationControl(data.knowerScope, { cognition: true });
  if (Array.isArray(data.informationBlocks)) {
    data.informationBlocks = data.informationBlocks.map(block => ({
      title: String(block?.title || "未命名信息"),
      ...normalizeInformationControl(block),
      content: block?.content && typeof block.content === "object" && !Array.isArray(block.content) ? block.content : {},
    }));
  }
  if (Object.hasOwn(SUMMARY_LIMITS, recordType)) data.summaryOverLimit = summaryOverLimit(recordType, data.catalogSummary);
  return data;
}

export function normalizeRetrievalBudget(requested, defaults = STANDARD_RETRIEVAL_BUDGET, maximum = defaults) {
  const result = {};
  for (const key of Object.keys(STANDARD_RETRIEVAL_BUDGET)) {
    const floor = key === "supplementalInspectLimit" || key === "elasticInformationLimit" || key === "possiblePerQueryLimit" ? 0 : 1;
    const value = requested?.[key] ?? defaults[key];
    if (!Number.isSafeInteger(value) || value < floor) throw new Error(`Invalid retrieval budget: ${key}.`);
    if (!Number.isSafeInteger(maximum?.[key]) || value > maximum[key]) throw new Error(`Retrieval budget exceeds workflow grant: ${key}.`);
    result[key] = value;
  }
  return result;
}

function compareScalar(actual, operator, expected) {
  if (operator === "exists") return expected ? actual !== undefined && actual !== null : actual === undefined || actual === null;
  if (operator === "contains") return Array.isArray(actual) ? actual.includes(expected) : typeof actual === "string" ? actual.includes(String(expected)) : false;
  if (operator === "in") return Array.isArray(expected) && expected.includes(actual);
  if (operator === "notIn") return Array.isArray(expected) && !expected.includes(actual);
  if (operator === "eq") return actual === expected;
  if (operator === "neq") return actual !== expected;
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  if (operator === "lte") return actual <= expected;
  throw new Error(`Unsupported filter operator: ${operator}.`);
}

export function matchesFilter(record, filter) {
  if (!filter) return true;
  if (Array.isArray(filter.all)) return filter.all.every(item => matchesFilter(record, item));
  if (Array.isArray(filter.any)) return filter.any.some(item => matchesFilter(record, item));
  if (filter.not) return !matchesFilter(record, filter.not);
  if (typeof filter.field !== "string" || typeof filter.operator !== "string") throw new Error("A filter leaf requires field and operator.");
  const actual = filter.field === "name" ? record.name : filter.field === "entityKind" ? record.entityKind : filter.field === "templateId" ? record.templateId : record.derivedFacets?.[filter.field];
  return compareScalar(actual, filter.operator, filter.value);
}

function seededOrder(seed, id) {
  return createHash("sha256").update(`${seed}\u0000${id}`).digest("hex");
}

export function selectEntities(records, request, seedContext = {}) {
  const clauses = JSON.stringify(request?.filter || {}).match(/"operator"/g)?.length || 0;
  const maxClauses = Number.isSafeInteger(seedContext.maxFilterClauses) ? seedContext.maxFilterClauses : 20;
  if (clauses > maxClauses) throw new Error("Entity filter exceeds the granted clause count.");
  const eligible = (records || []).filter(record => record && matchesFilter(record, request?.filter));
  if (request?.mode === "count") return { mode: "count", count: new Set(eligible.map(item => item.id)).size };
  if (request?.mode !== "sample") throw new Error("Entity selection mode must be sample or count.");
  const count = request?.count;
  const maxResults = Number.isSafeInteger(seedContext.maxResults) ? seedContext.maxResults : 20;
  if (!Number.isSafeInteger(count) || count < 1 || count > maxResults) throw new Error("Entity sample count exceeds the granted range.");
  const seed = [seedContext.sessionId, seedContext.turn, seedContext.workflowId, request.selectionKey].map(value => String(value ?? "")).join("|");
  const selected = [...eligible].sort((left, right) => seededOrder(seed, left.id).localeCompare(seededOrder(seed, right.id))).slice(0, count);
  return {
    mode: "sample",
    requested: count,
    available: eligible.length,
    insufficientCandidates: eligible.length < count,
    items: selected.map(item => ({ id: item.id, name: item.name, entityKind: item.entityKind, templateId: item.templateId, templateVersion: item.templateVersion })),
  };
}

export function resolveGroupMembers(groups, { refreshFixedIds = [] } = {}) {
  const byId = new Map((groups || []).map(group => [group.id, group]));
  const cache = new Map();
  const refresh = new Set(refreshFixedIds);
  const resolveOne = (id, path = []) => {
    if (cache.has(id)) return cache.get(id);
    if (path.includes(id)) throw new Error(`Knower-group cycle: ${[...path, id].join(" -> ")}`);
    const group = byId.get(id);
    if (!group) return new Set([id]);
    if (group.membershipMode === "fixed" && !refresh.has(id) && Array.isArray(group.resolvedMemberIds)) {
      const frozen = new Set(uniqueStrings(group.resolvedMemberIds));
      cache.set(id, frozen);
      return frozen;
    }
    const included = new Set();
    for (const memberId of uniqueStrings(group.includeIds)) for (const leaf of resolveOne(memberId, [...path, id])) included.add(leaf);
    const excluded = new Set();
    for (const memberId of uniqueStrings(group.excludeIds)) for (const leaf of resolveOne(memberId, [...path, id])) excluded.add(leaf);
    for (const leaf of excluded) included.delete(leaf);
    cache.set(id, included);
    return included;
  };
  return new Map([...byId].map(([id]) => [id, [...resolveOne(id)].sort()]));
}

function eventSortData(entry) {
  const data = entry.data || {};
  if (entry.recordType === "memory.event-summary") return { start: data.timeRange?.startSortValue || "", end: data.timeRange?.endSortValue || "" };
  return { start: data.time?.sortValue || "", end: data.time?.sortValue || "" };
}

export function effectiveEventEntries(entries) {
  const active = (entries || []).filter(entry => entry?.status !== "retracted" && entry?.status !== "archived");
  const summaries = active.filter(entry => entry.recordType === "memory.event-summary");
  const superseded = new Set(summaries.flatMap(entry => [...(entry.data?.precedingSummaryIds || []), ...(entry.data?.sourceEntryIds || []).filter(id => summaries.some(item => item.id === id))]));
  const effectiveSummaries = summaries.filter(entry => !superseded.has(entry.id));
  const covered = new Set(effectiveSummaries.flatMap(entry => entry.data?.coveredEventIds || []));
  const originals = active.filter(entry => entry.recordType === "memory.event" && !covered.has(entry.id));
  return [...originals, ...effectiveSummaries].sort((left, right) => eventSortData(left).start.localeCompare(eventSortData(right).start) || (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id));
}

function commonSummaryControl(controls) {
  if (controls.every(item => item?.mode === "common")) return { mode: "common", knowerIds: [] };
  if (controls.every(item => item?.mode === "undiscovered")) return { mode: "undiscovered", knowerIds: [] };
  const restricted = controls.every(item => item?.mode === "restricted");
  if (restricted) {
    const intersection = controls.map(item => new Set(item.knowerIds || [])).reduce((left, right) => new Set([...left].filter(id => right.has(id))));
    if (intersection.size) return { mode: "restricted", knowerIds: [...intersection].sort() };
  }
  return { mode: "unclassified", knowerIds: [] };
}

export function deriveEventSummaryData(group, entriesById, timeRuleVersion) {
  const sources = uniqueStrings(group?.sourceEntryIds).map(id => entriesById.get(id));
  if (sources.length < 2 || sources.some(item => !item)) throw new Error("A compression group requires at least two effective source entries.");
  if (sources.some(item => item.recordType === "memory.event" && item.data?.status !== "completed")) throw new Error("Ongoing events cannot be compressed.");
  const coveredEventIds = uniqueStrings(sources.flatMap(item => item.recordType === "memory.event-summary" ? item.data.coveredEventIds : [item.id]));
  const precedingSummaryIds = sources.filter(item => item.recordType === "memory.event-summary").map(item => item.id);
  const ordered = [...sources].sort((left, right) => eventSortData(left).start.localeCompare(eventSortData(right).start));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const firstData = first.data;
  const lastData = last.data;
  const firstTime = first.recordType === "memory.event-summary" ? firstData.timeRange : { displayStart: firstData.time.displayStart, startTrueTime: firstData.time.trueTime, startSortValue: firstData.time.sortValue };
  const lastTime = last.recordType === "memory.event-summary" ? lastData.timeRange : { displayEnd: lastData.time.displayEnd, displayStart: lastData.time.displayStart, endTrueTime: lastData.time.trueTime, endSortValue: lastData.time.sortValue };
  const data = {
    name: String(group.name || "事件摘要"),
    catalogSummary: String(group.catalogSummary || ""),
    templateMode: "default",
    templateId: "event-summary.default",
    templateVersion: 1,
    sourceEntryIds: uniqueStrings(group.sourceEntryIds),
    coveredEventIds,
    precedingSummaryIds,
    timeRange: {
      displayStart: firstTime.displayStart,
      displayEnd: lastTime.displayEnd || lastTime.displayStart || null,
      startTrueTime: firstTime.startTrueTime,
      endTrueTime: lastTime.endTrueTime,
      startSortValue: firstTime.startSortValue,
      endSortValue: lastTime.endSortValue,
      timeRuleVersion,
    },
    locationIds: uniqueStrings(sources.flatMap(item => item.data?.locationIds || [])),
    overviewInformationControl: commonSummaryControl(sources.map(item => item.data?.overviewInformationControl)),
    sections: group.sections && typeof group.sections === "object" ? group.sections : {},
  };
  return normalizeRecordData("memory.event-summary", data);
}

function scalar(value) {
  if (value === null) return "null";
  if (typeof value === "string") return /[:#\n\[\]{},]|^\s|\s$/.test(value) ? JSON.stringify(value) : value;
  return String(value);
}

export function yamlLines(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    return value.flatMap(item => {
      if (item && typeof item === "object") {
        const lines = yamlLines(item, indent + 2);
        return [`${pad}- ${lines[0].trimStart()}`, ...lines.slice(1)];
      }
      return [`${pad}- ${scalar(item)}`];
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, item]) => item && typeof item === "object"
      ? [`${pad}${key}:`, ...yamlLines(item, indent + 2)]
      : [`${pad}${key}: ${scalar(item)}`]);
  }
  return [`${pad}${scalar(value)}`];
}

function knows(control, perspectiveId, groupMembers) {
  if (!perspectiveId) return true;
  if (control?.mode === "common") return true;
  if (control?.mode === "undiscovered") return false;
  if (control?.mode === "unclassified") return true;
  return (control?.knowerIds || []).some(id => id === perspectiveId || groupMembers.get(id)?.includes(perspectiveId));
}

function visibleData(entry, perspectiveId, groupMembers) {
  const data = structuredClone(entry.data || {});
  const control = data.knowerScope || data.overviewInformationControl;
  if (control && !knows(control, perspectiveId, groupMembers)) return null;
  if (Array.isArray(data.informationBlocks)) data.informationBlocks = data.informationBlocks.filter(block => knows(block, perspectiveId, groupMembers));
  delete data.derivedFacets;
  delete data.summaryOverLimit;
  return data;
}

function displayName(id, entriesById, catalogNames) {
  return entriesById.get(id)?.data?.name || catalogNames.get(id) || id;
}

function informationScopeLabel(control, entriesById, catalogNames) {
  if (control?.mode === "common") return "公开信息";
  if (control?.mode === "undiscovered") return "尚无角色知情的信息";
  if (control?.mode === "unclassified") return "知情范围尚未确认";
  if (control?.mode !== "restricted") return "知情范围尚未确认";
  const labels = (control.knowerIds || []).map(id => {
    const entry = entriesById.get(id);
    const name = displayName(id, entriesById, catalogNames);
    if (entry?.recordType !== "memory.knower-group") return `${name}知情`;
    const excluded = (entry.data?.excludeIds || []).map(excludedId => displayName(excludedId, entriesById, catalogNames));
    return excluded.length ? `${name}知情（${excluded.join("、")}除外）` : `${name}知情`;
  });
  return labels.length ? labels.join("；") : "知情范围尚未确认";
}

function recordLines(data, entriesById, catalogNames, blockHeadingLevel) {
  const body = structuredClone(data);
  const blocks = Array.isArray(body.informationBlocks) ? body.informationBlocks : [];
  const sections = body.sections && typeof body.sections === "object" && !Array.isArray(body.sections) ? body.sections : {};
  delete body.informationBlocks;
  delete body.sections;
  delete body.templateMode;
  delete body.templateId;
  delete body.templateVersion;
  delete body.resolvedMemberIds;
  if (body.time) {
    body.time = { displayStart: body.time.displayStart, displayEnd: body.time.displayEnd };
  }
  if (body.timeRange) {
    body.timeRange = { displayStart: body.timeRange.displayStart, displayEnd: body.timeRange.displayEnd };
  }
  if (body.overviewInformationControl) {
    body["概况知情范围"] = informationScopeLabel(body.overviewInformationControl, entriesById, catalogNames);
    delete body.overviewInformationControl;
  }
  if (body.knowerScope) {
    body["知情范围"] = informationScopeLabel(body.knowerScope, entriesById, catalogNames);
    delete body.knowerScope;
  }
  const lines = yamlLines({ ...body, ...sections });
  for (const block of blocks) {
    lines.push("", `${"#".repeat(blockHeadingLevel)} ${informationScopeLabel(block, entriesById, catalogNames)}`);
    if (block.title) lines.push("", `信息块: ${scalar(block.title)}`);
    lines.push(...yamlLines(block.content || {}));
  }
  return lines;
}

export function composeMemoryDocument({ title = "叙事记忆检索资料", queryResults = [], entriesById, eventTimeline = null, perspectiveId = null, groupMembers = new Map(), catalogNames = new Map() }) {
  const out = [`# ${title}`];
  for (const query of queryResults) {
    out.push("", `## 关于${query.query}`);
    const matches = (query.matches || []).map(match => ({ ...match, entry: entriesById.get(match.recordId) })).filter(item => item.entry);
    const visible = matches.map(item => ({ ...item, data: visibleData(item.entry, perspectiveId, groupMembers) })).filter(item => item.data);
    if (!visible.length) {
      out.push("", "未发现相关记录");
      continue;
    }
    const groups = query.kind === "entity"
      ? [["", visible.filter(item => ["direct", "related"].includes(item.status))], ["可能有关的记录", visible.filter(item => item.status === "possible")]]
      : [["", visible.filter(item => item.status === "confirmed")], ["相关记录", visible.filter(item => item.status === "suggested")], ["可能有关的记录", visible.filter(item => item.status === "possible")]];
    for (const [heading, items] of groups) {
      if (!items.length) continue;
      if (heading) out.push("", `### ${heading}`);
      const itemHeading = heading ? "####" : "###";
      const blockHeadingLevel = heading ? 5 : 4;
      for (const item of items) out.push("", `${itemHeading} ${item.data.name || item.data.claim || item.entry.id}`, "", ...recordLines(item.data, entriesById, catalogNames, blockHeadingLevel));
    }
  }
  if (Array.isArray(eventTimeline)) {
    out.push("", "# 有效事件时间线");
    for (const entry of eventTimeline) {
      const data = visibleData(entry, perspectiveId, groupMembers);
      if (!data) continue;
      const time = entry.recordType === "memory.event-summary" ? `${data.timeRange?.displayStart || ""}${data.timeRange?.displayEnd ? `—${data.timeRange.displayEnd}` : ""}` : `${data.time?.displayStart || ""}${data.time?.displayEnd ? `—${data.time.displayEnd}` : ""}`;
      out.push(`- ${time || "时间未标明"}｜${data.name}｜${data.catalogSummary || ""}｜地点:${(data.locationIds || []).join(",") || "未标明"}｜${entry.recordType === "memory.event-summary" ? `摘要覆盖${data.coveredEventIds?.length || 0}条` : data.status}`);
    }
  }
  return out.join("\n");
}
