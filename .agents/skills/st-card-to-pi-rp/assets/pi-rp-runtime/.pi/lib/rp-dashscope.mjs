import { randomUUID } from "node:crypto";

export function isDashScope(api) { return api==="dashscope-generation"||api==="dashscope-multimodal"; }
const text=content=>typeof content==="string"?content:(content||[]).filter(part=>part.type==="text").map(part=>part.text).join("\n");
function nativeContent(content,multimodal) {
  if(!multimodal){if(Array.isArray(content)&&content.some(part=>part.type==="image"))throw new Error("图像输入需使用 DashScope 多模态格式。");return text(content);}
  if(typeof content==="string")return [{text:content}];
  return (content||[]).flatMap(part=>part.type==="text"?[{text:part.text}]:part.type==="image"?[{image:`data:${part.mimeType};base64,${part.data}`}]:[]);
}
export function dashScopePayload(model,context,options={}) {
  const multimodal=model.api==="dashscope-multimodal",systems=[],sections=new Map(),tools=new Map((context.tools||[]).map(tool=>[tool.name,tool]));
  if(context.systemPrompt)systems.push(context.systemPrompt);
  for(const message of context.messages||[])if(message.role==="system"){
    if(text(message.content))systems.push(text(message.content));
    for(const [name,value]of Object.entries(message.sections||{})){if(value===null)sections.delete(name);else sections.set(name,value);}
    for(const tool of message.toolsRemoved||[])tools.delete(tool.name);
    for(const tool of message.toolsAdded||[])tools.set(tool.name,tool);
  }
  const messages=[],system=[...systems,...sections.values()].join("\n\n");
  if(system)messages.push({role:"system",content:nativeContent(system,multimodal)});
  for(const message of context.messages||[]){
    if(message.role==="system")continue;
    if(message.role==="user")messages.push({role:"user",content:nativeContent(message.content,multimodal)});
    else if(message.role==="assistant"){
      if(["error","aborted"].includes(message.stopReason))continue;
      const calls=(message.content||[]).filter(part=>part.type==="toolCall").map(call=>({id:call.id,type:"function",function:{name:call.name,arguments:JSON.stringify(call.arguments)}}));
      const thinking=(message.content||[]).filter(part=>part.type==="thinking").map(part=>part.thinking).join("\n");
      messages.push({role:"assistant",content:nativeContent(message.content,multimodal),...(calls.length?{tool_calls:calls}:{}),...(thinking?{reasoning_content:thinking}:{})});
    }else if(message.role==="toolResult"){
      if((message.content||[]).some(part=>part.type==="image"))throw new Error("DashScope 原生工具结果仅支持文本，请通过多模态用户消息提供图像。");
      messages.push({role:"tool",tool_call_id:message.toolCallId,content:text(message.content)});
    }else throw new Error(`Unsupported DashScope message role: ${message.role}`);
  }
  const parameters={result_format:"message",incremental_output:true,max_tokens:options.maxTokens||model.maxTokens};
  if(options.temperature!==undefined)parameters.temperature=options.temperature;
  if(options.topP!==undefined)parameters.top_p=options.topP;
  if(model.reasoning)parameters.enable_thinking=options.reasoning!=="off";
  if(tools.size)parameters.tools=[...tools.values()].map(tool=>({type:"function",function:{name:tool.name,description:tool.description||"",parameters:tool.parameters}}));
  return {model:model.id,input:{messages},parameters};
}

