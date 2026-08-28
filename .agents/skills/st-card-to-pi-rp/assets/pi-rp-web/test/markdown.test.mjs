import assert from "node:assert/strict";
import test from "node:test";

class FakeNode {
  constructor(tagName, text = "") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.value = text;
    this.dataset = {};
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === "#fragment") this.children.push(...node.children);
      else this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  set textContent(value) { this.value = String(value); }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(""); }
  set href(value) { this.attributes.href = value; }
  set target(value) { this.attributes.target = value; }
  set rel(value) { this.attributes.rel = value; }
}

globalThis.document = {
  createElement: tagName => new FakeNode(tagName),
  createTextNode: text => new FakeNode("#text", text),
  createDocumentFragment: () => new FakeNode("#fragment"),
};

const { renderMarkdown } = await import("../public/markdown.js");

test("renders Chinese headings, hard line breaks, and inline Markdown safely", () => {
  const container = new FakeNode("div");
  renderMarkdown(container, "##标题\n第一行\n第二行\n\n**粗体** 和 *斜体*\n<script>alert(1)</script>");

  assert.deepEqual(container.children.map(node => node.tagName), ["h2", "p", "p"]);
  assert.equal(container.children[0].textContent, "标题");
  assert.deepEqual(container.children[1].children.map(node => node.tagName), ["#text", "br", "#text"]);
  assert.equal(container.children[1].textContent, "第一行第二行");
  assert.deepEqual(container.children[2].children.map(node => node.tagName), [
    "strong", "#text", "em", "br", "#text",
  ]);
  assert.equal(container.children[2].children[0].textContent, "粗体");
  assert.equal(container.children[2].children[2].textContent, "斜体");
  assert.equal(container.children[2].children.at(-1).textContent, "<script>alert(1)</script>");
  assert.equal(container.children.some(node => node.tagName === "script"), false);
});

test("supports lists, quotes, fenced code, and safe web links", () => {
  const container = new FakeNode("div");
  renderMarkdown(container, "> 引用\n\n- 一\n- 二\n\n```js\nconst value = 1;\n```\n\n[站点](https://example.com)");

  assert.deepEqual(container.children.map(node => node.tagName), ["blockquote", "ul", "pre", "p"]);
  assert.equal(container.children[1].children.length, 2);
  assert.equal(container.children[2].children[0].textContent, "const value = 1;");
  const link = container.children[3].children[0];
  assert.equal(link.tagName, "a");
  assert.equal(link.attributes.href, "https://example.com");
  assert.equal(link.attributes.rel, "noopener noreferrer");
});
