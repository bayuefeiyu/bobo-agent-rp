#!/usr/bin/env node
// 接口类型检查（实施方案 S2）。不输出编译产物：tsc --noEmit。
//
// 覆盖范围（明确声明，不使用整文件 ts-nocheck、也不把错误藏成 any）：
// - `assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts`：Pi 宿主边界（ExtensionAPI /
//   ExtensionContext）与它对公共运行库 .mjs 的调用。
// - `types/pi-rp-host.d.ts`：为未在仓库安装的 Pi 宿主提供最小的准确性
//   声明，使边界可被检查，同时不需要把宿主装进仓库。
//
// 前置：需要 TypeScript（devDependency）。未安装时报告环境缺失并返回非零，
// 不静默通过——默认验证与类型检查都需要先运行 `npm ci` 安装锁定开发依赖。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, "..");
const baseConfigPath = join(root, "tsconfig.check.json");

if (!existsSync(baseConfigPath)) {
  console.error(`缺少 ${baseConfigPath}。`);
  process.exit(1);
}

// 解析 TypeScript：显式环境变量 → 仓库本地 → 全局 npm → 已知打包位置。
// 最后一项用于没有网络、无法 npm install 的受限环境；它只是候选之一，
// 不影响正常机器上 npm install 的结果。
const require = createRequire(import.meta.url);
function resolveTsc() {
  if (process.env.VERIFY_TSC) {
    const explicit = resolve(process.env.VERIFY_TSC);
    if (existsSync(explicit)) return explicit;
  }
  try {
    return require.resolve("typescript/lib/tsc.js");
  } catch { /* fall through */ }
  const local = join(root, "node_modules", "typescript", "lib", "tsc.js");
  if (existsSync(local)) return local;
  const wellKnown = [];
  if (process.env.APPDATA) wellKnown.push(join(process.env.APPDATA, "npm", "node_modules", "typescript", "lib", "tsc.js"));
  if (process.env.ProgramFiles) wellKnown.push(join(process.env.ProgramFiles, "nodejs", "node_modules", "typescript", "lib", "tsc.js"));
  if (process.env.DSH_HARNESS_ROOT) wellKnown.push(join(process.env.DSH_HARNESS_ROOT, "node_modules", "typescript", "lib", "tsc.js"));
  wellKnown.push(join(homedir(), "node_modules", "typescript", "lib", "tsc.js"));
  for (const candidate of wellKnown) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const tscPath = resolveTsc();

if (!tscPath) {
  console.error("未找到 TypeScript 编译器，类型检查未执行。");
  console.error("这是环境缺失，不是类型检查通过。请运行：npm ci");
  process.exit(1);
}

// 解析 @types/node：优先本地 node_modules，其次已安装 Pi 宿主自带的副本。
// 结果写入**临时**配置，绝不修改仓库里的 tsconfig.check.json。
function resolveNodeTypes() {
  const candidates = [
    join(root, "node_modules", "@types", "node"),
    process.env.NODE_TYPES_DIR || null,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@types", "node") : null,
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.d.ts"))) return dir;
  }
  return null;
}

// tsconfig.check.json 是 JSONC（含注释与尾随逗号）。这里做最小解析，只处理
// 行注释、块注释与尾随逗号，且不进入字符串内部。
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) { if (ch === "\n") { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === "*" && next === "/") { inBlock = false; i += 1; } continue; }
    if (inString) {
      out += ch;
      if (ch === "\\") { out += next ?? ""; i += 1; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i += 1; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i += 1; continue; }
    out += ch;
  }
  // 去掉对象/数组末尾的尾随逗号。
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(out);
}

const nodeTypes = resolveNodeTypes();
const config = parseJsonc(readFileSync(baseConfigPath, "utf8"));
if (nodeTypes) {
  config.compilerOptions.paths = { ...config.compilerOptions.paths, "@types/node": [nodeTypes] };
  config.compilerOptions.typeRoots = [join(nodeTypes, "..")];
} else {
  console.error("警告：未找到 @types/node。Node 内置模块将无法解析，检查可能产生与宿主无关的错误。");
  console.error("请执行 npm ci，或设置 NODE_TYPES_DIR 指向包含 index.d.ts 的 @types/node 目录。");
}
config.include = [...new Set([...(config.include || []), ...(nodeTypes ? [join(nodeTypes, "index.d.ts")] : [])])];

// 生成的配置位于仓库根目录：tsconfig 的相对 path 以配置文件所在目录为基准，
// 放在 .verify/ 下会让 "types/pi-rp-host.d.ts" 解析到不存在的路径（这曾导致
// 类型检查静默空过）。
const generatedConfig = join(root, ".tsconfig.check.generated.json");
writeFileSync(generatedConfig, JSON.stringify(config, null, 2), "utf8");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const expected = (pkg.devDependencies || {}).typescript;
// --version 的输出捕获需要管道（受限环境被拒），因此改为解析 TypeScript 包自身的版本文件。
let version = "unknown";
try {
  const tsPkg = JSON.parse(readFileSync(join(dirname(dirname(tscPath)), "package.json"), "utf8"));
  version = `v${tsPkg.version}`;
} catch { /* 版本仅用于展示 */ }
console.log(`TypeScript：${version}${expected ? `（package.json 声明 ${expected}）` : ""}`);
console.log(`@types/node：${nodeTypes || "未找到"}`);
console.log(`检查范围：${(config.include || []).filter((p) => !p.includes("@types")).join(", ")}`);

const result = spawnSync(process.execPath, [tscPath, "--noEmit", ...(process.env.VERIFY_LIST_FILES ? ["--listFiles"] : []), "--project", generatedConfig], {
  cwd: root,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error("\n类型检查失败。");
  if (!process.env.VERIFY_KEEP_GENERATED_CONFIG) rmSync(generatedConfig, { force: true });
  process.exit(result.status ?? 1);
}
console.log(`类型检查通过：${(config.include || []).filter((p) => !p.includes("@types")).join(", ")}`);
if (!process.env.VERIFY_KEEP_GENERATED_CONFIG) rmSync(generatedConfig, { force: true });