async function* nativeEvents(response) {
  if(!response.headers.get("content-type")?.includes("text/event-stream")){yield await response.json();return;}
  if(!response.body)throw new Error("DashScope returned an empty response body.");
  const decoder=new TextDecoder();let buffer="",data=[];
  const parse=()=>{const value=data.join("\n");data=[];return value&&value!=="[DONE]"?JSON.parse(value):null;};
  for await(const bytes of response.body){
    buffer+=decoder.decode(bytes,{stream:true});let end;
    while((end=buffer.indexOf("\n"))!==-1){
      const line=buffer.slice(0,end).replace(/\r$/,"");buffer=buffer.slice(end+1);
      if(line.startsWith("data:"))data.push(line.slice(5).trimStart());
      else if(!line){const payload=parse();if(payload)yield payload;}
    }
  }
  buffer+=decoder.decode();if(buffer.startsWith("data:"))data.push(buffer.slice(5).trim());
  const payload=parse();if(payload)yield payload;
}
async function requestDashScope(model,context,options,message) {
  let payload=dashScopePayload(model,context,options);
  const replacement=await options.onPayload?.(payload,model);if(replacement!==undefined)payload=replacement;
  const route=model.api==="dashscope-multimodal"?"multimodal-generation":"text-generation";
  const url=`${String(model.baseUrl).replace(/\/+$/,"")}/services/aigc/${route}/generation`;
  const response=await (options.fetch||fetch)(url,{method:"POST",headers:{...model.headers,...options.headers,"content-type":"application/json","X-DashScope-SSE":"enable",authorization:`Bearer ${options.apiKey||""}`},body:JSON.stringify(payload),signal:options.signal});
  await options.onResponse?.({status:response.status,headers:Object.fromEntries(response.headers)},model);
  if(!response.ok)throw new Error(`DashScope request failed: HTTP ${response.status}`);
  let answer="",thinking="",finish=null,usage={},received=false;const calls=new Map();
  for await(const event of nativeEvents(response)){
    options.signal?.throwIfAborted();await options.onProviderStreamEvent?.(event,model);
    if(event.code||event.status_code&&event.status_code!==200)throw new Error(`DashScope request failed: ${event.code||event.status_code}`);
    if(event.request_id)message.responseId=event.request_id;
    if(event.usage)usage=event.usage;
    const choice=event.output?.choices?.[0];
    if(!choice)continue;received=true;
    if(choice.finish_reason&&choice.finish_reason!=="null")finish=choice.finish_reason;
    const part=choice.message||{};
    const fragment=typeof part.content==="string"?part.content:(part.content||[]).map(item=>item.text||"").join("");
    if(payload.parameters?.incremental_output===false){if(part.content!==undefined)answer=fragment;if(part.reasoning_content!==undefined)thinking=part.reasoning_content;}
    else{answer+=fragment;thinking+=part.reasoning_content||"";}
    for(const [position,call]of (part.tool_calls||[]).entries()){
      const index=call.index??position,previous=calls.get(index)||{id:"",name:"",arguments:""};
      if(call.id)previous.id=call.id;
      if(call.function?.name)previous.name=previous.name&&call.function.name!==previous.name&&!call.function.name.startsWith(previous.name)?previous.name+call.function.name:call.function.name;
      if(call.function?.arguments!==undefined)previous.arguments=payload.parameters?.incremental_output===false?call.function.arguments:previous.arguments+call.function.arguments;
      calls.set(index,previous);
    }
  }
  if(!received||!finish)throw new Error("DashScope response ended without a completed choice.");
  if(thinking)message.content.push({type:"thinking",thinking});if(answer)message.content.push({type:"text",text:answer});
  for(const call of calls.values()){
    const args=JSON.parse(call.arguments||"{}");
    if(!call.name||!args||typeof args!=="object"||Array.isArray(args))throw new Error("DashScope returned an invalid tool call.");
    message.content.push({type:"toolCall",id:call.id||randomUUID(),name:call.name,arguments:args});
  }
  const input=usage.input_tokens||0,output=usage.output_tokens||0,cacheRead=usage.input_tokens_details?.cached_tokens||0;
  message.usage={input:Math.max(0,input-cacheRead),output,cacheRead,cacheWrite:0,totalTokens:usage.total_tokens??input+output,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  message.rawStopReason=finish;message.stopReason=calls.size?"toolUse":finish==="length"?"length":"stop";
  return message;
}

// The native response is collected before emitting complete content blocks. Both
// result() and async iteration consume the same request, including error/abort results.
export function streamDashScope(model,context,options={}) {
  const started=Date.now();
  const message={role:"assistant",content:[],api:model.api,provider:model.provider,model:model.id,timestamp:started,stopReason:"stop",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  const result=Promise.resolve().then(()=>requestDashScope(model,context,options,message)).catch(error=>{
    message.stopReason=options.signal?.aborted?"aborted":"error";message.errorMessage=error.message;return message;
  }).then(message=>{message.durationMs=Date.now()-started;return message;});
  return {
    result:()=>result,
    async *[Symbol.asyncIterator](){
      yield {type:"start",partial:{...message,content:[]}};
      const response=await result;
      if(["error","aborted"].includes(response.stopReason)){yield {type:"error",reason:response.stopReason,error:response};return;}
      for(const [contentIndex,content]of response.content.entries()){
        const type=content.type==="toolCall"?"toolcall":content.type;
        yield {type:`${type}_start`,contentIndex,partial:response};
        yield {type:`${type}_delta`,contentIndex,delta:type==="toolcall"?JSON.stringify(content.arguments):content.text||content.thinking,partial:response};
        yield {type:`${type}_end`,contentIndex,...(type==="toolcall"?{toolCall:content}:{content:content.text||content.thinking}),partial:response};
      }
      yield {type:"done",reason:response.stopReason,message:response};
    },
  };
}
