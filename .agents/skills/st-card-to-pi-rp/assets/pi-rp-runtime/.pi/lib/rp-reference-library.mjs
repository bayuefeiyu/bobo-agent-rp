import { readFile, writeFile, mkdir, rename, realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname, relative, isAbsolute } from "node:path";
const MODULE_ID = "creative-reference-library";
const queues = new Map();
// Extension context handlers report errors and continue in Pi. Wrap the Agent's
// public transform instead so an exhausted budget stops before provider dispatch.
export function installReferenceModelBudget(agent, charge) {
  if (!agent || typeof agent.streamFunction !== "function") throw new Error("Reference retrieval requires a compatible Pi Agent.");
  const previous = agent.transformContext;
  const guard = { error: null };
  agent.transformContext = async function (messages, signal) {
    if (guard.error) throw guard.error;
    try { await charge(); }
    catch (error) { guard.error = error instanceof Error ? error : new Error(String(error)); throw guard.error; }
    return previous ? previous.call(this, messages, signal) : messages;
  };
  return guard;
}
export function referenceBindingPath() {
  return resolve(process.env.BOBO_AGENT_RP_USER_CONFIG_DIR || resolve(homedir(), ".config", "bobo-agent-rp"), "reference-library.json");
}
export async function referenceBinding() {
  try { const value = JSON.parse(await readFile(referenceBindingPath(), "utf8")); return typeof value.root === "string" && isAbsolute(value.root) ? value : null; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function saveReferenceBinding(value) {
  if (!value || typeof value.root !== "string" || value.root && !isAbsolute(value.root)) throw new Error("Library root must be an absolute directory.");
  const path = referenceBindingPath(); await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, root: value.root ? await realpath(value.root) : "" }) + "\n", { mode: 0o600 }); await rename(temporary, path);
  return referenceStatus();
}
export async function browseReferenceDirectories(value = {}) {
  if(value.path!==undefined&&(typeof value.path!=="string"||value.path&&!isAbsolute(value.path)))throw Object.assign(new Error("请选择绝对目录。"),{status:400});
  const path=resolve(value.path||homedir()),offset=value.offset??0;
  if(!Number.isSafeInteger(offset)||offset<0)throw Object.assign(new Error("目录分页参数无效。"),{status:400});
  const roots=[{name:"用户目录",path:homedir()}];
  if(process.platform==="win32"){
    const drives=await Promise.all(Array.from({length:26},(_,index)=>String.fromCharCode(65+index)+":\\").map(async drive=>{try{return (await stat(drive)).isDirectory()?{name:drive,path:drive}:null;}catch{return null;}}));
    roots.push(...drives.filter(Boolean));
  }else roots.push({name:"根目录",path:"/"});
  try{
    if(!(await stat(path)).isDirectory())throw new Error("所选路径不是目录。");
    const entries=await readdir(path,{withFileTypes:true});
    const directories=(await Promise.all(entries.map(async entry=>{
      if(entry.isDirectory()||entry.isSymbolicLink()&&await stat(resolve(path,entry.name)).then(info=>info.isDirectory(),()=>false))return {name:entry.name,path:resolve(path,entry.name)};
      return null;
    }))).filter(Boolean).sort((a,b)=>a.name.localeCompare(b.name,"zh-CN",{numeric:true}));
    return {path,parent:dirname(path)===path?null:dirname(path),roots,directories:directories.slice(offset,offset+200),offset,total:directories.length,nextOffset:offset+200<directories.length?offset+200:null};
  }catch(error){throw Object.assign(new Error(`无法读取目录：${path}（${error.message}）`),{status:400});}
}
async function core() {
  return import((await coreUrl()).href);
}
export async function referenceSemanticManager() {
  const { getSemanticManager } = await import(new URL("./semantic-manager.mjs", (await coreUrl()).href));
  return getSemanticManager({ configurationDirectory: dirname(referenceBindingPath()), getRoot: async () => (await referenceBinding())?.root });
}
export async function referenceSemanticManagement(operation, value = {}) {
  const manager = await referenceSemanticManager();
  if (operation === "settings") return manager.publicSettings();
  if (operation === "save") return manager.save(value);
  if (operation === "status") return manager.status();
  if (operation === "test") return manager.test();
  if (operation === "start") return manager.start(value);
  if (operation === "cancel") return manager.cancel(value.jobId);
  if (operation === "resume") return manager.start({ resumeJobId: value.jobId });
  if (operation === "query") {
    // User test queries use the same service as independent callers, with no
    // story/session mutation and no Agent-controlled maintenance access.
    const snapshot = await manager.snapshot(); const { RetrievalSession } = await core();
    const controller = new AbortController(), unregister = manager.registerController(controller);
    try { return await manager.withClient(snapshot.root, undefined, snapshot, async (client, _formal, info) => new RetrievalSession(client, undefined, { ...snapshot, info, queryCache: manager.queryCache, signal: controller.signal }).searchPassages(value)); } finally { unregister(); }
  }
  throw Object.assign(new Error("Unknown semantic operation."), { code: "invalid_request" });
}
export async function referenceStatus() {
  const binding = await referenceBinding();
  if (!binding?.root) return { bound: false, ready: false, semanticReady: false, status: "library_unbound" };
  let client;
  try { const { LibraryClient } = await core(); client = new LibraryClient(); const snapshot = await client.open(binding.root); const semantic = await (await referenceSemanticManager()).status().catch(() => ({ ready: false, status: "semantic_configuration_invalid" })); return { bound: true, ready: true, semanticReady: semantic.ready, semanticStatus: semantic.status, generation: snapshot.generation, status: "ready" }; }
  catch { return { bound: true, ready: false, semanticReady: false, status: "index_unavailable" }; }
  finally { await client?.close(); }
}
export async function privateLibraryToolAllowed(workspace, tool, input, protectedRoots = []) {
  const binding = await referenceBinding();
  const configRoot = await realpath(dirname(referenceBindingPath())).catch(() => dirname(referenceBindingPath()));
  if (["bash", "shell", "exec", "python"].includes(tool)) return !binding?.root && !await realpath(resolve(configRoot, "service-secrets.json")).then(() => true, () => false) && !await realpath(resolve(configRoot, "narrative-history-services.json")).then(() => true, () => false);
  if (!["read", "write", "edit", "find", "grep", "ls"].includes(tool)) return true;
  const requested = input?.path ?? workspace;
  if (typeof requested !== "string") return false;
  let actual = resolve(workspace, requested), tail = [];
  while (true) {
    try { actual = resolve(await realpath(actual), ...tail.reverse()); break; }
    catch (error) { if (error.code !== "ENOENT") return false; const parent = dirname(actual); if (parent === actual) return false; tail.push(actual.slice(parent.length + 1)); actual = parent; }
  }
  const configurationRelation = relative(process.platform === "win32" ? configRoot.toLowerCase() : configRoot, process.platform === "win32" ? actual.toLowerCase() : actual);
  if (!configurationRelation || !configurationRelation.startsWith("..") && !isAbsolute(configurationRelation)) return false;
  const configAncestor = relative(actual, configRoot);
  if (["find", "grep", "ls"].includes(tool) && (!configAncestor || !configAncestor.startsWith("..") && !isAbsolute(configAncestor))) return false;
  if (!binding?.root) return true;
  let root; try { root = await realpath(binding.root); } catch { root = resolve(binding.root); }
  if (process.platform === "win32") { actual = actual.toLowerCase(); root = root.toLowerCase(); }
  const rel = relative(root, actual);
  if (!rel || !rel.startsWith("..") && !isAbsolute(rel)) return false;
  const privateConfig = await realpath(referenceBindingPath()).catch(() => referenceBindingPath());
  if (actual === (process.platform === "win32" ? privateConfig.toLowerCase() : privateConfig)) return false;
  for (let protectedRoot of protectedRoots) {
    protectedRoot = await realpath(protectedRoot).catch(() => resolve(protectedRoot));
    if (process.platform === "win32") protectedRoot = protectedRoot.toLowerCase();
    const relation = relative(protectedRoot, actual);
    if (!relation || !relation.startsWith("..") && !isAbsolute(relation)) return false;
  }
  // Directory discovery from a parent could traverse the private library.
  const ancestor = relative(actual, root);
  if (["find", "grep", "ls"].includes(tool) && (!ancestor || !ancestor.startsWith("..") && !isAbsolute(ancestor))) return false;
  return true;
}
export function assertReferenceAccess(target, workflow, node) {
  const module = target.featureModules.find(m => m.id === MODULE_ID);
  if (module?.externalResource !== "creative-reference-library/v1" || workflow.ownerModuleId !== MODULE_ID || !node.runtimeServices?.includes("referenceLibrary")) throw Object.assign(new Error("Reference library access is not granted to this node."), { code: "access_denied" });
}
export function createReferenceService(target, workflow, run, node, sessionDirectory) {
  assertReferenceAccess(target, workflow, node);
  let rootRun = run;
  while (rootRun.callContext?.parentRunId) {
    const parent = target.workflowEngine.runs.get(rootRun.callContext.parentRunId);
    if (!parent || parent.workflow?.ownerModuleId !== MODULE_ID) break;
    rootRun = parent.run;
  }
  const statePath = resolve(sessionDirectory, "reference-library-requests", `${rootRun.id}.json`);
  async function transact(fn, requireSemantic = false, needsPassages = false) {
    const previous = queues.get(statePath) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const binding = await referenceBinding(); let state;
      try { state = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const libraryRoot = state?.root ?? binding?.root; if (!libraryRoot) throw Object.assign(new Error("Reference library is not bound."), { code: "library_unbound" });
      const { RetrievalSession } = await core(), manager = await referenceSemanticManager();
      let semanticSnapshot = state?.semantic ?? null;
      if (!state && (await manager.status().catch(() => ({ ready: false }))).ready) { const value = await manager.snapshot(); semanticSnapshot = { config: value.config, revision: value.revision, generation: value.generation }; }
      if (requireSemantic && (!semanticSnapshot || !(await manager.settings()).config.enabled)) throw Object.assign(new Error("Semantic retrieval is not ready."), { code: "capability_unavailable" });
      const controller = new AbortController(), unregister = manager.registerController(controller);
      let session;
      const persist = async () => {
        if (!session) return;
        await mkdir(dirname(statePath), { recursive: true });
        const temporary = `${statePath}.tmp`; await writeFile(temporary, JSON.stringify({ root: libraryRoot, generation, semantic: semanticSnapshot, limits: session.ledger.limits, used: session.ledger.used, seen: [...session.seen], seenPassages: [...session.seenPassages], passageGroups: session.passageGroups, outputRefs: [...session.outputRefs], outputRanges: session.outputRanges, selectedRefs: session.selectedRefs, scoredIds: [...session.scoredIds], modelByRun: session.modelByRun, outputIds: [...session.outputIds], selectedIds: session.selectedIds })); await rename(temporary, statePath);
      };
      try { return await manager.withClient(libraryRoot, state?.generation, requireSemantic || needsPassages ? semanticSnapshot : null, async (client, snapshot, info) => {
        generation = snapshot.generation;
        session = new RetrievalSession(client, state?.limits ?? rootRun.arguments?.budget, semanticSnapshot && info ? { ...semanticSnapshot, info, secrets: await manager.credentials(semanticSnapshot.config), queryCache: manager.queryCache, signal: controller.signal, onCharge: persist } : null);
        session.scoredIds = new Set(state?.scoredIds ?? []);
        session.outputIds = new Set(state?.outputIds ?? []);
        session.seenPassages = new Set(state?.seenPassages ?? []);
        session.outputRefs = new Set(state?.outputRefs ?? (state?.outputIds ?? []).map(id => `unit:${id}`));
        session.outputRanges = Object.assign(Object.create(null), state?.outputRanges);
        session.passageGroups = Object.assign(Object.create(null), state?.passageGroups);
        session.selectedRefs = state?.selectedRefs ?? (state?.selectedIds ?? []).map(id => ({ kind: "unit", id }));
        session.selectedIds = state?.selectedIds ?? [];
        session.modelByRun = state?.modelByRun ?? {};
        if (state) { Object.assign(session.ledger.used, state.used); session.seen = new Set(state.seen); }
        const result = await fn(session);
        return result;
      }); } finally { try { await persist(); } finally { unregister(); } }
    });
    queues.set(statePath, pending);
    try { return await pending; }
    catch (error) {
      const safeCodes = new Set(["invalid_format", "invalid_request", "invalid_scores", "selection_invalid", "budget_exhausted", "capability_unavailable", "runtime_incompatible", "index_incompatible", "library_unbound", "unit_not_found", "semantic_disabled", "semantic_index_incompatible", "semantic_index_corrupt", "semantic_capacity_exceeded", "invalid_embedding", "invalid_rerank", "service_input_limit", "service_unavailable", "service_busy", "query_timeout", "cancelled"]);
      const code = safeCodes.has(error.code) ? error.code : "index_unavailable";
      throw Object.assign(new Error(`Reference retrieval failed (${code}).`), { code });
    } finally { if (queues.get(statePath) === pending) queues.delete(statePath); }
  }
  // Snapshot is held outside model-visible outputs; persisted with the request ledger.
  let generation;
  return Object.freeze({
    initialize: request => transact(async session => { const { normalizeRequest } = await import(new URL("./contract.mjs", (await coreUrl()).href)); normalizeRequest(request, { allowSemantic: Boolean(session.semantic) }); return { request, budget: session.ledger.limits }; }, request.includeSemanticCandidates === true),
    prepare: request => transact(async session => {
      const { normalizeRequest } = await import(new URL("./contract.mjs", (await coreUrl()).href));
      const normalized = normalizeRequest(request, { allowSemantic: Boolean(session.semantic) });
      const found = (await session.collectUnitCandidates(request)).slice(0, Math.min(normalized.budget.scored, session.ledger.remaining("scored")));
      const candidates = [];
      let characters = JSON.stringify(request).length;
      for (const item of found) { const size = JSON.stringify(item).length; if (characters + size > Math.min(normalized.budget.scoreCharacters, session.ledger.remaining("scoreCharacters")) / 4) break; characters += size; candidates.push(item); }
      return { request, candidates };
    }, request.includeSemanticCandidates === true),
    search: request => transact(session => session.search(request)),
    read: unitId => transact(session => session.read(unitId)),
    readReference: item => transact(async session => { const value = item.kind === "passage" ? await session.readPassage(item.id) : await session.read(item.id); return { kind: item.kind, id: item.id, title: value.title, content: value.content, relations: value.relations }; }, false, item.kind === "passage"),
    searchPassages: request => transact(async session => { const result = await session.searchPassages(request); session.selectedRefs = result.selectedRefs; session.selectedIds = result.selectedIds; return result; }, true),
    chargeModel: (payload, score = false) => transact(async session => {
      const calls = session.modelByRun[run.id] ?? 0;
      if (calls >= (score ? 4 : 8)) throw Object.assign(new Error("Reference model call budget exhausted."), { code: "budget_exhausted" });
      session.modelByRun[run.id] = calls + 1;
      session.ledger.charge("modelCalls", 1);
      if (score) { const fresh = payload.candidates.filter(c => !session.scoredIds.has(c.id)); session.ledger.charge("scored", fresh.length); fresh.forEach(c => session.scoredIds.add(c.id)); session.ledger.charge("scoreCharacters", JSON.stringify(payload).length); }
      return true;
    }),
    orderScores: async (output, candidates) => { const { rankScores } = await import(new URL("./contract.mjs", (await coreUrl()).href)); return rankScores(output, candidates); },
    validateSelection: ids => transact(async session => {
      if (!Array.isArray(ids) || ids.length > 40 || new Set(ids).size !== ids.length || ids.some(id => !session.seen.has(id))) throw Object.assign(new Error("Select only discovered IDs, without duplicates."), { code: "selection_invalid" });
      return true;
    }),
    selected: () => transact(async session => [...session.selectedIds]),
    selectedReferences: () => transact(async session => [...session.selectedRefs]),
    validateReferences: items => transact(async session => { session.validateReferences(items); return true; }),
    composeReferences: (items, budget) => transact(async session => { const result = await session.composeReferences(items, budget ? Object.fromEntries(Object.entries(session.ledger.limits).map(([key, limit]) => [key, Math.min(limit, budget[key] ?? limit)])) : session.ledger.limits); session.selectedRefs = result.selectedRefs; session.selectedIds = result.selectedIds; return result; }, false, items?.some(item => item.kind === "passage")),
    compose: (ids, budget) => transact(async session => { const result = await session.compose(ids, budget ? Object.fromEntries(Object.entries(session.ledger.limits).map(([key, limit]) => [key, Math.min(limit, budget[key] ?? limit)])) : session.ledger.limits); session.selectedRefs = result.selectedRefs; session.selectedIds = result.selectedIds; return result; }),
  });
}
async function coreUrl() {
  const installed = new URL("./creative-reference-library/client.mjs", import.meta.url);
  try { await readFile(installed); return installed; } catch (error) { if (error.code !== "ENOENT") throw error; return new URL("../../../../../../../packages/creative-reference-library/client.mjs", import.meta.url); }
}
