import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, fail, normalizeServices, normalizeSettings, spaceKey, chunkKey, protectedSources, sources } from "./contract.mjs";
import { sliceNarrative, composeExcerpts } from "./passages.mjs";
import { indexOperation,recallCandidates } from "./client.mjs";
import { createSemanticServices } from "../semantic-services/services.mjs";

const queues = new Map(), controllers = new Map();
export { normalizeSettings };
export async function selectWithRerank({ api,query,candidates,minScore }) {
  return (await api.rerank(query,candidates.map(item => item.content))).filter(row => minScore === null || row.score >= minScore).map(row => ({ ...candidates[row.index],score:row.score }));
}
async function optionalJson(path) { try { return JSON.parse(await readFile(path,"utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function atomicJson(path,value) { await mkdir(dirname(path),{ recursive:true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary,JSON.stringify(value)+"\n",{ mode:0o600 }); await rename(temporary,path); }
export function cancelHistoryOperations(key) { for (const controller of controllers.get(key) ?? []) controller.abort(); }
function register(key,controller) { const group = controllers.get(key) ?? new Set(); group.add(controller); controllers.set(key,group); return () => { group.delete(controller); if (!group.size) controllers.delete(key); }; }
export class HistoryConfiguration {
  constructor(directory) { this.path = resolve(directory,"narrative-history-services.json"); }
  async settings() { const saved = await optionalJson(this.path); return { config:normalizeServices(saved?.config), secrets:saved?.secrets ?? {}, verified:saved?.verified ?? null }; }
  async publicSettings() { const value = await this.settings(); return { config:value.config,hasEmbeddingSecret:Boolean(value.secrets.embeddingKey),hasRerankSecret:Boolean(value.secrets.rerankKey),verified:value.verified === digest(value.config) }; }
  async save(value) {
    const previous = await this.settings(), config = normalizeServices(value.config);
    const secrets = { ...previous.secrets };
    for (const key of ["embeddingKey","rerankKey"]) if (value[key] !== undefined) { if (typeof value[key] !== "string") fail("history_configuration_invalid"); secrets[key] = value[key]; }
    cancelHistoryOperations(this.path);
    await atomicJson(this.path,{ config,secrets,verified:digest(config) === digest(previous.config) && digest(secrets) === digest(previous.secrets) ? previous.verified : null });
    return this.publicSettings();
  }
  async test() {
    const value = await this.settings(); this.assertConfigured(value.config);
    const controller = new AbortController(), unregister = register(this.path,controller);
    try {
      const api = createSemanticServices(value.config,{ ...value.secrets,retries:0,signal:controller.signal });
      await api.embed(["这是历史原文回顾服务的合成连接测试。"],"document");
      await api.embed(["回顾角色说过的话。"],"query");
      await api.rerank("回顾对白",["角色说：明天再见。"]);
      // Do not certify a configuration changed while the test was in flight.
      const current = await this.settings(); controller.signal.throwIfAborted();
      if (digest(current.config) !== digest(value.config) || digest(current.secrets) !== digest(value.secrets)) fail("history_configuration_changed");
      await atomicJson(this.path,{ ...current,verified:digest(value.config) }); return { ok:true };
    } finally { unregister(); }
  }
  assertConfigured(config) { if (!config.embedding.url || !config.embedding.model || !config.rerank.url || !config.rerank.model) fail("history_configuration_incomplete"); }
  async ready() { const value = await this.settings(); this.assertConfigured(value.config); if (value.verified !== digest(value.config)) fail("history_services_unverified"); return value; }
}
function clipped(text,max) {
  if (text.length <= max) return text;
  let head = Math.floor(max/4), tail = max-head-5;
  if (/[\uD800-\uDBFF]/.test(text[head-1])) head--;
  let start = text.length-tail; if (/[\uDC00-\uDFFF]/.test(text[start])) start++;
  return `${text.slice(0,head)}\n[…]\n${text.slice(start)}`;
}
export class NarrativeHistory {
  constructor({ directory,configuration,isEnabled = async () => true,selectCandidates = selectWithRerank }) { this.directory = directory; this.configuration = configuration; this.isEnabled = isEnabled; this.selectCandidates = selectCandidates; this.path = resolve(directory,"index.sqlite"); this.jobPath = resolve(directory,"job.json"); }
  async status(messages,rawSettings,recentCompleteTurns = 5) {
    const settings = normalizeSettings(rawSettings), { config } = await this.configuration.settings();
    const view = protectedSources(messages,settings,recentCompleteTurns);
    let coverage, warningCode;
    try { coverage = new Set(await indexOperation(this.path,"coverage",{ space:spaceKey(config),chunk:chunkKey(settings) })); }
    catch (error) { if (error.code !== "history_index_corrupt") throw error; coverage = new Set(); warningCode = error.code; }
    const covered = view.eligible.filter(source => coverage.has(source.key));
    const job = await optionalJson(this.jobPath);
    return { enabled:settings.enabled,warningCode,totalSources:view.all.length,eligibleSources:view.eligible.length,indexedSources:covered.length,pendingSources:view.eligible.length-covered.length,protectedTurns:view.protectedTurns,indexedTurns:[...new Set(covered.map(source => source.turn))],partial:covered.length < view.eligible.length,job:job?.status === "running" && !queues.has(this.path) ? { ...job,status:"interrupted" } : job,configuration:await this.configuration.publicSettings() };
  }
  async index(messages,rawSettings,{ recentCompleteTurns = 5,force = false,rebuild = false,signal } = {}) {
    const settings = normalizeSettings(rawSettings);
    if (!settings.enabled || !await this.isEnabled()) return { status:"disabled" };
    const previous = queues.get(this.path) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.build(messages,settings,{ recentCompleteTurns,force,rebuild,signal }));
    queues.set(this.path,task); try { return await task; } finally { if (queues.get(this.path) === task) queues.delete(this.path); }
  }
  async build(messages,settings,{ recentCompleteTurns,force,rebuild,signal }) {
    const value = await this.configuration.ready(), config = value.config, space = spaceKey(config), chunk = chunkKey(settings);
    const controller = new AbortController(), unregister = register(this.path,controller), unconfigure = register(this.configuration.path,controller);
    const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    let job = { id:randomUUID(),status:"running",processedSources:0,passages:0,startedAt:new Date().toISOString() };
    try {
      // Re-encode complete sources in place atomically; keep the previous usable source on failure.
      let covered;
      try { covered = await indexOperation(this.path,"coverage",{ space,chunk },{ signal:combined }); }
      catch (error) {
        if (!rebuild || error.code !== "history_index_corrupt") throw error;
        await rename(this.path,`${this.path}.corrupt-${randomUUID()}`);
        job.warningCode = "history_index_corrupt_rebuilt";
        covered = [];
      }
      const coverage = new Set(rebuild ? [] : covered);
      const eligible = protectedSources(messages,settings,recentCompleteTurns).eligible, pending = eligible.filter(source => !coverage.has(source.key));
      const previousJob = await optionalJson(this.jobPath);
      const repair = eligible.some(source => !coverage.has(source.key) && sources(messages).some(other => other.id === source.id && other.revision > 1));
      if (!pending.length) return { status:"current" };
      if (!force && coverage.size && !repair && !["failed","interrupted","cancelled","running"].includes(previousJob?.status) && new Set(pending.filter(source => source.turn > 0).map(source => source.turn)).size < settings.indexEveryTurns) return { status:"cooldown",pendingSources:pending.length };
      await atomicJson(this.jobPath,job);
      const api = createSemanticServices(config,{ ...value.secrets,signal:combined,beforeRequest:async () => { if (!await this.isEnabled()) fail("cancelled"); } });
      for (const source of pending) {
        combined.throwIfAborted(); if (!await this.isEnabled()) fail("cancelled");
        const passages = sliceNarrative(source,settings), encoded = [];
        for (let start=0;start<passages.length;start+=config.embedding.batchSize) {
          const batch = passages.slice(start,start+config.embedding.batchSize);
          const vectors = await api.embed(batch.map(item => item.content));
          batch.forEach((item,index) => encoded.push({ ...item,vector:[...vectors[index]] }));
        }
        // Publish a complete source only. Failed encodings leave this source uncovered.
        if (!await this.isEnabled()) fail("cancelled");
        await indexOperation(this.path,"publish",{ space,chunk,source:source.key,passages:encoded },{ signal:combined });
        job.processedSources++; job.passages += encoded.length; await atomicJson(this.jobPath,job);
        await new Promise(resolve => setImmediate(resolve));
      }
      job = { ...job,status:"completed",finishedAt:new Date().toISOString() }; await atomicJson(this.jobPath,job); return job;
    } catch (error) { job = { ...job,status:combined.aborted || error.code === "cancelled" ? "cancelled" : "failed",errorCode:error.code ?? "history_index_unavailable",finishedAt:new Date().toISOString() }; await atomicJson(this.jobPath,job); throw error; }
    finally { unregister(); unconfigure(); }
  }
  async retrieve(messages,rawSettings,{ currentTurn,recentCompleteTurns = 5,signal } = {}) {
    const settings = normalizeSettings(rawSettings);
    if (!settings.enabled || !await this.isEnabled()) return { status:"disabled",excerpts:[] };
    const value = await this.configuration.ready(), config = value.config;
    const controller = new AbortController(), unregister = register(this.path,controller), unconfigure = register(this.configuration.path,controller);
    const combined = AbortSignal.any([controller.signal,AbortSignal.timeout(settings.deadlineMs),...(signal ? [signal] : [])]);
    try {
      const all = sources(messages).filter(source => source.turn < currentTurn), visible = new Set(all.slice(-recentCompleteTurns).map(source => source.key));
      const eligible = all.filter(source => !visible.has(source.key));
      const space = spaceKey(config), chunk = chunkKey(settings), coverage = new Set(await indexOperation(this.path,"coverage",{ space,chunk },{ signal:combined }));
      const allowed = eligible.filter(source => coverage.has(source.key)).map(source => source.key);
      if (!allowed.length) return { status:"empty",excerpts:[],partial:eligible.length > 0 };
      const previous = all.at(-1)?.content ?? "", input = [...messages].reverse().find(message => message.data?.role === "user" && message.binding.turn === currentTurn)?.data.content ?? "";
      const queryMax = Math.max(64,Math.min(3000,config.embedding.maxInputCharacters-config.embedding.queryPrefix.length,Math.floor((config.rerank.maxInputCharacters-settings.maxCharacters-600)/2)));
      const raw = [previous,input].filter(text => text.trim()), queries = raw.map(text => clipped(text,queryMax));
      if (!queries.length) return { status:"empty",excerpts:[] };
      const api = createSemanticServices(config,{ ...value.secrets,signal:combined,beforeRequest:async () => { if (!await this.isEnabled()) fail("cancelled"); } });
      const vectors = [];
      for (let start=0;start<queries.length;start+=config.embedding.batchSize) vectors.push(...await api.embed(queries.slice(start,start+config.embedding.batchSize),"query"));
      const candidates = await recallCandidates(this.path,{ space,chunk,allowed,vectors:vectors.map(vector => [...vector]),dimensions:config.embedding.dimensions,limit:settings.candidatesPerQuery,deadline:Date.now()+settings.deadlineMs },{ signal:combined });
      if (!candidates.length) return { status:"empty",excerpts:[] };
      const query = queries.map((text,index) => `${index === 0 && previous ? "上一轮正文" : "玩家最新输入"}：\n${text}`).join("\n\n");
      // Shared adapter enforces a total 120000-character request ceiling.
      const limited = []; let characters = query.length;
      for (const candidate of candidates) if (characters+candidate.content.length <= 120000 && query.length+candidate.content.length <= config.rerank.maxInputCharacters) { limited.push(candidate); characters += candidate.content.length; }
      if (!limited.length) fail("service_input_limit");
      const selected = await this.selectCandidates({ api,query,candidates:limited,minScore:config.rerank.minScore });
      return { status:"ready",excerpts:composeExcerpts(selected,all,settings),partial:allowed.length < eligible.length,queryClipped:raw.some((text,index) => text !== queries[index]),candidates:limited.length };
    } finally { unregister(); unconfigure(); }
  }
}
