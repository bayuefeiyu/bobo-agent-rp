import assert from "node:assert/strict";
import test from "node:test";
import { RpWorkflowEngine } from "./rp-workflow-engine.mjs";

const flow=(nodes=[{id:"write",type:"agent",agentId:"test/writer"}],defaults={})=>({schemaVersion:4,ownerModuleId:"test",id:"test/assignments",kind:"global-background",defaults,nodes});
const agent=(id,defaultModelId)=>({id,defaultModelId,tools:[]});
const fallbackPolicy={modelFailure:{silentFallback:true,defaultFallbackModelId:"backup"}};
function engine({agents={"test/writer":agent("test/writer","primary")},models=["primary","backup"],...options}={}){
  return new RpWorkflowEngine({resolveAgent:async id=>agents[id]||null,resolveModel:async id=>models.includes(id)?{id,provider:"fixture",model:id,maxConcurrency:2}:null,executor:async()=>({output:"ok"}),...options});
}
async function run(instance,workflow=flow()) {const started=await instance.start(workflow);return instance.wait(started.id);}

test("ordinary nodes use Agent assignment even when legacy node and workflow models differ",async()=>{
  let actual;
  const instance=engine({executor:async task=>{actual=task.binding.modelId;return {output:"ok"};}});
  const completed=await run(instance,flow([{id:"write",type:"agent",agentId:"test/writer",modelId:"node-old"}],{modelId:"workflow-old"}));
  assert.equal(completed.status,"completed");assert.equal(actual,"primary");
  assert.equal(instance.runs.get(completed.id).workflow.nodes[0].modelId,undefined);
  assert.equal(instance.runs.get(completed.id).workflow.defaults.modelId,undefined);
});

test("missing Agent fails even with fallback enabled; control nodes require no model",async()=>{
  const missing=await run(engine({policy:fallbackPolicy}),flow([{id:"write",type:"agent"}]));
  assert.equal(missing.status,"failed");assert.match(missing.nodes.write.error,/未指定 Agent/);assert.equal(missing.modelFallbacks,undefined);
  const control=await run(engine(),flow([{id:"code",type:"code"}]));
  assert.equal(control.status,"completed");assert.equal(control.nodes.code.attempts[0].modelId,null);
});

test("unassigned and missing models report configuration errors with fallback disabled",async()=>{
  for(const value of [null,"missing"]){
    let calls=0;
    const completed=await run(engine({agents:{"test/writer":agent("test/writer",value)},executor:async()=>{calls++;return {};}}));
    assert.equal(completed.status,"failed");assert.equal(calls,0);
    assert.equal(completed.nodes.write.failureCode,"model_configuration_invalid");
    assert.equal(completed.nodes.write.attempts[0].modelId,value);
    assert.equal(completed.modelFallbacks,undefined);
  }
});

test("fallback handles missing assignments and records original model, reason and actual binding",async()=>{
  for(const value of [null,"missing"]){
    const agents={"test/writer":agent("test/writer",value)};
    const completed=await run(engine({agents,policy:fallbackPolicy}));
    assert.equal(completed.status,"completed");assert.equal(completed.nodes.write.attempts[0].modelId,"backup");
    assert.equal(completed.modelFallbacks[0].fromModelId,value);
    assert.equal(completed.modelFallbacks[0].toModelId,"backup");
    assert.ok(completed.modelFallbacks[0].reason);
    assert.equal(completed.nodes.write.attempts[0].modelFallback.toModelId,"backup");
    assert.equal(agents["test/writer"].defaultModelId,value);
  }
});

test("provider failure exhausts primary retries then tries backup once without a switch loop",async()=>{
  const calls=[];
  const completed=await run(engine({policy:fallbackPolicy,executor:async task=>{calls.push(task.binding.modelId);task.markModelDispatched();throw new Error("provider offline");}}),flow([{id:"write",type:"agent",agentId:"test/writer",retry:{maxAttempts:2}}]));
  assert.deepEqual(calls,["primary","primary","backup"]);
  assert.equal(completed.status,"awaiting-model-choice");assert.equal(completed.modelFallbacks.length,1);
  assert.equal(completed.nodes.write.attempts.at(-1).modelFallback.toModelId,"backup");
});

