// Use each protocol's official authentication, model identifiers and pagination.
export async function discoverModelList({baseUrl,api,apiKey="",fetchImpl=fetch}) {
  const base=String(baseUrl||"").trim().replace(/\/+$/,"");
  if(!base)throw new Error("请填写 API URL。");
  const google=api==="google-generative-ai",anthropic=api==="anthropic-messages",dashscope=api?.startsWith("dashscope-");
  const endpoint=anthropic&&!base.endsWith("/v1")?`${base}/v1/models`:`${base}/models`;
  const headers={accept:"application/json"};
  if(anthropic)headers["anthropic-version"]="2023-06-01";
  if(apiKey)headers[google?"x-goog-api-key":anthropic?"x-api-key":"authorization"]=google||anthropic?apiKey:`Bearer ${apiKey}`;
  const signal=AbortSignal.timeout(15000),models=new Set(),tokens=new Set();
  let pageToken=null,afterId=null,received=0;
  for(let page=1;page<=50;page++){
    const url=new URL(endpoint);
    if(google){url.searchParams.set("pageSize","1000");if(pageToken)url.searchParams.set("pageToken",pageToken);}
    if(anthropic){url.searchParams.set("limit","1000");if(afterId)url.searchParams.set("after_id",afterId);}
    if(dashscope){url.searchParams.set("page_no",String(page));url.searchParams.set("page_size","100");url.searchParams.set("capabilities","TG");}
    const response=await fetchImpl(url.href,{headers,signal});
    if(!response.ok)throw new Error(`Model list request failed: HTTP ${response.status}`);
    const payload=await response.json();
    if(payload.code)throw new Error(`Model list request failed: ${payload.code}`);
    const entries=dashscope?payload.output?.models:google?payload.models:payload.data||payload.models;
    if(!Array.isArray(entries))throw new Error("服务未返回该 API 格式的模型列表。");
    for(const entry of entries){
      if(google&&entry.supportedGenerationMethods&&!entry.supportedGenerationMethods.includes("generateContent"))continue;
      const id=typeof entry==="string"?entry:google?entry.name:dashscope?entry.model:entry.id;
      if(typeof id==="string"&&id.trim())models.add(google?id.replace(/^models\//,""):id.trim());
    }
    received+=entries.length;
    const next=google?payload.nextPageToken:anthropic&&payload.has_more?payload.last_id:null;
    const hasNext=dashscope?Number(payload.output?.total)>received:Boolean(next);
    if(!hasNext)return {models:[...models].sort()};
    if(!entries.length||next&&tokens.has(next))throw new Error("模型列表分页未前进。");
    if(next)tokens.add(next);if(google)pageToken=next;if(anthropic)afterId=next;
  }
  throw new Error("模型列表超过 50 页，请缩小查询范围。");
}
