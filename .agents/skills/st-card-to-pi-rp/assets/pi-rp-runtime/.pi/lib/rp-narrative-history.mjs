import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

async function historyCore() {
  const installed = new URL("./narrative-history/manager.mjs",import.meta.url);
  try { await readFile(installed); return import(installed.href); }
  catch (error) { if (error.code !== "ENOENT") throw error; return import(new URL("../../../../../../../packages/narrative-history/manager.mjs",import.meta.url).href); }
}
export async function historyConfiguration() {
  const { HistoryConfiguration } = await historyCore();
  return new HistoryConfiguration(process.env.BOBO_AGENT_RP_USER_CONFIG_DIR || resolve(homedir(),".config","bobo-agent-rp"));
}
export async function historyServiceManagement(operation,value = {}) {
  const manager = await historyConfiguration();
  if (operation === "settings") return manager.publicSettings();
  if (operation === "save") return manager.save(value);
  if (operation === "test") return manager.test();
  throw Object.assign(new Error("Unknown history service operation."),{ code:"invalid_request" });
}
export function assertNarrativeHistoryAccess(workflow,node) {
  if (workflow.ownerModuleId !== "narrative-controls" || node.type !== "code" || !node.runtimeServices?.includes("narrativeHistory")) throw Object.assign(new Error("Historical narrative access is not granted."),{ code:"access_denied" });
}
export async function createNarrativeHistoryService({ workflow,node,run,messages,settings,sessionDirectory,recentCompleteTurns,isEnabled,isCancelled = () => false }) {
  assertNarrativeHistoryAccess(workflow,node);
  const { NarrativeHistory } = await historyCore();
  const manager = new NarrativeHistory({ directory:resolve(sessionDirectory,"derived","narrative-history"),configuration:await historyConfiguration(),isEnabled });
  const cancellable = async fn => {
    const controller = new AbortController();
    const timer = setInterval(() => { if (isCancelled()) controller.abort(); },100); timer.unref();
    try { return await fn(controller.signal); } finally { clearInterval(timer); }
  };
  const recordDiagnostic = async result => { const directory = resolve(sessionDirectory,"derived","narrative-history","requests"); await mkdir(directory,{ recursive:true }); await writeFile(resolve(directory,`${run.id}.json`),JSON.stringify({ runId:run.id,executionId:run.executionId,status:result.status,partial:result.partial,queryClipped:result.queryClipped,candidates:result.candidates,errorCode:result.errorCode,results:result.excerpts?.map(({ content,...item }) => item) })+"\n"); return result; };
  const recoverable = new Set(["history_configuration_incomplete","history_services_unverified","history_configuration_changed","history_index_unavailable","history_index_corrupt","history_capacity_exceeded","invalid_embedding","invalid_rerank","service_input_limit","service_unavailable","service_retryable","service_response_invalid","query_timeout","cancelled","TimeoutError","AbortError","SQLITE_CORRUPT"]);
  return Object.freeze({
    retrieve:async () => {
      try { return await recordDiagnostic(await cancellable(signal => manager.retrieve(messages,settings,{ currentTurn:run.turn,recentCompleteTurns,signal }))); }
      catch (error) { if (!recoverable.has(error.code ?? error.name)) throw error; return recordDiagnostic({ status:"unavailable",errorCode:error.code ?? error.name,excerpts:[] }); }
    },
    index:async () => { const operation = run.arguments?.operation ?? run.payload?.operation; return cancellable(signal => manager.index(messages,settings,{ recentCompleteTurns,force:operation === "update" || operation === "rebuild",rebuild:operation === "rebuild",signal })); },
    status:async () => manager.status(messages,settings,recentCompleteTurns),
    cancel:async () => { const { cancelHistoryOperations } = await historyCore(); cancelHistoryOperations(manager.path); return { status:"cancelled" }; },
  });
}
export async function cancelNarrativeHistory(sessionDirectory) { const { cancelHistoryOperations } = await historyCore(); cancelHistoryOperations(resolve(sessionDirectory,"derived","narrative-history","index.sqlite")); }
export async function validateNarrativeHistorySettings(value) { const { normalizeSettings } = await historyCore(); return normalizeSettings(value); }
export async function narrativeHistoryStatus(sessionDirectory,messages,settings,recentCompleteTurns) {
  const { NarrativeHistory } = await historyCore();
  return new NarrativeHistory({ directory:resolve(sessionDirectory,"derived","narrative-history"),configuration:await historyConfiguration() }).status(messages,settings,recentCompleteTurns);
}
