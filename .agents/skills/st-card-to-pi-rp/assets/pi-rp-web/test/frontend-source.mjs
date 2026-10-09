// 前端源码的合并视图（测试辅助）。
//
// 背景：方案 §11 第 6 条要求把前端按职责拆成多个原生模块，因此"某个函数在哪个文件里"
// 会随拆分变化。若每个测试各自只读 app.js，那么每拆一次文件就要改一批测试，
// 而且会诱使人删掉断言来让它通过。
//
// 这些测试核对的是**页面前端共同提供的界面契约**（DOM id、组件引用格式、事件绑定），
// 与文件如何切分无关。因此它们应该读取"所有前端模块的合并文本"，
// 这样拆分与合并都不影响断言的语义。
import { readFile, readdir } from "node:fs/promises";

const PUBLIC = new URL("../public/", import.meta.url);

/**
 * 参与合并的前端模块：页面实际加载的**应用**入口 `app.js` 及其按职责拆出的模块
 * （`app-image.js`、`app-modules.js` …）。
 *
 * 刻意**不含 `config.js`**：它是由 `index.html` 另行加载的独立配置界面，语义与 app.js 不同
 * （例如它有自己的 `trigger` 表单字段）。把它并进来会让针对应用侧的断言误报。
 */
export async function readFrontendSource() {
  const entries = await readdir(PUBLIC);
  const modules = entries
    .filter((name) => /^app(-[a-z]+)?\.js$/.test(name))
    .sort();
  const parts = await Promise.all(modules.map((name) => readFile(new URL(name, PUBLIC), "utf8")));
  return { source: parts.join("\n"), modules };
}

/** 单独读取一个前端文件（用于需要定位到具体文件的断言）。 */
export function readPublic(name) {
  return readFile(new URL(name, PUBLIC), "utf8");
}
