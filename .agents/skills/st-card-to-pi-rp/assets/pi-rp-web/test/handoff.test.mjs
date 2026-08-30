import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("retires the initiating page and renders the reading-style avatar layout", async () => {
  const [app, page, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="handoff-overlay"/);
  assert.match(app, /elements\.appLayout\.inert = true/);
  assert.match(app, /showHandoff\("新的聊天选择页正在打开"/);
  assert.doesNotMatch(app, /切换未完成，可重试聊天记录选择/);
  assert.match(page, /id="player-avatar"/);
  assert.match(app, /className = `message-avatar \$\{role\}`/);
  assert.match(page, /id="card-module-list"/);
  assert.doesNotMatch(page, /data-module-id="character-memory"/);
  assert.match(app, /function toggleCardModule/);
  assert.match(app, /function renderFeatureModules/);
  assert.match(app, /region\.type === "json"/);
  assert.match(styles, /\.module-json-fields/);
  assert.match(styles, /\.module-json-pair/);
  assert.match(app, /left\.displayOrder/);
  assert.match(page, /id="module-display-settings-form"/);
  assert.match(page, /id="module-settings-list"/);
  assert.match(app, /\/api\/module-display-settings/);
  assert.match(app, /function moveModuleDisplay/);
  assert.match(app, /state\.moduleDisplayDraft\.hidden/);
  assert.match(app, /request\("\/api\/modules"\)/);
  assert.match(app, /expandedFeatureModules: new Set\(\)/);
  assert.match(app, /function beginMessageEdit/);
  assert.match(app, /function deleteSavedMessage/);
  assert.match(app, /function deleteSavedProfile/);
  assert.match(app, /\/api\/user-profile\?playerName=/);
  assert.match(page, /id="delete-saved-profile"/);
  assert.match(app, /method: "PUT"/);
  assert.match(app, /同时删除其后的/);
  assert.match(styles, /calc\(60vw \+ 384px\)/);
  assert.match(styles, /grid-template-columns: minmax\(360px, 1fr\) 360px/);
  assert.match(styles, /@media \(max-width: 1020px\)/);
  assert.match(styles, /grid-template-columns: 48px minmax\(0, 1fr\)/);
});
