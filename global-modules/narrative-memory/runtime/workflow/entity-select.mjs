import { selectEntities } from "../lib/core.mjs";
import { queryAll } from "../lib/data-helpers.mjs";

export async function execute({ run, data }) {
  const items = await queryAll(data, { moduleId: "narrative-memory", collectionId: "entities", recordTypes: ["memory.entity"], view: "selection" });
  const records = items.map(item => ({ id: item.id, ...item.value }));
  return selectEntities(records.map(record => ({
    id: record.id,
    name: record["名称"],
    entityKind: record["实体类型"],
    templateId: record["模板"],
    templateVersion: record["模板版本"],
    derivedFacets: record["筛选面"] || {},
  })), run.arguments?.request || {}, {
    sessionId: run.chatId,
    turn: run.turn,
    workflowId: run.workflowId,
    maxResults: run.arguments?.request?.maximum?.maxResults,
    maxFilterClauses: run.arguments?.request?.maximum?.maxFilterClauses,
  });
}
