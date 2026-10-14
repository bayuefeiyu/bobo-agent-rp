import { createRpClient } from "../packages/rp-web-client/index.mjs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { cp,mkdir,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { packageCardRuntime } from "../.agents/skills/st-card-to-pi-rp/scripts/package_card_runtime.mjs";

test("packaged narrative module runs optional recall, background indexing and exact historical delivery independently",{timeout:30000},async t=>{
  const root=await mkdtemp(join(tmpdir(),"rp-history-delivery-")), source=join(root,"draft"), target=join(root,"cards","fixture");
  const env={BOBO_RP_CARD_ID:"fixture",BOBO_RP_READY_FILE:join(root,"ready.json"),BOBO_AGENT_RP_CACHE_DIR:join(root,"cache"),BOBO_AGENT_RP_USER_CONFIG_DIR:join(root,"config")};
  const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]])); Object.assign(process.env,env);
  let host; const calls=[];
  const server=createServer(async(request,response)=>{
    const chunks=[]; for await(const chunk of request) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks)); calls.push({url:request.url,body}); response.setHeader("content-type","application/json");
    response.end(JSON.stringify(request.url === "/embed" ? {data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))} : {results:body.documents.map((_,index)=>({index,relevance_score:.9}))}));
  }); server.listen(0,"127.0.0.1"); await once(server,"listening");
  t.after(async()=>{
    if(host) await host.stopBridge(); await new Promise(resolve=>server.close(resolve));
    for(const [key,value] of Object.entries(saved)) { if(value === undefined) delete process.env[key]; else process.env[key]=value; }
    await rm(root,{recursive:true,force:true});
  });
  const json=async(path,value)=>{await mkdir(join(path,".."),{recursive:true});await writeFile(path,JSON.stringify(value));};
  const directory=join(source,"features","narrative-controls"); await cp(resolve("global-modules/narrative-controls"),directory,{recursive:true});
  const module=JSON.parse(await readFile(join(directory,"module.json"),"utf8")); module.agentFiles=[];
  module.workflowFiles=["workflows/offline-turn/workflow.json","workflows/prepare-history-recall/workflow.json","workflows/index-history-after-standard/workflow.json","workflows/maintain-history-index/workflow.json"];
  await json(join(directory,"module.json"),module);
  await rm(join(directory,"agents"),{recursive:true,force:true});
  for(const name of ["advanced-memory-rp","standard-rp","compose-context","index-history-after-advanced"]) await rm(join(directory,"workflows",name),{recursive:true,force:true});
  // The real narrative data/settings/recall/index workflows remain intact; only the model writer is replaced.
  const view=JSON.parse(await readFile(join(directory,"frontend-view.json"),"utf8"));
  view.regions=view.regions.filter(region=>region.id === "history-recall" || region.id === "history-maintenance"); await json(join(directory,"frontend-view.json"),view);
  const index=JSON.parse(await readFile(join(directory,"workflows/index-history-after-standard/workflow.json"),"utf8")); index.trigger.workflowId="narrative-controls/offline-turn"; await json(join(directory,"workflows/index-history-after-standard/workflow.json"),index);
  await json(join(directory,"workflows/offline-turn/workflow.json"),{
    schemaVersion:4,id:"offline-turn",ownerModuleId:module.id,title:"Offline historical delivery",kind:"foreground",trigger:{type:"manual"},turnContext:{recentCompleteTurns:1},
    nodes:[{id:"compose",type:"code",metadata:{entryFile:"runtime/offline-turn.mjs"},workflowCalls:["narrative-controls/prepare-history-recall"],outputs:{narrative:{path:"narrative.md",format:"narrative",scope:"workflow",retain:"run"}},narrativeSource:{layer:"story"}},
      {id:"commit",type:"turn-finalize",dependsOn:["compose"],narrative:{fromNode:"compose",output:"narrative"}}]
  });
  await writeFile(join(directory,"runtime/offline-turn.mjs"),`import {readFile,writeFile} from "node:fs/promises";import {join} from "node:path";
export async function execute({run,workspace,calls}) {
 const result=await calls.invoke({workflow:"narrative-controls/prepare-history-recall",arguments:{},outputPaths:{excerpts:"history"}});
 const text=await readFile(join(workspace,result.outputs.excerpts,"excerpts.md"),"utf8");
 await writeFile(join(workspace,"narrative.md"),"Current prose: "+run.payload.currentInput+"\\n\\n"+text); return {delivered:true};
}`);
  await json(join(source,"manifest.json"),{schema_version:2,id:"fixture",name:"History fixture",fixed_context:"core/foundation.md",context_policy:"context/retrieval-policy.json",context_processors:[],feature_modules:["features/narrative-controls/module.json"],openings:[{id:"opening-00",title:"Opening",file:"openings/00.md",source:"first_mes"}],default_opening:"opening-00"});
  await json(join(source,"settings.json"),{schemaVersion:1,cardId:"fixture",settings:{activeWorkflowId:"narrative-controls/offline-turn"}});
  await json(join(source,"context/retrieval-policy.json"),{schemaVersion:2,source:"messages",code:{profile:"default"},agent:{mode:"disabled",fallback:"code",onNotTriggered:"code",maxRecords:100}});
  await mkdir(join(source,"core")); await writeFile(join(source,"core/foundation.md"),"Offline foundation.");
  await mkdir(join(source,"openings")); await writeFile(join(source,"openings/00.md"),"---\nid: opening-00\ntitle: Opening\n---\n\nShe raised her right hand.\n\n\"I will return at dawn.\"");
  await packageCardRuntime({sourceCard:source,targetCard:target}); await cp(resolve("node_modules/typebox"),join(root,"node_modules/typebox"),{recursive:true});
  const {createRpHostSession}=await import(pathToFileURL(join(target,"runtime/engine/lib/rp-host-session.ts")).href);
  const pi={registerTool:()=>{},registerCommand:()=>{},on:()=>{},registerProvider:()=>assert.fail("Must not register a model"),sendUserMessage:()=>assert.fail("Must not prompt a model")};
  host=createRpHostSession(pi); host.register(pi);
  const url=await host.startBridge("fixture",{cwd:root,isIdle:()=>true,model:null,modelRegistry:{find:()=>null},sessionManager:{getSessionId:()=>"history-chat",getSessionFile:()=>null},ui:{notify:()=>{}}});
  let token = "";
  const client = createRpClient({ baseUrl: url, auth: () => ({ "x-rp-config-token": token }) }); await client.connect();
  token = (await client.request("config/context")).token;
  const request = async(path, method="GET", body) => { if (method !== "GET" && body) body = { operationId: randomUUID(), ...body }; return client.request(path, { method, body }); };
  t.after(() => client.dispose());
  assert.equal((await request("/api/v1/config/narrative-history/status")).sessionAvailable,false);
  await request("/api/v1/opening","POST",{openingId:"opening-00"});
  const engine=host.scope.requireCurrent().workflowEngine;
  const play=async(content,turn)=>{
    await request("/api/v1/input","POST",{content});
    const run=engine.snapshot().find(item=>item.workflowId === "narrative-controls/offline-turn" && item.turn === turn);
    assert.ok(run); const result=await engine.wait(run.id); assert.equal(result.status,"completed",result.error);
    const background=engine.snapshot().find(item=>item.workflowId === index.ownerModuleId+"/"+index.id && item.turn === turn);
    assert.ok(background,"Real after-workflow history indexing must be scheduled"); const finished=await engine.wait(background.id);assert.equal(finished.status,"completed",finished.error);
  };
  await play("First turn",1); assert.equal(calls.length,0,"Disabled history must make no service requests");
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  await request("/api/v1/config/narrative-history/config","PUT",{config:{embedding:{url:endpoint+"/embed",model:"synthetic",dimensions:3},rerank:{url:endpoint+"/rank",model:"synthetic"}}});
  await request("/api/v1/config/narrative-history/test","POST",{}); calls.length=0;
  const route="/api/v1/modules/narrative-controls/bindings/history-recall/settings", settings=await request(route);
  const updated=await request(route,"PUT",{expectedRevision:settings.record.revision,values:{"/enabled":true,"/protectionMode":"fixed","/protectRecentTurns":0,"/indexEveryTurns":1}});
  assert.equal(updated.indexStartError,undefined);
  const maintenance=engine.snapshot().find(item=>item.workflowId === "narrative-controls/maintain-history-index"); assert.ok(maintenance,"Enabling triggers catch-up"); const maintained=await engine.wait(maintenance.id); assert.equal(maintained.status,"completed"); assert.notEqual(maintained.nodes.index.output?.status,"disabled",JSON.stringify(maintained));
  let status=await request("/api/v1/config/narrative-history/status");assert.equal(status.indexedSources,2,JSON.stringify({status,maintenance,updated}));assert.equal(status.pendingSources,0);
  await play("What exactly did she promise?",2);
  const state=await request("/api/v1/state"), prose=state.messages.at(-1).content;
  assert.match(prose,/I will return at dawn/);assert.match(prose,/She raised her right hand/);
  const rank=calls.find(call=>call.url === "/rank"); assert.ok(rank); assert.equal(rank.body.documents.length,1,"Currently visible previous prose is excluded before recall");
  assert.equal(calls.find(call=>call.url === "/embed" && call.body.input.length === 2).body.input[1],"What exactly did she promise?");
  status=await request("/api/v1/config/narrative-history/status");assert.equal(status.indexedSources,3);assert.equal(status.pendingSources,0);
});
