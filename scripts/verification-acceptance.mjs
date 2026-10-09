// Read-only structure gates. Behaviour is exercised by verify's actual test suites.
// File existence does not prove behaviour or external integration.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CONVERT = ".agents/skills/st-card-to-pi-rp";
const ENGINE = `${CONVERT}/assets/pi-rp-runtime/.pi`;
const WEB = `${CONVERT}/assets/pi-rp-web/public`;

export function importGraph(directory, language = "js") {
  const files = [];
  const walk = path => { for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "__pycache__" || entry.name === "node_modules") continue;
    const target = join(path, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (language === "python" ? entry.name.endsWith(".py") : /\.(?:mjs|js|ts)$/.test(entry.name) && !entry.name.endsWith(".test.mjs")) files.push(resolve(target));
  } };
  walk(directory);
  const known = new Set(files);
  return new Map(files.map(file => {
    const source = readFileSync(file, "utf8"), edges = [];
    if (language === "python") {
      for (const match of source.matchAll(/^\s*from\s+(?:\.([\w]+)|validation\.([\w]+))\s+import\b/gm)) {
        const target = resolve(dirname(file), `${match[1] || match[2]}.py`);
        assert.ok(known.has(target), `Unresolved validation import: ${file} → ${target}`); edges.push(target);
      }
    } else {
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, extname(file) === ".ts" ? ts.ScriptKind.TS : ts.ScriptKind.JS);
      for (const node of tree.statements) {
        if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
        if (!node.moduleSpecifier || node.isTypeOnly || node.importClause?.isTypeOnly) continue;
        const named = node.importClause?.namedBindings || node.exportClause;
        if (named?.elements?.length && named.elements.every(item => item.isTypeOnly) && !node.importClause?.name) continue;
        const specifier = node.moduleSpecifier.text;
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier.split(/[?#]/)[0]);
        assert.ok(existsSync(target), `Unresolved local import: ${file} → ${specifier}`);
        if (known.has(target)) edges.push(target);
      }
    }
    return [file, [...new Set(edges)]];
  }));
}

export function assertAcyclic(graph) {
  const visiting = new Set(), visited = new Set(), stack = [];
  const visit = file => {
    assert.ok(!visiting.has(file), `Runtime dependency cycle: ${[...stack.slice(stack.indexOf(file)), file].join(" → ")}`);
    if (visited.has(file)) return;
    visiting.add(file); stack.push(file);
    for (const edge of graph.get(file) || []) visit(edge);
    stack.pop(); visiting.delete(file); visited.add(file);
  };
  for (const file of graph.keys()) visit(file);
}