test("configuration faults in tools, context and node commits do not trigger model fallback",async()=>{
  for(const kind of ["tool","context","commit"]){
    const options=kind==="commit"?{beforeNodeComplete:async()=>{throw new Error("commit failed");}}:{executor:async task=>{if(kind==="tool")task.markModelDispatched();throw Object.assign(new Error(kind),kind==="tool"?{code:"tool_schema_invalid"}:{});}};
    const completed=await run(engine({policy:fallbackPolicy,...options}));
    assert.equal(completed.modelFallbacks,undefined,kind);
    assert.equal(completed.nodes.write.attempts.length,1,kind);
  }
});

test("pre-dispatch model configuration errors can use backup without disguising workflow errors",async()=>{
  const calls=[];
  const completed=await run(engine({policy:fallbackPolicy,executor:async task=>{
    calls.push(task.binding.modelId);
    if(task.binding.modelId==="primary")throw Object.assign(new Error("invalid endpoint"),{code:"model_configuration_invalid"});
    return {output:"backup response"};
  }}));
  assert.equal(completed.status,"completed");assert.deepEqual(calls,["primary","backup"]);
  assert.equal(completed.modelFallbacks[0].reason,"invalid endpoint");
});

const teamFlow=()=>flow([{id:"meeting",type:"team",retry:{maxAttempts:1},team:{schemaVersion:1,leader:{id:"leader",agentId:"test/leader",modelId:"legacy"},secretary:{id:"secretary",agentId:"test/secretary",modelId:"legacy"},experts:[],assistants:[{id:"helper",kind:"agent",agentId:"test/helper",modelId:"legacy",publicDescription:{title:"Helper"}}]}}]);

test("meeting members and Agent assistants ignore legacy per-use models and freeze Agent bindings",async()=>{
  const agents=Object.fromEntries(["leader","secretary","helper"].map(id=>["test/"+id,agent("test/"+id,id)])),calls=[];
  const instance=engine({agents,models:["leader","secretary","helper"],executor:async task=>{
    if(task.node.type==="team"){
      agents["test/leader"].defaultModelId="edited-during-meeting";
      for(const id of ["leader","secretary","helper"])await task.invokeAgent({memberId:id,freezeKey:(id==="helper"?"assistant:":"member:")+id,agentId:"test/"+id,modelId:"legacy",executionId:id});
    }else calls.push([task.agent.id,task.binding.modelId]);
    return {output:"ok"};
  }});
  const completed=await run(instance,teamFlow());
  assert.equal(completed.status,"completed");assert.deepEqual(calls,[["test/leader","leader"],["test/secretary","secretary"],["test/helper","helper"]]);
});

test("team fallback changes only the failed member and preserves the other frozen model",async()=>{
  const agents={"test/leader":agent("test/leader","primary"),"test/secretary":agent("test/secretary","secretary"),"test/helper":agent("test/helper","primary")},calls=[];
  const completed=await run(engine({agents,models:["primary","backup","secretary"],policy:fallbackPolicy,executor:async task=>{
    if(task.node.type==="team"){
      for(const id of ["leader","secretary"])await task.invokeAgent({memberId:id,freezeKey:"member:"+id,agentId:"test/"+id,executionId:id});
    }else{calls.push([task.agent.id,task.binding.modelId]);task.markModelDispatched();if(task.binding.modelId==="primary")throw new Error("primary offline");}
    return {output:"ok"};
  }}),teamFlow());
  assert.equal(completed.status,"completed");assert.deepEqual(calls,[["test/leader","primary"],["test/leader","backup"],["test/secretary","secretary"]]);
  assert.equal(completed.modelFallbacks[0].memberId,"member:leader");
  assert.equal(completed.teamMemberBindings["member:leader"].resolvedModelId,"backup");
});

test("an invalid backup reports failure without invoking an implicit Pi model",async()=>{
  const completed=await run(engine({agents:{"test/writer":agent("test/writer",null)},models:[],policy:fallbackPolicy}));
  assert.equal(completed.status,"failed");assert.match(completed.nodes.write.error,/兜底模型 backup/);
  assert.equal(completed.nodes.write.attempts[0].modelId,null);
});
