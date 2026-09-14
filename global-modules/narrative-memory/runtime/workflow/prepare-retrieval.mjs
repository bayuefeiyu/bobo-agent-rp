import { MAXIMUM_RETRIEVAL_BUDGET, normalizeRetrievalBudget } from "../lib/core.mjs";

export async function execute({ run, data }) {
  const item = await data.get({ moduleId: "narrative-memory", collectionId: "support", id: "narrative-memory-settings", view: "maintenance" });
  if (!item?.value?.retrieval) throw new Error("Missing narrative-memory retrieval settings.");
  const settings = item.value.retrieval;
  const requested = settings.customBudgetInterfaceEnabled === true && run.arguments?.budget ? run.arguments.budget : settings;
  return {
    effectiveBudget: normalizeRetrievalBudget(requested, settings, MAXIMUM_RETRIEVAL_BUDGET),
    customBudgetApplied: settings.customBudgetInterfaceEnabled === true && Boolean(run.arguments?.budget),
  };
}
