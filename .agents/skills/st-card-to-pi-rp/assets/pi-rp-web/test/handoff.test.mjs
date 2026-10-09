import assert from "node:assert/strict";
import test from "node:test";

import { readFrontendSource, readPublic } from "./frontend-source.mjs";

test("retires the initiating page and renders the reading-style avatar layout", async () => {
  // 前端已按职责拆分（方案 §11 第 6 条）：生图交互在 app-image.js，模块区域在 app-modules.js。
  // 本测试核对的是"页面与前端源码共同提供的界面契约"，与文件如何切分无关，
  // 因此读取所有前端模块的合并视图，而不是删掉相关断言。
  const [{ source: app }, page, styles] = await Promise.all([
    readFrontendSource(),
    readPublic("index.html"),
    readPublic("styles.css"),
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
  assert.match(app, /function openFeatureModuleDocument/);
  assert.match(app, /查看数据/);
  assert.match(app, /修改模块/);
  assert.match(styles, /\.module-file-actions/);
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
  assert.match(app, /workflowPanelHasFocus/);
  assert.match(app, /workflowRenderSignature/);
  assert.match(app, /打开过程记录/);
  assert.match(app, /process-record\/open/);
  assert.match(page, /id="panel-tokens"/);
  assert.match(page, /id="token-node-list"/);
  assert.match(page, /id="token-workflow-list"/);
  assert.match(app, /function renderTokenUsage/);
  assert.match(app, /本次工作流总消耗/);
  assert.match(app, /run\.usageComplete === false/);
  assert.match(app, /node\.usage \?\? attempt\?\.usage/);
  assert.match(styles, /\.token-summary/);
  assert.match(app, /if \(node\.type === "agent"\)/);
  assert.match(app, /binding\.textContent = `Agent：\$\{agentLabel/);
  assert.doesNotMatch(app, /node-binding-controls/);
  assert.doesNotMatch(page, /id="workflow-policy-form"/);
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
  assert.match(app, /region\.type === "image-generation"/);
  assert.match(app, /快速模式/);
  assert.match(app, /源文件找不到；提示词仍可重新生成/);
  assert.match(page, /id="image-positive-prompt"[^>]*readonly/);
  assert.match(page, /id="image-regenerate-scope"/);
  assert.match(page, /id="comfy-connection-form"/);
  assert.doesNotMatch(app, /updateWorkflowTrigger|\/trigger/);
});