export function checkArchitecture(root) {
  const read = file => readFileSync(join(root, file), "utf8");
  const results = [];
  const gate = (id, label, action) => { try { results.push({ id, label, ok: true, evidence: action() }); } catch (error) { results.push({ id, label, ok: false, evidence: error.message }); } };
  gate("entry", "Pi 入口只注册和组装宿主", () => {
    const entry = read(`${ENGINE}/extensions/pi-rp-web.ts`);
    assert.match(entry, /createRpHostSession/); assert.match(entry, /host\.register\(pi\)/);
    assert.ok(entry.split("\n").length < 60, "Extension entry still contains implementation");
    for (const file of ["rp-host-session.ts", "rp-host-registration.ts", "rp-node-executor.ts", "rp-node-control-executor.ts", "rp-web-config-bridge.ts", "rp-web-workflows-bridge.ts", "rp-web-modules-bridge.ts", "rp-web-chat-bridge.ts", "rp-image-web-bridge.ts"]) assert.ok(existsSync(join(root, ENGINE, "lib", file)), `Missing host responsibility: ${file}`);
    return "注册、生命周期、节点执行和各 Web 处理器已有明确入口";
  });
  gate("dependencies", "运行库与 Python 校验层没有静态值依赖环", () => {
    const host = importGraph(join(root, ENGINE)), python = importGraph(join(root, CONVERT, "scripts/validation"), "python");
    assertAcyclic(host); assertAcyclic(python);
    for (const [file, edges] of host) if (file.includes(join(".pi", "lib"))) assert.ok(!edges.some(edge => edge.includes(join(".pi", "extensions"))), `Library imports extension: ${file}`);
    return `${host.size} 个运行库文件、${python.size} 个校验层文件，局部 import 均可解析`;
  });
  gate("frontend", "原生浏览器模块单向依赖共享上下文", () => {
    const graph = importGraph(join(root, WEB)); assertAcyclic(graph);
    for (const name of ["app-image.js", "app-modules.js", "app-workflows.js"]) {
      const source = read(`${WEB}/${name}`); assert.match(source, /from "\.\/app-context\.js"/); assert.doesNotMatch(source, /from "\.\/app\.js/);
    }
    assert.match(read(`${WEB}/app.js`), /if \(initializePageContext\(\)\)/);
    return "面板不反向导入带初始化副作用的 app.js；同一 document 只启动一次";
  });
  gate("configuration", "配置目录唯一装配，旧写入口已移除", () => {
    assert.match(read(`${ENGINE}/lib/rp-host-utils.ts`), /return buildConfigCatalog\(\{/);
    assert.match(read(`${ENGINE}/lib/rp-config-catalog.mjs`), /resolveSettingsRegionDefaults/);
    const html = read(`${WEB}/index.html`), server = read(`${CONVERT}/assets/pi-rp-web/server.mjs`);
    assert.doesNotMatch(html, /id="(?:tab-api|tab-agents|workflow-policy-form)"/);
    assert.ok(!existsSync(join(root, WEB, "config.html")));
    assert.doesNotMatch(server, /bridge\.(?:saveModel|deleteModel|saveAgent|restoreAgent|saveWorkflowPolicy|updateWorkflowNodeBinding|updateWorkflowTrigger)\(/);
    return "命名配置方案为配置写入入口；运行期模型/Agent/工作流查询保留";
  });
  gate("image", "图像语义归模块，宿主显式接线", () => {
    const api = read("global-modules/comfy-image-generation/runtime/web-api.mjs");
    for (const name of ["readWebRecords", "preferenceUpdate", "recoverableRenders", "regenerationSource"]) assert.match(api, new RegExp(`export (?:async )?function ${name}\\b`));
    assert.match(read(`${ENGINE}/lib/rp-image-adapter.ts`), /webApi\.readWebRecords/);
    assert.doesNotMatch(read(`${ENGINE}/lib/rp-host-session.ts`), /"image\.(?:requests\.prepare|renders\.execute|preferences)"|image-execution\.mjs/);
    return "投影转换、偏好操作、恢复和再生成规则由模块提供";
  });
  gate("engineering", "可复现依赖与真实类型检查", () => {
    const pkg = JSON.parse(read("package.json")), lock = JSON.parse(read("package-lock.json"));
    assert.deepEqual(lock.packages[""].devDependencies, pkg.devDependencies);
    assert.match(read("tsconfig.check.json"), /\.pi\/\*\*\/\*\.ts/);
    assert.match(read(".github/workflows/verify.yml"), /npm ci/);
    assert.match(read(".github/workflows/verify.yml"), /verify:all/);
    return "锁定开发依赖；全部宿主 TypeScript 纳入检查；CI 运行完整离线验证";
  });
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = checkArchitecture(resolve(process.argv[2] || process.cwd()));
  console.log("架构结构门槛（行为结果另见 verify 实际执行汇总）");
  for (const result of results) console.log(`[${result.ok ? "通过" : "失败"}] ${result.id} ${result.label}\n  ${result.evidence}`);
  console.log("未覆盖：真实模型 API、真实 ComfyUI、真实用户卡游玩；结构检查不能替代这些验证。");
  process.exitCode = results.every(result => result.ok) ? 0 : 1;
}
