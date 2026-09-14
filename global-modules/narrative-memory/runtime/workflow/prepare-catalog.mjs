import { effectiveEventEntries } from "../lib/core.mjs";
import { queryAll } from "../lib/data-helpers.mjs";

export const MEMORY_CATALOG_COLLECTIONS = ["entities", "relationships", "events", "cognitions", "knower-groups"];

export function catalogEntry(item) {
  const value = item.value || {};
  const data = {
    name: value["名称"],
    aliases: value["别名"],
    entityKind: value["实体类型"],
    catalogSummary: value["摘要"],
    templateId: value["模板"],
    status: value["状态"],
    partyIds: value["参与方"],
    time: value["时间"],
    timeRange: value["时间范围"],
    locationIds: value["地点"],
    coveredEventIds: value["覆盖事件"],
    sourceEntryIds: value["直接来源"],
    precedingSummaryIds: value["前置摘要"],
    overviewInformationControl: value["概况知情范围"],
    subjectRecordIds: value["主题"],
    propagationStage: value["传播阶段"],
    membershipMode: value["成员模式"],
    membershipDefinition: value["成员定义"],
  };
  return { id: item.id, recordType: item.recordType, revision: item.revision, data };
}

export async function execute({ data, collections = MEMORY_CATALOG_COLLECTIONS }) {
  const directory = {};
  for (const collectionId of collections) {
    const items = await queryAll(data, { moduleId: "narrative-memory", collectionId, view: "catalog" });
    directory[collectionId] = items.map(catalogEntry);
  }
  directory.effectiveEvents = effectiveEventEntries(directory.events);
  return { schemaVersion: 1, directory };
}
