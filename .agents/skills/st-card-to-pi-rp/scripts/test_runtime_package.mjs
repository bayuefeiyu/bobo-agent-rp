import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadCardComponents } from "../assets/pi-rp-runtime/.pi/lib/rp-module-registry.mjs";
import { packageCardRuntime } from "./package_card_runtime.mjs";
import { validateRuntimePackage } from "./validate_runtime_package.mjs";
import { playPromptSources } from "../assets/pi-rp-runtime/.pi/lib/rp-author-prompts.mjs";
const execFileAsync = promisify(execFile);
async function draft(source, id = "demo") {
  const modules = ["narrative-controls", "narrative-memory", "world-narrative-coordinator", "local-scene-narrative", "world-scope-narrative", "comfy-image-generation", "card-context-library"];
  await mkdir(source, { recursive: true });
  for (const module of modules) {
    const from = module === "card-context-library" ? resolve(import.meta.dirname, "../assets/card-context-library") : resolve(import.meta.dirname, "../../../../global-modules", module);
    await cp(from, join(source, "features", module), { recursive: true });
  }
  await writeFile(join(source, "manifest.json"), JSON.stringify({schema_version: 2, id, name: "Demo", feature_modules: modules.map(id => "features/" + id + "/module.json")}));
}


test("packages card-owned runtime and reports missing or edited dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-package-test-"));
  try {
    const source = join(root, "draft"), target = join(root, "demo");
    await draft(source);
    const result = await packageCardRuntime({ sourceCard: source, targetCard: target });
    assert.equal(result.cardId, "demo");
    assert.ok(result.fileCount > 50);
    assert.equal((await validateRuntimePackage(target)).ok, true);
    const writerPrompt = await readFile(join(target, "features", "narrative-controls", "prompts", "agents", "narrative-writer.md"), "utf8");
    assert.ok(writerPrompt.indexOf("你是专心写作的写手Haruki") < writerPrompt.indexOf("<第一写作指导>"));
    assert.ok(writerPrompt.includes("<第一写作指导>"));
    assert.doesNotMatch(writerPrompt, /\{\{include:/);
    await assert.rejects(readFile(join(target, "agents", "background-worker", "agent.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(target, "agents", "data-worker", "agent.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(target, "agents", "image-prompt-writer", "agent.json")), { code: "ENOENT" });
    const launch = JSON.parse(await readFile(join(target, "runtime", "launch.json"), "utf8"));
    const lock = JSON.parse(await readFile(join(target, "runtime-lock.json"), "utf8"));
    assert.equal(launch.engine.testedNodeMajor, Number(process.versions.node.split(".")[0]));
    assert.equal(lock.launchProtocolVersion, 1);
    assert.deepEqual(lock.externalDependencies, [{ name: launch.engine.name, testedVersion: launch.engine.testedVersion }]);
    await assert.rejects(packageCardRuntime({ sourceCard: source, targetCard: target }), /already exists/);
    await writeFile(join(target, "prompts", "system", "base.md"), "Creator edit\n");
    const edited = await validateRuntimePackage(target);
    assert.equal(edited.ok, true);
    assert.ok(edited.changed.includes("prompts/system/base.md"));
    await rm(join(target, "runtime", "engine", "lib", "rp-workflows.mjs"));
    const missing = await validateRuntimePackage(target);
    assert.equal(missing.ok, false);
    assert.ok(missing.errors.some(value => value.includes("rp-workflows.mjs")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a card-specific Agent prompt expands its includes and rejects missing templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-agent-include-test-"));
  try {
    const source = join(root, "draft"), target = join(root, "demo");
    await draft(source);
    await writeFile(join(source, "features", "narrative-controls", "prompts", "agents", "narrative-writer.md"), "卡片专属开头\n{{include:agent-preferences/创作agent身份定位.md}}\n卡片专属结尾\n");
    await packageCardRuntime({ sourceCard: source, targetCard: target });
    const result = await readFile(join(target, "features", "narrative-controls", "prompts", "agents", "narrative-writer.md"), "utf8");
    assert.match(result, /卡片专属开头[\s\S]*你是专心写作的写手Haruki[\s\S]*卡片专属结尾/);
    assert.doesNotMatch(result, /\{\{include:/);
    await writeFile(join(source, "features", "narrative-controls", "prompts", "agents", "narrative-writer.md"), "{{include:agent-preferences/missing.md}}\n");
    await assert.rejects(packageCardRuntime({ sourceCard: source, targetCard: join(root, "another", "demo") }), /Missing Agent preference include/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an imported image module supplies its only Agent definition and prompt inside the card", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-package-test-"));
  try {
    const source = join(root, "draft"), target = join(root, "image-demo");
    const module = resolve(import.meta.dirname, "../../../../global-modules/comfy-image-generation");
    await mkdir(source);
    await writeFile(join(source, "manifest.json"), JSON.stringify({ schema_version: 2, id: "image-demo", name: "Image Demo", feature_modules: ["features/comfy-image-generation/module.json"] }));
    await cp(module, join(source, "features", "comfy-image-generation"), { recursive: true });
    await packageCardRuntime({ sourceCard: source, targetCard: target });
    const validation = await validateRuntimePackage(target);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    const agent = JSON.parse(await readFile(join(target, "features", "comfy-image-generation", "agents", "image-prompt-writer", "agent.json"), "utf8"));
    await assert.rejects(readFile(join(target, "agents", "image-prompt-writer", "agent.json")), { code: "ENOENT" });
    const moduleAgent = JSON.parse(await readFile(join(target, "features", "comfy-image-generation", "agents", "image-prompt-writer", "agent.json"), "utf8"));
    assert.deepEqual(agent, moduleAgent);
    assert.equal(agent.promptFile, "prompts/agents/image-prompt-writer.md");
    const context = { context: { cwd: root }, cardDirectory: target, featureModules: await loadCardComponents(target), playerName: "阿岚", isolatedRuntime: true };
    const result = await playPromptSources(context, null, agent, { id: "generate" }, join(root, "workspace"), ["read"]);
    assert.match(JSON.stringify(result.agent), /画面内容提示词撰写者/);
    assert.doesNotMatch(JSON.stringify(result.agent), /guideId/);
    const nodePrompt = await readFile(join(target, "features", "comfy-image-generation", "prompts", "workflows", "agent-image-generation", "generate-content-prompts.md"), "utf8");
    assert.match(nodePrompt, /guideId/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a new conversion and changed source templates do not change an older card package", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-package-test-"));
  try {
    const source = join(root, "draft"), template = join(root, "template");
    await draft(source);
    await cp(resolve(import.meta.dirname, "../assets"), join(template, "assets"), { recursive: true });
    const first = join(root, "card-a", "demo"), second = join(root, "card-b", "demo");
    await packageCardRuntime({ sourceCard: source, targetCard: first, templateRoot: template });
    const file = join("runtime", "engine", "lib", "rp-card-text.mjs");
    const original = await readFile(join(first, file), "utf8");
    await writeFile(join(template, "assets", "pi-rp-runtime", ".pi", "lib", "rp-card-text.mjs"), "export const changed = true;\n");
    await packageCardRuntime({ sourceCard: source, targetCard: second, templateRoot: template });
    assert.equal(await readFile(join(first, file), "utf8"), original);
    assert.notEqual(await readFile(join(second, file), "utf8"), original);
    assert.equal((await validateRuntimePackage(first)).ok, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installing the selector is separate from packaging and updates retain recent history", async () => {
  const root = await mkdtemp(join(tmpdir(), "rp-launcher-install-test-"));
  try {
    const installer = resolve(import.meta.dirname, "install_launcher.mjs");
    await execFileAsync(process.execPath, [installer, root]);
    const history = join(root, "launcher", "state", "recent-cards.json");
    await mkdir(join(root, "launcher", "state"));
    await writeFile(history, '{"schemaVersion":1,"cards":[]}\n');
    await assert.rejects(execFileAsync(process.execPath, [installer, root]), /already exists/);
    await execFileAsync(process.execPath, [installer, root, "--update"]);
    assert.equal(await readFile(history, "utf8"), '{"schemaVersion":1,"cards":[]}\n');
    assert.match(await readFile(join(root, "launcher", "server.mjs"), "utf8"), /startLauncher/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
