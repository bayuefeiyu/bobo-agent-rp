import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,mkdir,writeFile,rm} from "node:fs/promises";
import {callRecordPath} from "./rp-call-records.mjs";
import {tmpdir} from "node:os";
import {resolve} from "node:path";
import {createWorkflowsWebBridge} from "./rp-web-workflows-bridge.ts";

test("process record reads one requested call, preserves old records and validates node ownership", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "rp-record-api-")); t.after(() => rm(directory, { recursive:true, force:true }));
  const run = { id:"run", workflowId:"test/flow", workflowTitle:"Flow", nodes:{ node:{ id:"node", status:"running", output:"result" }, legacy:{ id:"legacy", status:"completed" } } };
  const active = { sessionDirectory:directory, workflowEngine:{ snapshot:()=>[run] } };
  const bridge = createWorkflowsWebBridge({scope:{requireChat:()=>active,requireCurrent:()=>active}});
  await mkdir(resolve(directory,"workflow/process-records/run"), {recursive:true});
  await writeFile(callRecordPath(directory,"run","node"), [
    {type:"start",call:{id:"first",request:{messages:[{role:"user",content:"first input"}]},status:"running",attempt:1}},
    {type:"end",id:"first",status:"completed",response:{content:[{type:"text",text:"first response"}]},usage:{input:1,output:2,totalTokens:3}},
    {type:"start",call:{id:"second",request:{messages:[{role:"user",content:"second input"}]},status:"running",attempt:1}},
  ].map(JSON.stringify).join("\n")+"\n");
  await writeFile(resolve(directory,"workflow/process-records/run/legacy.md"),"# Old last exchange");
  const latest = await bridge.getWorkflowNodeProcessRecord("run","node");
  assert.equal(latest.selectedCall.id,"second");
  assert.equal(latest.calls.length,2);
  const summary = await bridge.getWorkflowNodeProcessRecord("run","node","first",true);
  assert.equal(summary.selectedCall,null);
  assert.equal(summary.calls[0].toolEventCount,0);
  assert.ok(latest.calls.every(call=>!call.request&&!call.response&&!call.tools));
  assert.equal((await bridge.getWorkflowNodeProcessRecord("run","node","first")).selectedCall.response.content[0].text,"first response");
  const old = await bridge.getWorkflowNodeProcessRecord("run","legacy");
  assert.equal(old.selectedCall,null); assert.match(old.legacy,/Old/);
  await assert.rejects(bridge.getWorkflowNodeProcessRecord("other-run","node"),error=>error.status===404);
  await assert.rejects(bridge.getWorkflowNodeProcessRecord("run","other-node"),error=>error.status===404);
  await assert.rejects(bridge.getWorkflowNodeProcessRecord("run","node","missing"),error=>error.status===404);
  await writeFile(resolve(directory,"workflow/runs.jsonl"),JSON.stringify(run)+"\n");
  active.workflowEngine.snapshot=()=>[];
  assert.equal((await bridge.getWorkflowNodeProcessRecord("run","node","first")).selectedCall.id,"first");
});

test("module-owned foreground workflows activate, while only manual background entry points run directly",async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),"rp-workflow-activation-")),path=resolve(directory,"settings.json");
  const active={pending:true,context:{isIdle:()=>false},activeWorkflowId:"narrative-controls/standard-rp",cardSettings:{settings:{activeWorkflowId:"narrative-controls/standard-rp"}}};
  const flows=[{id:"narrative-controls/advanced-memory-rp",ownerModuleId:"narrative-controls",kind:"foreground"},{id:"test/manual",ownerModuleId:"test",kind:"global-background",trigger:{type:"manual"}},{id:"test/internal",ownerModuleId:"test",kind:"module-internal"},{id:"test/after-opening",ownerModuleId:"test",kind:"turn-background",trigger:{type:"after-opening"}}];
  const calls=[];
  const bridge=createWorkflowsWebBridge({scope:{requireCurrent:()=>active},configStore:{copyWorkflowToCard:async id=>flows.find(workflow=>workflow.id===id)},cardSettingsPath:path,startManualBackgroundWorkflow:async(id,payload)=>{calls.push({id,payload});return {activated:id};}});
  assert.deepEqual(await bridge.activateWorkflow(flows[0].id,{}),{activated:flows[0].id,startsOnNextInput:true});
  assert.equal(active.activeWorkflowId,flows[0].id);assert.equal(JSON.parse(await readFile(path,"utf8")).settings.activeWorkflowId,flows[0].id);
  await bridge.activateWorkflow("test/manual",{payload:{reason:"user action"}});
  assert.deepEqual(calls,[{id:"test/manual",payload:{reason:"user action"}}]);
  for(const id of ["test/internal","test/after-opening"])await assert.rejects(bridge.activateWorkflow(id,{}),error=>error.status===400);
  assert.equal(active.activeWorkflowId,flows[0].id);assert.equal(calls.length,1);
});
