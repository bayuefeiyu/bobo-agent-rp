import assert from "node:assert/strict";
import test from "node:test";

import { buildModuleJsonTree } from "../public/module-json.js";

test("maps nested variable state to a key-value tree without JSON punctuation", () => {
  const state = {
    世界: { 时间: "黄昏", 天气: null },
    角色: {
      白娅: { 依存度: 63, 标签: ["警惕", "好奇"], 在场: true },
    },
  };
  const tree = buildModuleJsonTree(state);
  assert.equal(tree.kind, "object");
  assert.deepEqual(tree.entries.map(entry => entry.key), ["世界", "角色"]);
  const world = tree.entries[0].node;
  assert.equal(world.entries.find(entry => entry.key === "天气").node.display, "空值");
  const character = tree.entries[1].node.entries[0].node;
  assert.equal(character.entries.find(entry => entry.key === "依存度").node.display, "63");
  const tags = character.entries.find(entry => entry.key === "标签").node;
  assert.deepEqual(tags.entries.map(entry => [entry.key, entry.node.display]), [["第 1 项", "警惕"], ["第 2 项", "好奇"]]);
  assert.equal(character.entries.find(entry => entry.key === "在场").node.display, "是");
});

test("describes empty containers and primitive display values", () => {
  assert.deepEqual(buildModuleJsonTree({}), { kind: "object", count: 0, emptyLabel: "暂无字段", entries: [] });
  assert.deepEqual(buildModuleJsonTree([]), { kind: "array", count: 0, emptyLabel: "空列表", entries: [] });
  assert.equal(buildModuleJsonTree(false).display, "否");
  assert.equal(buildModuleJsonTree("").display, "—");
});
