import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,rm,readFile,writeFile,readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_SETTINGS,normalizeSettings,normalizeServices,sources,protectedSources,spaceKey,chunkKey } from "./contract.mjs";
import { sliceNarrative,composeExcerpts } from "./passages.mjs";
import { NarrativeHistory,HistoryConfiguration,cancelHistoryOperations } from "./manager.mjs";
import { indexOperation } from "./client.mjs";
const message = (turn,content,revision = 1,role = "assistant") => ({id:`${role}-${turn}`,revision,binding:{turn},data:{role,content}});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),"narrative-history-")); t.after(() => rm(directory,{recursive:true,force:true}));
  let calls = [], failEmbedding = false;
  const server = createServer(async (request,response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const value = JSON.parse(Buffer.concat(chunks).toString()); calls.push({url:request.url,value});
    if (request.url === "/embed" && failEmbedding) { response.writeHead(400); response.end("{}"); return; }
    response.setHeader("content-type","application/json");
    response.end(JSON.stringify(request.url === "/embed" ? {data:value.input.map((text,index) => ({index,embedding:text.includes("承诺") ? [1,0,0] : [0,1,0]}))} : {results:value.documents.map((text,index) => ({index,relevance_score:text.includes("承诺") ? .95 : .1}))}));
  }); server.listen(0,"127.0.0.1"); await once(server,"listening"); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const configuration = new HistoryConfiguration(join(directory,"config"));
  await configuration.save({config:{embedding:{url:`${url}/embed`,model:"synthetic",dimensions:3},rerank:{url:`${url}/rank`,model:"synthetic",minScore:.5}}}); await configuration.test(); calls=[];
  const manager = new NarrativeHistory({directory:join(directory,"session"),configuration});
  return {manager,configuration,calls,fail:() => failEmbedding=true,repair:() => failEmbedding=false,directory};
}
test("many short paragraphs aggregate, preserve exact prose and use bounded overlap",() => {
  const text = Array.from({length:100},(_,i) => `第${i}段。他说：“我记得。”\n\n`).join("");
  const source = sources([message(1,text)])[0], passages = sliceNarrative(source,DEFAULT_SETTINGS);
  assert.ok(passages.length < 6); assert.ok(passages.length > 1);
  for (const passage of passages) { assert.equal(passage.content,text.slice(passage.start,passage.end)); assert.ok(passage.content.length <= DEFAULT_SETTINGS.maxCharacters); }
  for (const match of text.matchAll(/第\d+段/g)) assert.ok(passages.some(p => p.start <= match.index && p.end >= match.index+match[0].length));
});
test("long paragraphs split at sentences without splitting emoji; short tails merge",() => {
  const settings = normalizeSettings({targetCharacters:100,maxCharacters:160,overlapCharacters:20,shortTailCharacters:40});
  const text = "他说😀：“我会回来。”".repeat(40)+"\n\n尾声。";
  const passages = sliceNarrative(sources([message(1,text)])[0],settings);
  assert.ok(passages.length > 2); for (const p of passages) { assert.ok(p.content.length <=160); assert.doesNotMatch(p.content,/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/); }
  assert.equal(passages.at(-1).end,text.length);
  assert.equal(sliceNarrative(sources([message(1,"甲".repeat(100)+"\n\n尾声。")])[0],settings).length,1);
});
test("settings reject invalid lengths and unknown keys, service config remains independent of rerank index space",() => {
  assert.throws(() => normalizeSettings({targetCharacters:900,maxCharacters:800}),/history_settings_invalid/);
  assert.throws(() => normalizeSettings({unknown:true}),/history_settings_invalid/);
  const a = normalizeServices({embedding:{model:"a"}}), b = normalizeServices({embedding:{model:"a"},rerank:{model:"different"}});
  assert.equal(spaceKey(a),spaceKey(b));
  assert.notEqual(spaceKey(a),spaceKey(normalizeServices({embedding:{model:"b"}})));
});
test("protected rounds count only effective assistant sources and exclude player inputs",() => {
  const messages = [message(0,"开场"),message(1,"正文"),message(1,"玩家",1,"user"),message(4,"正文"),message(8,"正文")];
  const view = protectedSources(messages,normalizeSettings({protectRecentTurns:1,protectionMode:"fixed"}));
  assert.deepEqual(view.eligible.map(s => s.turn),[0,1,4]); assert.deepEqual(view.protectedTurns,[8]);
});
test("source indexing is idempotent and CD processes pending effective rounds",async t => {
  const f = await fixture(t), settings = normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0});
  const messages=[message(1,"旧日承诺。")]; await f.manager.index(messages,settings,{force:true}); const calls = f.calls.length;
  await f.manager.index(messages,settings,{force:true}); assert.equal(f.calls.length,calls);
  assert.equal((await f.manager.index([...messages,message(2,"第二轮。")],settings)).status,"cooldown");
  await f.manager.index([...messages,message(2,"第二轮。"),message(3,"第三轮。"),message(4,"第四轮。")],settings);
  assert.equal((await f.manager.status([...messages,message(2,"第二轮。"),message(3,"第三轮。"),message(4,"第四轮。")],settings)).indexedSources,4);
});
test("revision, removed suffix and alternative source IDs cannot enter recall before top-k",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0,candidatesPerQuery:1});
  const old=[message(1,"旧承诺。"),message(2,"另一段承诺。"),message(3,"最近正文。")]; await f.manager.index(old,settings,{force:true});
  const changed=[message(1,"修改后的对白。",2),message(3,"最近正文。"),message(4,"承诺是什么？",1,"user")];
  const result=await f.manager.retrieve(changed,settings,{currentTurn:4,recentCompleteTurns:1}); assert.deepEqual(result.excerpts,[]); assert.equal(result.partial,true);
  const alternative=old.map(item => item.binding.turn===1 ? {...item,id:"another-attempt"} : item).filter(item => item.binding.turn!==2); alternative.push(message(4,"承诺",1,"user"));
  assert.deepEqual((await f.manager.retrieve(alternative,settings,{currentTurn:4,recentCompleteTurns:1})).excerpts,[]);
});
test("dual queries retrieve original details, exclude visible prose, and enforce final budgets",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0,maxResults:1,maxOutputCharacters:128});
  const messages=[message(1,"她抬起右手。\n\n“这是我的承诺。”\n\n他点头。"),message(2,"他看向窗外。"),message(3,"最近正文。"),message(4,"追问承诺的原话。",1,"user")];
  await f.manager.index(messages,settings,{force:true}); f.calls.length=0;
  const result=await f.manager.retrieve(messages,settings,{currentTurn:4,recentCompleteTurns:1});
  assert.equal(result.excerpts.length,1); assert.equal(result.excerpts[0].turn,1); assert.match(result.excerpts[0].content,/“这是我的承诺。”/);
  assert.equal(f.calls.find(call => call.url === "/embed").value.input.length,2); assert.ok(result.excerpts[0].content.length<=128);
});
test("failed source remains uncovered and succeeds after retry, disabled operations make no requests",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0}); const messages=[message(1,"承诺。")];
  f.fail(); await assert.rejects(f.manager.index(messages,settings,{force:true})); assert.equal((await f.manager.status(messages,settings)).indexedSources,0);
  f.repair(); await f.manager.index(messages,settings,{force:true}); assert.equal((await f.manager.status(messages,settings)).indexedSources,1);
  const count=f.calls.length; await f.manager.index(messages,{...settings,enabled:false}); await f.manager.retrieve(messages,{...settings,enabled:false},{currentTurn:2}); assert.equal(f.calls.length,count);
});
test("service secrets stay out of public settings and rerank-only changes reuse encoded sources",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0});
  const saved=await f.configuration.settings(); await f.configuration.save({config:saved.config,embeddingKey:"synthetic-secret"});
  assert.doesNotMatch(JSON.stringify(await f.configuration.publicSettings()),/synthetic-secret/); await f.configuration.test();
  await f.manager.index([message(1,"承诺。")],settings,{force:true}); const count=f.calls.filter(c=>c.url === "/embed").length;
  const newer=await f.configuration.settings(); newer.config.rerank.model="other-reranker"; await f.configuration.save({config:newer.config}); await f.configuration.test();
  const afterTest=f.calls.filter(c=>c.url === "/embed").length;
  await f.manager.index([message(1,"承诺。")],settings,{force:true}); assert.equal(f.calls.filter(c=>c.url === "/embed").length,afterTest); assert.ok(afterTest>count);
});
test("overlapping matches compose once with chronology, exact provenance and per-turn diversity",() => {
  const settings=normalizeSettings({maxPerTurn:1}), all=sources([message(1,"甲。\n\n乙。\n\n丙。"),message(2,"丁。")]);
  const selected=[{sourceKey:all[0].key,turn:1,messageId:all[0].id,revision:1,start:0,end:5,score:.9},{sourceKey:all[0].key,turn:1,messageId:all[0].id,revision:1,start:4,end:11,score:.8},{sourceKey:all[1].key,turn:2,messageId:all[1].id,revision:1,start:0,end:2,score:.7}];
  const result=composeExcerpts(selected,all,settings); assert.deepEqual(result.map(item=>item.turn),[1,2]); assert.equal(result[0].content,all[0].content.slice(result[0].start,result[0].end));
});
test("failed re-encoding keeps usable coverage and concurrent builders share complete-source cache",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0}), messages=[message(1,"承诺。"),message(2,"最近正文。")];
  await f.manager.index(messages,settings,{force:true}); f.fail(); await assert.rejects(f.manager.index(messages,settings,{force:true,rebuild:true}));
  assert.equal((await f.manager.status(messages,settings)).indexedSources,2);
  f.repair(); const count=f.calls.length; await Promise.all([f.manager.index(messages,settings,{force:true}),f.manager.index(messages,settings,{force:true})]); assert.equal(f.calls.length,count);
});
test("cancelling a dispatched embedding preserves an uncovered source for later recovery",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0});
  const originalFetch=globalThis.fetch; let dispatched;
  const waiting=new Promise(resolve=>dispatched=resolve);
  globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{dispatched();options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true});});
  const building=f.manager.index([message(1,"承诺。")],settings,{force:true}); await waiting; cancelHistoryOperations(f.manager.path);
  try { await assert.rejects(building,error=>error.code === "cancelled"); } finally { globalThis.fetch=originalFetch; }
  assert.equal((await f.manager.status([message(1,"承诺。")],settings)).indexedSources,0);
  assert.equal(JSON.parse(await readFile(f.manager.jobPath,"utf8")).status,"cancelled");
});
test("changing configuration cancels an in-flight connection test without certifying the new model",async t => {
  const f=await fixture(t), originalFetch=globalThis.fetch; let dispatched;
  const waiting=new Promise(resolve=>dispatched=resolve);
  globalThis.fetch=async(_url,options)=>new Promise((_resolve,reject)=>{dispatched();options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true});});
  const testing=f.configuration.test(); await waiting;
  try {
    const saved=await f.configuration.settings(); saved.config.embedding.model="replacement";
    const failure=assert.rejects(testing);
    await f.configuration.save({config:saved.config}); await failure;
  } finally { globalThis.fetch=originalFetch; }
  assert.equal((await f.configuration.publicSettings()).verified,false);
  assert.equal((await f.configuration.settings()).config.embedding.model,"replacement");
});
test("corrupt derived cache reports its state and explicit rebuild preserves it for diagnosis",async t => {
  const f=await fixture(t), settings=normalizeSettings({enabled:true,protectionMode:"fixed",protectRecentTurns:0}), messages=[message(1,"旧日承诺。")];
  await f.manager.index(messages,settings,{force:true});
  await writeFile(f.manager.path,"synthetic corrupt database");
  const status=await f.manager.status(messages,settings); assert.equal(status.warningCode,"history_index_corrupt"); assert.equal(status.indexedSources,0);
  const rebuilt=await f.manager.index(messages,settings,{force:true,rebuild:true}); assert.equal(rebuilt.warningCode,"history_index_corrupt_rebuilt");
  assert.equal((await f.manager.status(messages,settings)).indexedSources,1);
  assert.equal((await readdir(f.manager.directory)).filter(name=>name.startsWith("index.sqlite.corrupt-")).length,1);
});
