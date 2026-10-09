import assert from "node:assert/strict";
import test from "node:test";

import { readFrontendSource, readPublic } from "./frontend-source.mjs";

test("frontend keeps qualified component references stable", async () => {
  // 前端已按职责拆成多个原生模块（方案 §11 第 6 条）。本测试核对的是**界面契约**，
  // 与"函数在哪个文件里"无关，因此读取合并视图而不是只读 app.js。
  const [{ source: app }, config] = await Promise.all([
    readFrontendSource(),
    readPublic("config.js"),
  ]);

  assert.match(app, /function componentReference\(ownerModuleId, id\)/);
  assert.match(app, /reference\.includes\("\/"\) \|\| !ownerModuleId/);
  assert.match(app, /function workflowReference\(workflow\) \{ return workflow\.reference \|\| componentReference\(workflow\.ownerModuleId, workflow\.id\); \}/);
  assert.match(app, /function runWorkflowReference\(run\) \{ return componentReference\(run\.ownerModuleId, run\.workflowId\); \}/);
  assert.match(app, /allowed = new Set\(\(region\.workflows \|\| \[\]\)\.map\(item => componentReference\(module\.id, item\.id\)\)\)/);
  assert.match(app, /filter\(run => allowed\.has\(runWorkflowReference\(run\)\)/);
  assert.match(app, /\/api\/workflows\/\$\{encodeURIComponent\(reference\)\}\/activate/);

  assert.match(config, /function ownedAgents\(\) \{ return state\.catalog\.agents\.filter\(item=>item\.moduleId\); \}/);
  assert.match(config, /function ownedWorkflows\(\) \{ return state\.catalog\.workflows\.filter\(item=>item\.moduleId\); \}/);
  assert.doesNotMatch(config, /general|通用/);
});
