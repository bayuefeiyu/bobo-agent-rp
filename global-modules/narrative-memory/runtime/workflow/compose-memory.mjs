import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { composeMemoryDocument, resolveGroupMembers } from "../lib/core.mjs";
import { collectionFor, getById, queryAll, unwrap } from "../lib/data-helpers.mjs";

const ENTITY_STATUSES = new Set(["direct", "related", "possible"]);
const INFORMATION_STATUSES = new Set(["confirmed", "suggested", "possible", "not-found"]);
const RECORD_TYPES = new Set(["memory.entity", "memory.relationship", "memory.event", "memory.event-summary", "memory.cognition", "memory.knower-group"]);
const INFORMATION_RECORD_TYPES = new Set(["memory.event", "memory.event-summary", "memory.cognition"]);

/**
 * The statuses a match may carry for one query.
 *
 * The Agent contract gives `entity` queries `direct/related/possible` and information queries
 * `confirmed/suggested/possible/not-found`, while `broad` queries are documented to return *records*
 * of either family. Reading a broad query as an information query alone rejected `related`, which is
 * a legitimate status for the entity records such a query is supposed to return — the failure landed
 * on this code node, so the model never saw an error it could correct and the narrative continued
 * without the memory it had asked for.
 *
 * When the match names a record type, both vocabularies are accepted: the record type decides how the
 * match renders, and the status is only the searcher's confidence label, so an entity match labelled
 * `confirmed` is still a usable match. Rejecting it killed a real team meeting's required base
 * retrieval ("Invalid match status confirmed for record type memory.entity.") for a label the module
 * itself defines elsewhere. A status outside both vocabularies still fails loudly.
 */
const MATCH_STATUSES = new Set([...ENTITY_STATUSES, ...INFORMATION_STATUSES]);

function allowedStatuses(kind, recordType) {
  if (recordType !== undefined && recordType !== null) return MATCH_STATUSES;
  return kind === "entity" ? ENTITY_STATUSES : INFORMATION_STATUSES;
}

function enforceSelection(output, budget) {
  const queries = Array.isArray(output?.queries) ? output.queries : [];
  const entityCount = queries.filter(item => item.kind === "entity").length;
  if (entityCount > budget.entityQueryLimit) throw new Error("Entity query count exceeds retrieval budget.");
  let informationCount = 0;
  const used = new Set();
  const normalized = queries.map(query => {
    let possibleCount = 0;
    const matches = [];
    for (const match of Array.isArray(query.matches) ? query.matches : []) {
      const allowed = allowedStatuses(query.kind, match.recordType);
      if (!allowed.has(match.status)) throw new Error(`Invalid match status ${match.status} for record type ${match.recordType || "unspecified"}.`);
      if (match.status === "not-found") continue;
      if (used.has(match.recordId)) continue;
      if (match.status === "possible" && query.kind !== "entity" && ++possibleCount > budget.possiblePerQueryLimit) continue;
      if (!RECORD_TYPES.has(match.recordType)) throw new Error(`Invalid or missing recordType for ${match.recordId}.`);
      if (INFORMATION_RECORD_TYPES.has(match.recordType) && ++informationCount > budget.informationLimit + budget.elasticInformationLimit) continue;
      used.add(match.recordId);
      matches.push({ recordId: match.recordId, recordType: match.recordType, status: match.status });
    }
    return { query: String(query.query || "未命名询问"), kind: query.kind === "entity" ? "entity" : query.kind === "broad" ? "broad" : "information", matches };
  });
  return normalized;
}

function safePerspectiveFile(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "perspective";
}

export async function execute({ run, data, workspace }) {
  const retrieval = run.nodes["memory-retrieval"]?.output;
  if (!retrieval) throw new Error("compose-memory requires retrieval output.");
  const budget = run.nodes["prepare-retrieval"]?.output?.effectiveBudget;
  if (!budget) throw new Error("compose-memory requires the prepared effective retrieval budget.");
  const queries = enforceSelection(retrieval, budget);
  const entriesById = new Map();
  for (const match of queries.flatMap(query => query.matches)) {
    const entry = await getById(data, collectionFor(match.recordType), match.recordId, "retrieval");
    if (!entry || entry.recordType !== match.recordType) throw new Error(`Selected memory record ${match.recordId} was not found with type ${match.recordType}.`);
    entriesById.set(match.recordId, entry);
  }
  const groupItems = await queryAll(data, { moduleId: "narrative-memory", collectionId: "knower-groups", recordTypes: ["memory.knower-group"], view: "retrieval" });
  const groups = groupItems.map(item => unwrap(item));
  for (const group of groups) entriesById.set(group.id, group);
  const groupMembers = resolveGroupMembers(groups.map(group => ({ id: group.id, ...group.data })));
  const catalogNames = new Map([...entriesById].map(([id, entry]) => [id, entry.data?.name || id]));
  const general = composeMemoryDocument({ queryResults: queries, entriesById, groupMembers, catalogNames });
  const restricted = [];
  for (const item of retrieval.restrictedPerspectives || []) {
    if (!item.resolvedId) continue;
    const perspective = await getById(data, "entities", item.resolvedId, "retrieval");
    if (!perspective || perspective.recordType !== "memory.entity") throw new Error(`Restricted perspective ${item.resolvedId} is not a valid entity ID.`);
    entriesById.set(perspective.id, perspective);
    catalogNames.set(perspective.id, perspective.data?.name || perspective.id);
    restricted.push({
      input: item.input,
      resolvedId: item.resolvedId,
      document: composeMemoryDocument({ title: `${item.input}限制视角记忆`, queryResults: queries, entriesById, perspectiveId: item.resolvedId, groupMembers, catalogNames }),
    });
  }
  const target = resolve(workspace, "memory-context");
  await mkdir(resolve(target, "perspectives"), { recursive: true });
  await writeFile(resolve(target, "GENERAL.md"), `${general.trim()}\n`, "utf8");
  const documents = [{ id: "general", path: "GENERAL.md", title: "通用记忆资料", description: "按调用方查询清单匹配并组装的记忆资料。" }];
  for (const item of restricted) {
    const path = `perspectives/${safePerspectiveFile(item.resolvedId)}.md`;
    await writeFile(resolve(target, path), `${item.document.trim()}\n`, "utf8");
    documents.push({ id: `perspective-${item.resolvedId}`, path, title: `${item.input}限制视角记忆`, description: `只包含${item.input}按知情范围可见的已匹配资料。` });
  }
  await writeFile(resolve(target, "DOCUMENTS.md"), `${[
    "# 叙事记忆检索结果",
    "",
    "以下文档由一次自然语言查询请求匹配并确定性组装。检索结果不包含由检索Agent代做的剧情结论。",
    ...documents.flatMap(document => ["", `## ${document.title}`, "", `- id: \`${document.id}\``, `- path: \`${document.path}\``, `- description: ${document.description}`]),
    "",
  ].join("\n")}\n`, "utf8");
  return { schemaVersion: 1, budget, documents: documents.map(document => document.id), queryCount: queries.length };
}
