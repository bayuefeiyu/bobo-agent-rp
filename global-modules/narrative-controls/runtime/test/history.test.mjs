import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { normalizeWorkflowDefinition } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs";
import { normalizeDataContract } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-contracts.mjs";
import { normalizeModuleFrontendView } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-module-frontend.mjs";
import { moduleCatalogEntry } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-config-catalog.mjs";
import { RpDataStore } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-store.mjs";
import { assertNarrativeHistoryAccess,createNarrativeHistoryService } from "../../../../.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-narrative-history.mjs";
import { createApplication } from "../../../../packages/rp-web-server/index.mjs";
import { execute } from "../prepare-history-recall.mjs";
const directory=fileURLToPath(new URL("../../",import.meta.url)), json=path=>readFile(join(directory,path),"utf8").then(JSON.parse);
test("history workflows normalize, remain code-only and explicitly hand excerpts to both writers",async()=>{
  const module=await json("module.json"), contract=normalizeDataContract(await json("data-contract.json"));
  const view=normalizeModuleFrontendView(await json("frontend-view.json"),contract);
  assert.ok(view.regions.some(region=>region.id === "history-recall"));
  for(const path of module.workflowFiles) normalizeWorkflowDefinition(await json(path));
  for(const name of ["standard-rp","advanced-memory-rp"]) {
    const workflow=normalizeWorkflowDefinition(await json(`workflows/${name}/workflow.json`));
    const writer=workflow.nodes.find(node=>node.id === "write-narrative"), call=workflow.nodes.find(node=>node.id === "prepare-history-recall");
    assert.ok(writer.context.fromNodes.includes(call.id)); assert.ok(writer.dependsOn.includes(call.id)); assert.equal(call.workspaceHandoff.include[0].output,"excerpts");
    assert.ok(!writer.runtimeServices.includes("narrativeHistory")); assert.ok(!writer.workflowCalls.some(ref=>(ref.target ?? ref).includes("history")));
  }
  const target=await json("workflows/prepare-history-recall/workflow.json"); assert.equal(target.agentCallable,false);
  assert.throws(()=>normalizeWorkflowDefinition({...target,ownerModuleId:"other"}),/narrativeHistory/);
  assert.throws(()=>assertNarrativeHistoryAccess(target,{type:"agent",runtimeServices:["narrativeHistory"]}),/not granted/);
});
test("history defaults and per-record profile overrides initialize the correct settings without touching prose preferences",async t=>{
  const root=await mkdtemp(join(tmpdir(),"rp-history-settings-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const contract=normalizeDataContract(await json("data-contract.json")), view=normalizeModuleFrontendView(await json("frontend-view.json"),contract);
  const entry=await moduleCatalogEntry({module:{id:"narrative-controls",contract,view},readDocument:json});
  const field=entry.fields.find(item=>item.label === "启用历史原文回顾"); assert.equal(field.path,"/$records/settings/narrative-history-settings/enabled");
  assert.equal(entry.base.$records.settings["narrative-history-settings"].enabled,false);
  const store=new RpDataStore({sessionDirectory:root,modules:[{contract,moduleDirectory:directory}],initialOverrides:{"narrative-controls":{$records:{settings:{"narrative-history-settings":{enabled:true,indexEveryTurns:5}}}}}}); await store.initialize();
  const records=(await store.readCollection("narrative-controls","settings")).records;
  assert.equal(records.find(item=>item.id === "narrative-history-settings").data.indexEveryTurns,5); assert.equal(records.find(item=>item.id === "narrative-history-settings").data.enabled,true);
  assert.deepEqual(records.find(item=>item.id === "narrative-preferences").data,(await json("collections/settings/initial/snapshot.json"))[0].data);
});
test("history document exports original prose and historical interpretation without scores or diagnostics",async t=>{
  const root=await mkdtemp(join(tmpdir(),"rp-history-export-")); t.after(()=>rm(root,{recursive:true,force:true}));
  await execute({workspace:root,services:{narrativeHistory:{retrieve:async()=>({status:"ready",queryClipped:true,candidates:60,excerpts:[{turn:7,content:"她说：“我记得那天的承诺。”",score:.99,messageId:"private-id"}]})}}});
  const content=await readFile(join(root,"history-recall/excerpts.md"),"utf8"); assert.match(content,/第 7 轮/); assert.match(content,/我记得那天的承诺/); assert.match(content,/历史中的状态不自动等于当前状态/); assert.doesNotMatch(content,/score|private-id|queryClipped|0.99/);
  assert.match(await readFile(join(root,"history-recall/DOCUMENTS.md"),"utf8"),/readPolicy: `required`/);
});
test("unconfigured optional retrieval degrades with a user-only diagnostic, permission errors stay explicit",async t=>{
  const root=await mkdtemp(join(tmpdir(),"rp-history-unconfigured-")), previous=process.env.BOBO_AGENT_RP_USER_CONFIG_DIR; process.env.BOBO_AGENT_RP_USER_CONFIG_DIR=join(root,"config");
  t.after(async()=>{if(previous === undefined) delete process.env.BOBO_AGENT_RP_USER_CONFIG_DIR; else process.env.BOBO_AGENT_RP_USER_CONFIG_DIR=previous; await rm(root,{recursive:true,force:true});});
  const service=await createNarrativeHistoryService({workflow:{ownerModuleId:"narrative-controls"},node:{type:"code",runtimeServices:["narrativeHistory"]},run:{id:"synthetic",turn:2},messages:[],settings:{enabled:true},sessionDirectory:join(root,"session"),recentCompleteTurns:5,isEnabled:async()=>true});
  assert.deepEqual((await service.retrieve()).excerpts,[]); const diagnostic=JSON.parse(await readFile(join(root,"session/derived/narrative-history/requests/synthetic.json"),"utf8")); assert.equal(diagnostic.errorCode,"history_configuration_incomplete");
});
test("history configuration endpoints enforce the existing token and use independent operations",async t=>{
  const fetch = async (path, options) => {
    const url = new URL(path);
    const connection = (await globalThis.fetch(new URL("/api/v1/connection", url)).then(response => response.json())).data;
    url.searchParams.set("readContext", JSON.stringify(connection.readContext));
    return globalThis.fetch(url, options);
  };
  const calls=[], bridge={historyServiceManagement:async(operation,value)=>{calls.push({operation,value});return {ok:true};},authorizeConfigMutation:async token=>{if(token!=="synthetic-token") throw Object.assign(new Error("Invalid token"),{status:403});}};
  const server=createServer(createApplication({cardStore:{},bridge}));server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/v1/config/narrative-history`;
  assert.equal((await fetch(`${base}/config`)).status,200); assert.equal(calls[0].operation,"settings");calls.length=0;
  for(const [route,method] of [["config","PUT"],["test","POST"]]) assert.equal((await fetch(`${base}/${route}`,{method,headers:{"content-type":"application/json"},body:"{}"})).status,403);
  assert.equal(calls.length,0);assert.equal((await fetch(`${base}/test`,{method:"POST",headers:{"content-type":"application/json","x-rp-config-token":"synthetic-token"},body:"{}"})).status,200); assert.equal(calls[0].operation,"test");
});
