import { effectiveEventEntries } from "../lib/core.mjs";
import { queryAll, unwrap } from "../lib/data-helpers.mjs";

function compressionCatalogEntry(entry) {
  const data = entry.data || {};
  return {
    id: entry.id,
    recordType: entry.recordType,
    revision: entry.revision,
    data: entry.recordType === "memory.event-summary"
      ? {
          name: data.name,
          timeRange: data.timeRange,
          locationIds: data.locationIds || [],
          catalogSummary: data.catalogSummary || "",
          coveredEventIds: data.coveredEventIds || [],
        }
      : {
          name: data.name,
          status: data.status,
          time: data.time,
          locationIds: data.locationIds || [],
          catalogSummary: data.catalogSummary || "",
        },
  };
}

export async function execute({ run, data }) {
  const stateItem = await data.get({ moduleId: "narrative-memory", collectionId: "support", id: "narrative-memory-maintenance-state", view: "maintenance" });
  const settingsItem = await data.get({ moduleId: "narrative-memory", collectionId: "support", id: "narrative-memory-settings", view: "maintenance" });
  if (!stateItem || !settingsItem) throw new Error("Missing compression support state.");
  const state = stateItem.value;
  const settings = settingsItem.value;
  const manual = run.trigger?.type === "manual" && settings.compression.allowManualTrigger;
  if (!settings.compression.enabled) return {
    schemaVersion: 1, route: "skip", shouldCompress: false, reason: "disabled",
    stateRecord: { id: stateItem.id, revision: stateItem.revision, data: state },
    settingsRecord: { id: settingsItem.id, revision: settingsItem.revision, data: settings },
    effectiveEntryCount: 0, targetEntryCount: state.compression.targetEntryCount,
  };
  const eventItems = await queryAll(data, { moduleId: "narrative-memory", collectionId: "events", view: "maintenance" });
  const events = eventItems.map(item => unwrap(item));
  const effective = effectiveEventEntries(events);
  const shouldCompress = settings.compression.enabled && (manual || effective.length >= state.compression.triggerEntryCount);
  return {
    schemaVersion: 1,
    route: shouldCompress ? "compress" : "skip",
    shouldCompress,
    reason: shouldCompress ? null : settings.compression.enabled ? "below-trigger" : "disabled",
    stateRecord: { id: stateItem.id, revision: stateItem.revision, data: state },
    settingsRecord: { id: settingsItem.id, revision: settingsItem.revision, data: settings },
    effectiveEntryCount: effective.length,
    targetEntryCount: state.compression.targetEntryCount,
    effectiveEntries: shouldCompress ? effective.map(compressionCatalogEntry) : [],
  };
}
