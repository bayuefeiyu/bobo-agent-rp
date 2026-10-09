// S6 行为验收：公开页面的 DOM 契约。
//
// 方案 11 的验收里有两条靠人工核对很容易漏掉：
//   - "开发预览、未开始聊天、活跃聊天三种状态都可初始化，无缺失 DOM 错误"；
//   - "页面只存在当前配置入口；旧面板、旧专用写 API 和无消费者的事件代码均删除"。
//
// 这里把"无缺失 DOM"变成一条可自动复现的断言：页面上每个被脚本查询的 id 都必须存在，
// 每个面板都必须有控制它的标签页，且不得再出现旧配置入口。它检查的是**契约**，
// 不做整站像素比较。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const WEB = new URL("../public/", import.meta.url);
const read = (name) => readFileSync(new URL(name, WEB), "utf8");

const html = read("index.html");
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

/** 收集一个脚本里查询的所有元素 id（含 `#config-panel-${name}` 这类模板形式）。 */
function referencedIds(source) {
  const ids = new Set();
  // `config.js` 用本地简写 `$ = selector => document.querySelector(selector)`，
  // 因此除了 querySelector/getElementById 还要收 `$("#id")`。
  for (const match of source.matchAll(/(?:querySelector|\$|getElementById)\(\s*"#([A-Za-z0-9_-]+)"/g)) ids.add(match[1]);
  for (const match of source.matchAll(/getElementById\(\s*"([A-Za-z0-9_-]+)"/g)) ids.add(match[1]);
  // 配置面板按模板拼 id：`#config-panel-${name}`，因此显式展开已存在的后缀。
  for (const match of source.matchAll(/(?:querySelector|\$)\(\s*`#([A-Za-z0-9_-]+)-\$\{/g)) {
    for (const id of htmlIds) if (id.startsWith(`${match[1]}-`)) ids.add(id);
  }
  return ids;
}

for (const script of ["app.js", "config.js"]) {
  test(`${script} 查询的所有元素 id 都存在于 index.html`, () => {
    const ids = [...referencedIds(read(script))];
    assert.ok(ids.length > 0, `${script} 未解析出任何元素 id，说明提取逻辑失效（而不是页面干净）`);
    const missing = ids.filter((id) => !htmlIds.has(id));
    assert.deepEqual(missing, [], `index.html 缺少这些被查询的元素 id：${missing.join(", ")}`);
  });
}

test("每个面板都有控制它的标签页（不存在不可达面板）", () => {
  const panels = [...htmlIds].filter((id) => id.startsWith("panel-"));
  const controlled = new Set([...html.matchAll(/aria-controls="([^"]+)"/g)].map((match) => match[1]));
  const orphans = panels.filter((id) => !controlled.has(id));
  assert.ok(panels.length > 0, "未解析出任何面板，说明提取逻辑失效");
  assert.deepEqual(orphans, [], `这些面板没有控制它的标签页：${orphans.join(", ")}`);
});

test("旧配置入口已删除，源码不再生成旧 URL", () => {
  // 命名配置方案是唯一入口：页面不得再引用旧配置页或旧重定向。
  assert.deepEqual([...html.matchAll(/config\.html/g)], []);
  assert.match(html, /src="\/config\.js/);
  assert.match(html, /id="panel-profiles"/);
});

test("前端模块的每一条 import 都能解析到真实文件", () => {
  // 页面按原生 ES module 加载（`<script type="module" src="/app.js?v=26">`），服务器只按
  // 静态目录直读文件。因此前端模块之间的一条**写错的相对路径或漏掉的新文件**不会在任何
  // 静态检查里报错，只会在浏览器里静默失败——这是拆文件最容易留下的缺陷。
  // 这里把每条 import 解析到磁盘，作为"文件真的能加载"的最低保证。
  // `config.js` 目前不 import 任何东西（自包含），因此不要求它必须有 import；
  // 但对确实有 import 的模块，每条都必须能解析到磁盘。
  const MODULES = ["app.js", "app-image.js", "app-modules.js", "app-workflows.js", "config.js"];
  let checked = 0;
  let modulesWithImports = 0;
  for (const name of MODULES) {
    const source = read(name);
    const specifiers = [...source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)].map((match) => match[1]);
    if (specifiers.length) modulesWithImports += 1;
    for (const specifier of specifiers) {
      // 去掉缓存失效用的 `?v=N`，只校验文件本身存在。
      const target = specifier.split("?")[0];
      if (!target.startsWith("./") && !target.startsWith("../")) continue; // 裸模块名不在静态目录内
      assert.ok(
        existsSync(new URL(target, new URL(name, WEB))),
        `${name} 的 import "${specifier}" 解析不到文件（相对路径错了或文件漏了）`,
      );
      checked += 1;
    }
  }
  assert.ok(checked >= 5, `只校验了 ${checked} 条 import，提取逻辑可能失效`);
  assert.ok(modulesWithImports >= 2, `只有 ${modulesWithImports} 个模块解析出 import，提取逻辑可能失效`);
});

test("拆出的前端模块被 app.js 引入（否则页面不会加载它）", () => {
  const app = read("app.js");
  for (const module of ["app-image.js", "app-modules.js", "app-workflows.js"]) {
    const referenced = new RegExp(`"\\./${module.replace(".", "\\.")}`).test(app);
    assert.ok(referenced, `app.js 未引入 ${module}——该模块不会被浏览器加载`);
    assert.ok(existsSync(new URL(module, WEB)), `${module} 不存在`);
  }
});

test("拆分出的前端模块只使用 app.js 已登记的 elements 字段", () => {
  // 方案 §11 第 6 条把前端按职责拆分。拆出的模块不再自己 querySelector，而是读取
  // app.js 的 `elements` 登记表——因此"某个字段其实没被登记"会变成运行期 undefined。
  // 这里把该契约固定下来：拆出模块引用的每个 elements.<name> 都必须在 app.js 里登记。
  const app = read("app-context.js");
  const block = app.match(/Object.assign\(elements, \{([\s\S]*?)\n\}\);/);
  assert.ok(block, "未能从 app.js 解析出 elements 登记表");
  const registered = new Set([...block[1].matchAll(/^\s*([A-Za-z0-9_$]+)\s*:/gm)].map((match) => match[1]));
  assert.ok(registered.size > 20, `elements 登记表只解析出 ${registered.size} 个字段，提取逻辑可能失效`);

  for (const module of ["app-image.js", "app-modules.js", "app-workflows.js"]) {
    const source = read(module);
    const used = [...new Set([...source.matchAll(/\belements\.([A-Za-z0-9_$]+)/g)].map((match) => match[1]))];
    assert.ok(used.length > 0, `${module} 未引用任何 elements 字段，说明提取逻辑失效`);
    const missing = used.filter((name) => !registered.has(name));
    assert.deepEqual(missing, [], `${module} 引用了未登记的 elements 字段：${missing.join(", ")}`);
  }
});
