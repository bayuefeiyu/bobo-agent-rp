import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const publicRoot = resolve(import.meta.dirname, "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-web/public");
const html = await readFile(resolve(publicRoot, "index.html"), "utf8");
function section(id) {
  const start = html.indexOf(`<section id="${id}"`);
  if (start < 0) throw new Error(`Missing management section ${id}`);
  const tokens = html.slice(start).matchAll(/<\/?section\b[^>]*>/g);
  let depth = 0;
  for (const token of tokens) {
    depth += token[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, start + token.index + token[0].length).replace(/^(<section\b[^>]*?) hidden(?=[\s>])/, "$1");
  }
  throw new Error(`Unclosed management section ${id}`);
}
function page(title, body, entry) {
  return `<!doctype html>\n<!-- Generated from official management sections; no gameplay entry. -->\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Pi RP</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/config.css"></head><body><main class="app-layout"><section class="shell"><header><h1 id="card-title">${title}</h1><p id="connection-status" role="status"></p><a href="/">返回游玩</a></header>${body}<p id="error-banner" role="alert" hidden></p></section></main><div id="handoff-overlay" hidden tabindex="-1"><h2 id="handoff-title"></h2><p id="handoff-description"></p><a href="/">重新打开</a></div><script type="module" src="/${entry}"></script></body></html>\n`;
}
let drift = false;
for (const [file, value] of [["config.html", page("配置方案", section("panel-profiles"), "config.js")], ["monitor.html", page("工作流监控", section("panel-workflows") + section("panel-tokens"), "monitor.js")]]) {
  if (process.argv.includes("--check")) { if (await readFile(resolve(publicRoot, file), "utf8").catch(() => "") !== value) { drift = true; console.error(`Generated management page differs: ${file}`); } }
  else await writeFile(resolve(publicRoot, file), value);
}
if (drift) process.exitCode = 1;
