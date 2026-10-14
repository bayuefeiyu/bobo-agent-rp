// Official endpoint/protocol defaults verified against the linked vendor docs on 2026-10-13.
export const MODEL_API_OPTIONS = [
  {value:"openai-responses",label:"OpenAI Responses"},
  {value:"openai-completions",label:"Chat Completions"},
  {value:"anthropic-messages",label:"Anthropic Messages（原生）"},
  {value:"google-generative-ai",label:"Gemini generateContent（原生）"},
  {value:"dashscope-generation",label:"DashScope 文本生成（原生）"},
  {value:"dashscope-multimodal",label:"DashScope 多模态生成（原生）"},
];
export const MODEL_PROVIDERS = [
  {id:"openai",name:"OpenAI",url:"https://api.openai.com/v1",api:"openai-responses",docs:"https://developers.openai.com/api/v1/reference/resources/responses"},
  {id:"anthropic",name:"Anthropic / Claude",url:"https://api.anthropic.com",api:"anthropic-messages",docs:"https://platform.claude.com/docs/en/api/v1/overview"},
  {id:"gemini",name:"Google / Gemini",url:"https://generativelanguage.googleapis.com/v1beta",api:"google-generative-ai",docs:"https://ai.google.dev/api"},
  {id:"deepseek",name:"DeepSeek",url:"https://api.deepseek.com",api:"openai-completions",docs:"https://api-docs.deepseek.com/",note:"官方 API 采用 Chat Completions 规范。"},
  {id:"openrouter",name:"OpenRouter",url:"https://openrouter.ai/api/v1",api:"openai-completions",docs:"https://openrouter.ai/docs/api_reference/overview",note:"官方统一接口采用 Chat Completions 规范。"},
  {id:"moonshot",name:"月之暗面 / Kimi（中国）",url:"https://api.moonshot.cn/v1",api:"openai-completions",docs:"https://platform.kimi.com/docs/api/v1/chat",note:"中国区官方 Chat Completions 接口。"},
  {id:"dashscope",name:"阿里云百炼（北京）",url:"https://dashscope.aliyuncs.com/api/v1",api:"dashscope-generation",docs:"https://help.aliyun.com/zh/model-studio/qwen-api-via-dashscope",note:"原生 DashScope；Qwen3.5/3.6/3.7 Plus、3.8 等多模态模型请选择多模态格式。地域与 Key 必须匹配；也可填写业务空间专属域名。"},
  {id:"siliconflow",name:"硅基流动（中国）",url:"https://api.siliconflow.cn/v1",api:"openai-completions",docs:"https://docs.siliconflow.cn/docs/api/v1/chat-completions-post",note:"官方 API 采用 Chat Completions 规范。"},
  {id:"custom",name:"自定义",url:"",api:"openai-completions",docs:null},
];
export function providerPreset(id) { return MODEL_PROVIDERS.find(provider=>provider.id===id); }
