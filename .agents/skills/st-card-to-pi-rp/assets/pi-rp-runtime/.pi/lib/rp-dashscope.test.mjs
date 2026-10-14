import test from "node:test";
import assert from "node:assert/strict";
import { dashScopePayload, streamDashScope } from "./rp-dashscope.mjs";

const model={id:"qwen-test",name:"Test",provider:"fixture",api:"dashscope-generation",baseUrl:"https://fixture.invalid/api/v1",reasoning:true,maxTokens:128};
test("DashScope native payload preserves system updates, current tools and tool-result bindings",()=>{
  const payload=dashScopePayload(model,{messages:[
    {role:"system",content:"Base",sections:{mode:"Old"},toolsAdded:[{name:"removed",parameters:{}}]},
    {role:"system",content:"Later",sections:{mode:"New"},toolsRemoved:[{name:"removed"}],toolsAdded:[{name:"read",description:"Read",parameters:{type:"object"}}]},
    {role:"user",content:"hello"},
    {role:"assistant",content:[{type:"thinking",thinking:"Plan"},{type:"toolCall",id:"call-1",name:"read",arguments:{id:1}}]},
    {role:"toolResult",toolCallId:"call-1",content:[{type:"text",text:"result"}]},
  ]},{maxTokens:64,reasoning:"high"});
  assert.equal(payload.input.messages[0].content,"Base\n\nLater\n\nNew");
  assert.deepEqual(payload.parameters.tools.map(tool=>tool.function.name),["read"]);
  assert.equal(payload.input.messages[2].tool_calls[0].function.arguments,'{"id":1}');
  assert.equal(payload.input.messages[2].reasoning_content,"Plan");
  assert.deepEqual(payload.input.messages[3],{role:"tool",tool_call_id:"call-1",content:"result"});
  assert.equal(payload.parameters.max_tokens,64);assert.equal(payload.parameters.enable_thinking,true);
});
test("DashScope native SSE returns tools, reasoning, usage and valid Pi events",async t=>{
  const requests=[],hooks=[];let payloadHook=false,responseHook=false;
  t.mock.method(globalThis,"fetch",async(url,options)=>{
    requests.push({url,options});const events=[
      {output:{choices:[{message:{reasoning_content:"Plan",content:""}}]}},
      {output:{choices:[{message:{tool_calls:[{index:0,id:"call-1",function:{name:"read",arguments:'{"id":'}}]}}]}},
      {output:{choices:[{finish_reason:"tool_calls",message:{tool_calls:[{index:0,function:{arguments:'1}'}}]}}]},usage:{input_tokens:8,output_tokens:3,total_tokens:11}},
    ];return new Response(events.map(event=>"data: "+JSON.stringify(event)+"\r\n\r\n").join(""),{headers:{"content-type":"text/event-stream"}});
  });
  const stream=streamDashScope(model,{systemPrompt:"System",messages:[{role:"user",content:"hello"}]},{apiKey:"fixture-key",onPayload:payload=>{payloadHook=true;return payload;},onResponse:()=>{responseHook=true;},onProviderStreamEvent:event=>hooks.push(event)});
  const events=[];for await(const event of stream)events.push(event);
  const result=await stream.result();assert.equal(result.stopReason,"toolUse");assert.equal(result.content[0].thinking,"Plan");
  assert.deepEqual(result.content[1],{type:"toolCall",id:"call-1",name:"read",arguments:{id:1}});
  assert.equal(result.usage.totalTokens,11);assert.equal(events.at(-1).type,"done");assert.ok(events.some(event=>event.type==="toolcall_end"));
  assert.equal(requests[0].url,"https://fixture.invalid/api/v1/services/aigc/text-generation/generation");
  assert.equal(requests[0].options.headers.authorization,"Bearer fixture-key");assert.equal(requests[0].options.headers["X-DashScope-SSE"],"enable");
  assert.ok(payloadHook&&responseHook);assert.equal(hooks.length,3);
});
test("DashScope multimodal uses native content and endpoint, without Chat Completions",async t=>{
  const requests=[];t.mock.method(globalThis,"fetch",async(url,options)=>{requests.push({url,options});return new Response(JSON.stringify({output:{choices:[{finish_reason:"stop",message:{content:[{text:"reply"}]}}]},usage:{input_tokens:2,output_tokens:1}}),{headers:{"content-type":"application/json"}});});
  const multimodal={...model,api:"dashscope-multimodal"};
  const response=await streamDashScope(multimodal,{messages:[{role:"user",content:[{type:"text",text:"describe"},{type:"image",mimeType:"image/png",data:"fixture"}]}]},{apiKey:"fixture-key"}).result();
  assert.equal(response.content[0].text,"reply");assert.ok(requests[0].url.endsWith("/multimodal-generation/generation"));
  assert.deepEqual(JSON.parse(requests[0].options.body).input.messages[0].content,[{text:"describe"},{image:"data:image/png;base64,fixture"}]);
});
test("DashScope rejects incomplete replies and honors cancellation",async t=>{
  t.mock.method(globalThis,"fetch",async()=>new Response(JSON.stringify({output:{choices:[{message:{content:"partial"}}]}}),{headers:{"content-type":"application/json"}}));
  assert.equal((await streamDashScope(model,{messages:[]}).result()).stopReason,"error");
  const controller=new AbortController();controller.abort();
  t.mock.method(globalThis,"fetch",async(_url,options)=>{options.signal.throwIfAborted();});
  assert.equal((await streamDashScope(model,{messages:[]},{signal:controller.signal}).result()).stopReason,"aborted");
});
