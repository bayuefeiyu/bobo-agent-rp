import test from "node:test";
import assert from "node:assert/strict";
import { discoverModelList } from "./rp-model-discovery.mjs";

test("Gemini native model discovery authenticates by header, follows pages and excludes embedding models",async()=>{
  const requests=[];
  const result=await discoverModelList({baseUrl:"https://fixture.invalid/v1beta",api:"google-generative-ai",apiKey:"fixture-key",fetchImpl:async(url,options)=>{
    requests.push({url,options});return {ok:true,json:async()=>requests.length===1?{models:[{name:"models/gemini-a",supportedGenerationMethods:["generateContent"]},{name:"models/embedding",supportedGenerationMethods:["embedContent"]}],nextPageToken:"next"}:{models:[{name:"models/gemini-b",supportedGenerationMethods:["generateContent"]}]}};
  }});
  assert.deepEqual(result.models,["gemini-a","gemini-b"]);
  assert.equal(requests[0].options.headers["x-goog-api-key"],"fixture-key");assert.equal(requests[0].options.headers.authorization,undefined);
  assert.equal(new URL(requests[1].url).searchParams.get("pageToken"),"next");assert.ok(!requests[0].url.includes("fixture-key"));
});
test("Anthropic native discovery uses v1 models and after_id pagination",async()=>{
  const requests=[];
  const result=await discoverModelList({baseUrl:"https://fixture.invalid",api:"anthropic-messages",apiKey:"fixture-key",fetchImpl:async(url,options)=>{
    requests.push({url,options});return {ok:true,json:async()=>requests.length===1?{data:[{id:"claude-a"}],has_more:true,last_id:"claude-a"}:{data:[{id:"claude-b"}],has_more:false}};
  }});
  assert.deepEqual(result.models,["claude-a","claude-b"]);assert.equal(new URL(requests[0].url).pathname,"/v1/models");
  assert.equal(new URL(requests[1].url).searchParams.get("after_id"),"claude-a");assert.equal(requests[0].options.headers["x-api-key"],"fixture-key");
  assert.equal(requests[0].options.headers["anthropic-version"],"2023-06-01");
});
test("DashScope native model discovery reads output.models model IDs and totals",async()=>{
  const requests=[];
  const result=await discoverModelList({baseUrl:"https://fixture.invalid/api/v1",api:"dashscope-generation",apiKey:"fixture-key",fetchImpl:async(url,options)=>{
    requests.push({url,options});return {ok:true,json:async()=>({output:{total:2,models:[{model:requests.length===1?"qwen-a":"qwen-b",name:"Display name"}]}})};
  }});
  assert.deepEqual(result.models,["qwen-a","qwen-b"]);assert.equal(new URL(requests[1].url).searchParams.get("page_no"),"2");
  assert.equal(new URL(requests[0].url).pathname,"/api/v1/models");assert.equal(requests[0].options.headers.authorization,"Bearer fixture-key");
});
test("model listing rejects non-advancing native pagination",async()=>{
  await assert.rejects(discoverModelList({baseUrl:"https://fixture.invalid/v1beta",api:"google-generative-ai",fetchImpl:async()=>({ok:true,json:async()=>({models:[{name:"models/a"}],nextPageToken:"repeat"})})}),/分页未前进/);
});
