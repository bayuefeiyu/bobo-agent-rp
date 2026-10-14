import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..", "packages", "rp-web-contract");
const { $defs } = JSON.parse(await readFile(resolve(root, "schemas.json"), "utf8"));
const { operations } = JSON.parse(await readFile(resolve(root, "operations.json"), "utf8"));
const type = schema => {
  if (schema.$ref) return schema.$ref.split("/").at(-1);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(type).join(" | ");
  if (schema.type === "array") return `Array<${schema.items ? type(schema.items) : "unknown"}>`;
  if (schema.type === "object") return `{ ${Object.entries(schema.properties || {}).map(([key, child]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${type(child)};`).join(" ")} ${schema.additionalProperties === false ? "" : "[key: string]: unknown;"} }`;
  return ({ integer: "number", number: "number", string: "string", boolean: "boolean", null: "null" })[schema.type] || "unknown";
};
const types = `// Generated from schemas.json and operations.json. Run scripts/generate-web-contract.mjs.\n${Object.entries($defs).map(([name, schema]) => `export type ${name} = ${type(schema)};`).join("\n")}\nexport type OperationId = ${operations.map(item => JSON.stringify(item.id)).join(" | ")};\nexport type ResponseEnvelope<T> = { data: T; requestId: string; readContext: ReadContext | null };\nexport const API_VERSION: Readonly<Version>;\nexport const HOST_VERSION: Readonly<Version>;\nexport const API_ROOT: string;\nexport const ERROR_STATUS: Readonly<Record<string, number>>;\nexport class RpWebError extends globalThis.Error { code: string; status: number; details: unknown; requestId: string | null; retryable: boolean; constructor(code: string, message: string, options?: { status?: number; details?: unknown; requestId?: string | null; retryable?: boolean }); }\nexport function assertCompatible(required: Version, actual: Version, label?: string): void;\nexport function normalizeReadContext(value: unknown): ReadContext;\nexport function contextKey(value: ReadContext): string;\nexport function validateSchema(schema: unknown, value: unknown, label?: string, definitions?: Record<string, unknown>): unknown;\n`;
const docs = `# Web API v1 操作目录\n\n由 operations.json 与 schemas.json 生成。所有 JSON 成功响应为 data/requestId/readContext，失败响应为 error/requestId；二进制响应通过 HTTP 状态与 x-request-id 表达。所有命令携带 readContext query，管理命令另外携带所需 token。旧 /api 路由不受支持。\n\n| 能力 ID | 方法 | 路径 | 请求 schema | 返回 schema | 配置认证 |\n| --- | --- | --- | --- | --- | --- |\n${operations.map(item => `| ${item.id} | ${item.method} | ${item.path} | ${item.requestSchema || "—"} | ${item.responseSchema || item.response} | ${item.configAuth ? "是" : "否"} |`).join("\n")}\n\n动态模块数据依照具名 view 投影，字段由模块定义；配置与诊断 DTO 的业务字段由相应领域文档定义，不承诺引擎内部对象。\n`;
let drift = false;
for (const [file, content] of [["index.d.mts", types], ["API.md", docs]]) {
  const target = resolve(root, file);
  if (process.argv.includes("--check")) {
    if (await readFile(target, "utf8").catch(() => "") !== content) { console.error(`Generated contract differs: ${file}`); drift = true; }
  } else await writeFile(target, content);
}
if (drift) process.exitCode = 1;
