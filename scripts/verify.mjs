#!/usr/bin/env node
// 统一验证入口（实施方案 S2）。
//
// 设计要点：
// - 不调用外部模型或网络服务；默认不触碰 play/、全局 Pi 用户状态或个人设置。
// - 不执行同步、安装、转卡或修复操作；生成一致性只以 --check 运行。
// - Node 测试逐文件运行，并把每个文件的 TAP 结果写入 .verify/ 日志后解析。
//   逐文件运行（而非 `node --test <glob>`）是因为后者通过管道收集子进程输出，
//   在受限环境下会被拒（spawn EPERM）；逐文件在受限与非受限环境都工作。
// - 启动失败、超时、非零退出码、以及缺失的必需套件都使整体验证失败。
// - Python 缺失时报告环境缺失并使该必需套件失败，不静默忽略整类测试。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERATED_CHECKS,
  INTEGRATION_CHECKS,
  PYTHON_TESTS,
  PYTHON_SANDBOX_DEPENDENT,
  SANDBOX_DEPENDENT,
  SUITE_ORDER,
  discoverTests,
  groupSuites,
} from "./verification-suites.mjs";
import { checkPiExtensionTranspile, checkRuntimePackageFixture } from "./verification-integration.mjs";
import { detectPython } from "./python-environments.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, "..");
const runtime = JSON.parse(readFileSync(join(scriptsDir, "development-runtime.json"), "utf8"));
const logDir = join(root, ".verify");
const PER_FILE_TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 300000);

// ---------------------------------------------------------------- arguments --
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};
const mode = valueOf("--mode") || (has("--mode=integration") ? "integration" : "base");
const onlySuite = valueOf("--suite");
const listOnly = has("--list");
const sandboxSkips = has("--sandbox-skips");
const integrationCard = valueOf("--card");

if (!["base", "integration", "all"].includes(mode)) {
  console.error(`Unknown --mode=${mode}; expected base, integration or all.`);
  process.exit(2);
}

// ------------------------------------------------------------------ helpers --
const results = [];
const record = (entry) => { results.push(entry); return entry; };

function ensureCleanLogDir() {
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(logDir, { recursive: true });
}

// 管道在被拒环境不可用，因此子进程输出写入文件后读取，绝不使用 piped stdio。
function spawnToLog(command, args, logName) {
  const logPath = join(logDir, `${logName}.log`);
  const fd = openSync(logPath, "w");
  const started = Date.now();
  let res;
  try {
    res = spawnSync(command, args, { cwd: root, stdio: ["ignore", fd, fd], timeout: PER_FILE_TIMEOUT_MS });
  } finally {
    closeSync(fd);
  }
  const durationMs = Date.now() - started;
  const output = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  const spawnFailed = res.error && res.error.code !== "ETIMEDOUT";
  return {
    status: res.status,
    durationMs,
    output,
    logPath,
    timedOut: Boolean(timedOut),
    spawnError: spawnFailed ? res.error.code || res.error.message : null,
  };
}

// 解析 `node --test` 的 TAP 汇总（tests/pass/fail/skipped）。
function parseTap(output) {
  const pick = (label) => {
    const m = output.match(new RegExp(`^[#ℹ]\\s*${label}\\s+(\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  return {
    tests: pick("tests"),
    pass: pick("pass"),
    fail: pick("fail"),
    skipped: pick("skipped"),
    todo: pick("todo"),
  };
}

// 解析 Python unittest 的汇总（Ran N tests / OK / FAILED）。
function parsePython(output) {
  const ran = output.match(/^Ran (\d+) tests? in /m);
  const failed = output.match(/^FAILED \((.*)\)$/m);
  const errors = failed ? Number((failed[1].match(/errors=(\d+)/) || [])[1] || 0) : 0;
  const failures = failed ? Number((failed[1].match(/failures=(\d+)/) || [])[1] || 0) : 0;
  return {
    tests: ran ? Number(ran[1]) : null,
    fail: errors + failures,
    ok: /^OK\b/m.test(output),
  };
}

function firstDiagnostic(output, limit = 12) {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((l) => /not ok|✖|FAILED|Traceback|Error:|AssertionError/.test(l));
  if (start < 0) return lines.filter(Boolean).slice(-limit).join("\n");
  return lines.slice(start, start + limit).join("\n");
}

// ------------------------------------------------------------ environment ----
function detectNode() {
  const major = Number(process.versions.node.split(".")[0]);
  const baseline = runtime.node?.developmentMajor ?? 24;
  return {
    id: "env:node",
    label: "Node 基线",
    kind: "env",
    ok: major >= baseline,
    detail: `v${process.versions.node}（基线 major >= ${baseline}，开发验证于 v${runtime.node?.verifiedVersion}）`,
  };
}

// Pi 宿主定位：统一位置，替代各测试自行猜测 APPDATA。
// VERIFY_PI_HOME 为显式覆盖：设置后只在该目录下解析，便于验证“宿主缺失”路径。
function detectPiHost() {
  const name = runtime.engine?.name || "@earendil-works/pi-coding-agent";
  const packageParts = name.split("/");
  const candidates = [];
  if (process.env.VERIFY_PI_HOME) {
    candidates.push(join(process.env.VERIFY_PI_HOME, "node_modules", ...packageParts));
    candidates.push(join(process.env.VERIFY_PI_HOME, ...packageParts));
  } else {
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "npm", "node_modules", ...packageParts));
    candidates.push(join(homedir(), ".npm-global", "lib", "node_modules", ...packageParts));
    candidates.push(join(homedir(), "node_modules", ...packageParts));
  }
  for (const dir of candidates) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      return { dir, name: pkg.name, version: pkg.version };
    } catch { /* keep looking */ }
  }
  return null;
}

// ------------------------------------------------------------------- runner --
function runNodeTest(file) {
  const logName = file.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "");
  // `--experimental-strip-types`：被检查的测试可能导入 `.ts` 模块（S5 起，拆出的宿主模块是
  // TypeScript）。Node 24 支持类型剥离，因此无需构建步骤即可直接运行这类测试。
  const res = spawnToLog(process.execPath, ["--test", "--experimental-test-isolation=none", "--experimental-strip-types", file], logName);
  const tap = parseTap(res.output);
  const sandboxReason = SANDBOX_DEPENDENT.get(file) || null;
  const failed = res.status !== 0;
  const sandboxDiagnostic = Boolean(failed && sandboxReason && sandboxSkips);
  return record({
    id: `node:${file}`,
    label: file,
    kind: "test",
    ok: !failed,
    failed,
    sandboxDiagnostic,
    sandboxDiagnosticReason: sandboxDiagnostic ? sandboxReason : null,
    skipCandidateReason: sandboxReason,
    durationMs: res.durationMs,
    counts: tap,
    detail: failed ? firstDiagnostic(res.output) : null,
    logPath: failed ? res.logPath : null,
    timedOut: res.timedOut,
    spawnError: res.spawnError,
  });
}

function runPythonTest(file, python) {
  const logName = `py_${file.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const res = spawnToLog(python.exe, [...python.args, "-X", "utf8", file], logName);
  const parsed = parsePython(res.output);
  const sandboxReason = PYTHON_SANDBOX_DEPENDENT.get(file) || null;
  const failed = res.status !== 0;
  const sandboxDiagnostic = Boolean(failed && sandboxReason && sandboxSkips);
  return record({
    id: `python:${file}`,
    label: file,
    kind: "test",
    ok: !failed,
    failed,
    sandboxDiagnostic,
    sandboxDiagnosticReason: sandboxDiagnostic ? sandboxReason : null,
    skipCandidateReason: sandboxReason,
    durationMs: res.durationMs,
    counts: { tests: parsed.tests, pass: parsed.tests !== null ? parsed.tests - parsed.fail : null, fail: parsed.fail, skipped: null, todo: null },
    detail: failed ? firstDiagnostic(res.output) : null,
    logPath: failed ? res.logPath : null,
    timedOut: res.timedOut,
    spawnError: res.spawnError,
  });
}

function runScriptCheck(check) {
  const [script, ...args] = check.command;
  const logName = check.id.replace(/[^A-Za-z0-9]+/g, "_");
  const res = spawnToLog(process.execPath, [script, ...args], logName);
  return record({
    id: check.id,
    label: check.label,
    kind: "check",
    ok: res.status === 0,
    failed: res.status !== 0,
    sandboxDiagnostic: false,
    durationMs: res.durationMs,
    counts: null,
    detail: res.status === 0 ? null : firstDiagnostic(res.output),
    logPath: res.status === 0 ? null : res.logPath,
    reason: check.reason,
    timedOut: res.timedOut,
    spawnError: res.spawnError,
  });
}

// `git check-ignore` 只在通过**管道**批量传入路径时才被受限环境拒绝；用文件描述符
// 重定向并逐项传参可以正常执行。因此这里提供一个环境无关的白名单检查，而完整清单
// 检查（check_release_manifest.mjs）仍按原样运行并在受限环境下如实报告受阻。
function gitCheckIgnore(paths) {
  if (!paths.length) return { available: true, ignored: new Set() };
  const logName = "git-check-ignore";
  const logPath = join(logDir, `${logName}.log`);
  const fd = openSync(logPath, "w");
  const res = spawnSync("git", ["check-ignore", "--no-index", "--", ...paths], { cwd: root, stdio: ["ignore", fd, fd], timeout: 60000 });
  closeSync(fd);
  if (res.error || ![0, 1].includes(res.status)) return { available: false, ignored: new Set() };
  const output = readFileSync(logPath, "utf8");
  return { available: true, ignored: new Set(output.split(/\r?\n/).map((l) => l.trim().replaceAll("\\", "/")).filter(Boolean)) };
}

function checkReleaseIgnoreRules() {
  const started = Date.now();
  const manifestPath = "PROJECT-RELEASE-MANIFEST.json";
  const fail = (detail) => record({
    id: "release:ignore-rules", label: "发布白名单与私密路径隔离", kind: "check",
    ok: false, failed: true, sandboxDiagnostic: false, durationMs: Date.now() - started, counts: null, detail, logPath: null,
  });
  if (!existsSync(join(root, manifestPath))) return fail(`${manifestPath} 不存在。`);

  let manifest;
  try { manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8")); }
  catch (error) { return fail(`${manifestPath} 不是合法 JSON：${error.message}`); }

  // 1. 必需发布路径必须存在。
  const missing = (manifest.requiredPaths || []).filter((p) => !existsSync(join(root, p)));
  if (missing.length) return fail(`发布清单声明的路径不存在：\n${missing.map((p) => `  - ${p}`).join("\n")}`);

  // 2. 发布路径不得被 Git 忽略（否则不会进入发布集）。
  const releasePaths = [...(manifest.requiredPaths || [])];
  for (const moduleId of manifest.modules || []) releasePaths.push(`global-modules/${moduleId}`);
  const release = gitCheckIgnore(releasePaths);
  if (!release.available) return fail("无法执行 git check-ignore（缺少 git 或不可用）。");
  const wronglyIgnored = releasePaths.filter((p) => release.ignored.has(p));
  if (wronglyIgnored.length) return fail(`以下发布路径被 Git 忽略规则排除：\n${wronglyIgnored.map((p) => `  - ${p}`).join("\n")}`);

  // 3. 私密游玩路径必须仍被忽略。
  const privateSentinels = ["play/settings/common.json", "play/cards/example/card.json", "play/sessions/example/chat/metadata.json"];
  const priv = gitCheckIgnore(privateSentinels);
  if (!priv.available) return fail("无法执行 git check-ignore（缺少 git 或不可用）。");
  const exposed = privateSentinels.filter((p) => !priv.ignored.has(p));
  if (exposed.length) return fail(`以下私密路径未被忽略：\n${exposed.map((p) => `  - ${p}`).join("\n")}`);

  return record({
    id: "release:ignore-rules", label: "发布白名单与私密路径隔离", kind: "check",
    ok: true, failed: false, sandboxDiagnostic: false, durationMs: Date.now() - started, counts: null,
    detail: `核对了 ${releasePaths.length} 个发布路径与 ${privateSentinels.length} 个私密路径。`, logPath: null,
  });
}

// 探测完整清单检查所需能力：它以 --stdin 管道调用 git check-ignore。
// 必须检查**内层**调用的结果——外层 node 进程自身会正常退出。
function probeReleaseManifestCapability() {
  const logPath = join(logDir, "release-manifest-probe.log");
  const code = [
    "const r=require('node:child_process').spawnSync('git',['check-ignore','--no-index','-z','--stdin'],{input:'README.md\\0'});",
    "process.stdout.write(r.error ? 'PROBE-UNAVAILABLE ' + r.error.code : 'PROBE-AVAILABLE');",
  ].join("");
  const fd = openSync(logPath, "w");
  spawnSync(process.execPath, ["-e", code], { cwd: root, stdio: ["ignore", fd, fd], timeout: 60000 });
  closeSync(fd);
  const probeOutput = readFileSync(logPath, "utf8");
  if (process.env.VERIFY_DEBUG) console.log(`[debug] release manifest capability probe -> ${JSON.stringify(probeOutput)}`);
  return probeOutput.trim().startsWith("PROBE-AVAILABLE");
}

// -------------------------------------------------------------------- report --
function displayWidth(text) {
  // 中日韩字符占两列，用于表格对齐。
  return [...String(text)].reduce((n, ch) => n + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
}

function pad(text, width) {
  const s = String(text);
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function printSummary() {
  const tests = results.filter((r) => r.kind === "test");
  const checks = results.filter((r) => r.kind === "check");
  const envs = results.filter((r) => r.kind === "env");
  const failedTests = tests.filter((r) => r.failed);
  const sandboxDiagnostics = tests.filter((r) => r.sandboxDiagnostic);
  const failedChecks = checks.filter((r) => !r.ok);
  const totalTests = tests.reduce((n, r) => n + (r.counts?.tests || 0), 0);
  const totalPass = tests.reduce((n, r) => n + (r.counts?.pass || 0), 0);
  const totalFail = tests.reduce((n, r) => n + (r.counts?.fail || 0), 0);
  const totalSkipped = tests.reduce((n, r) => n + (r.counts?.skipped || 0), 0);

  // 列宽按实际内容取值，保证长 id 也能对齐。
  const rows = [];
  const groups = new Map();
  for (const r of tests) {
    const name = suiteOf(r);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }
  for (const [name, list] of groups) {
    const f = list.reduce((n, r) => n + (r.counts?.tests || 0), 0);
    const p = list.reduce((n, r) => n + (r.counts?.pass || 0), 0);
    const fl = list.reduce((n, r) => n + (r.counts?.fail || 0), 0);
    const sk = list.reduce((n, r) => n + (r.counts?.skipped || 0), 0);
    const ms = list.reduce((n, r) => n + r.durationMs, 0);
    const bad = list.filter((r) => r.failed).length;
    const verdict = bad ? `失败 ${bad}` : "通过";
    rows.push([name, String(list.length), String(f), String(p), String(fl), String(sk), `${(ms / 1000).toFixed(1)}s`, verdict]);
  }
  for (const r of checks) rows.push([r.id, "-", "-", "-", "-", "-", `${(r.durationMs / 1000).toFixed(1)}s`, r.ok ? "通过" : "失败"]);
  for (const r of envs) rows.push([r.id, "-", "-", "-", "-", "-", "-", r.ok ? "通过" : "不满足"]);
  const header = ["套件", "文件", "用例", "通过", "失败", "跳过", "耗时", "结果"];
  const widths = header.map((h, i) => Math.max(...[h, ...rows.map((row) => row[i])].map(displayWidth)));
  const renderRow = (cells) => cells.map((c, i) => pad(c, widths[i])).join("  ").replace(/\s+$/, "");

  console.log("\n================ 验证汇总 ================");
  console.log(renderRow(header));
  for (const row of rows) console.log(renderRow(row));
  console.log("-".repeat(widths.reduce((n, w) => n + w + 2, 0)));
  const unexecuted = tests.filter(r => r.skippedByEnvironment || r.spawnError).length;
  console.log(`发现测试文件 ${tests.length} 个，执行 ${tests.length - unexecuted} 个（未执行 ${unexecuted}）；解析到用例 ${totalTests}（通过 ${totalPass} / 失败 ${totalFail} / 跳过 ${totalSkipped}）。`);

  if (envs.some((r) => !r.ok)) {
    console.log("\n环境预检未通过：");
    for (const r of envs.filter((x) => !x.ok)) console.log(`  - ${r.id}: ${r.detail}`);
  }
  if (sandboxDiagnostics.length) {
    console.log(`\n受限环境诊断 ${sandboxDiagnostics.length} 项（--sandbox-skips 只显示原因，失败仍会使验证失败）：`);
    for (const r of sandboxDiagnostics) console.log(`  - ${r.label}\n      原因：${r.sandboxDiagnosticReason}`);
  }
  if (failedTests.length) {
    console.log(`\n失败 ${failedTests.length} 项：`);
    for (const r of failedTests) {
      console.log(`  ✖ ${r.label}${r.timedOut ? "（超时）" : ""}${r.spawnError ? `（启动失败 ${r.spawnError}）` : ""}`);
      if (r.detail) console.log(r.detail.split("\n").map((l) => `      ${l}`).join("\n"));
      if (r.logPath) console.log(`      完整输出：${r.logPath}`);
    }
  }
  if (failedChecks.length) {
    console.log(`\n声明式检查失败 ${failedChecks.length} 项：`);
    for (const r of failedChecks) {
      console.log(`  ✖ ${r.label}（${r.id}）${r.timedOut ? "（超时）" : ""}${r.spawnError ? `（启动失败 ${r.spawnError}）` : ""}`);
      if (r.detail) console.log(r.detail.split("\n").map((l) => `      ${l}`).join("\n"));
      if (r.logPath) console.log(`      完整输出：${r.logPath}`);
    }
  }
  const envBlocked = envs.filter((r) => !r.ok);
  const ok = failedTests.length === 0 && failedChecks.length === 0 && envBlocked.length === 0;
  writeFileSync(join(logDir, "results.json"), JSON.stringify({
    mode, onlySuite, node: process.version, completedAt: new Date().toISOString(), ok,
    summary: { discoveredFiles: tests.length, executedFiles: tests.length - unexecuted, unexecutedFiles: unexecuted,
      parsedTests: totalTests, pass: totalPass, fail: totalFail, skipped: totalSkipped,
      failedTestFiles: failedTests.length, failedChecks: failedChecks.length, failedEnvironmentChecks: envBlocked.length },
    results,
  }, null, 2));
  console.log(`\n结果：${ok ? "通过" : "失败"}`);
  if (!ok && envBlocked.length && !failedTests.length && !failedChecks.length) {
    console.log("（失败原因为环境缺失，不是测试失败。）");
  }
  return ok ? 0 : 1;
}

function suiteOf(record) {
  const file = record.label;
  if (file.startsWith(".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/")) return "engine（公共运行库）";
  if (file.startsWith(".agents/skills/st-card-to-pi-rp/assets/pi-rp-web/")) return "web（前端与桥）";
  if (file.startsWith("global-modules/")) return "modules（全局模块）";
  if (file.endsWith(".py")) return "python（校验与提取）";
  return "tools（其余 Skill 脚本）";
}

// ---------------------------------------------------------------------- main --
ensureCleanLogDir();
writeFileSync(join(logDir, "run.json"), JSON.stringify({ mode, onlySuite, sandboxSkips, node: process.version, startedAt: new Date().toISOString() }, null, 2));

const allTests = discoverTests(root);
const groups = groupSuites(allTests);
const SCRIPT_SUITES = ["python", "generated", "release", "acceptance"];
const VALID_SUITES = [...SUITE_ORDER, ...SCRIPT_SUITES];
// 未指定 --suite 时运行全部 Node 测试套件；指定时只运行该套件。
const suitesToRun = onlySuite ? (SUITE_ORDER.includes(onlySuite) ? [onlySuite] : []) : SUITE_ORDER;
if (onlySuite && !VALID_SUITES.includes(onlySuite)) {
  console.error(`Unknown --suite=${onlySuite}; expected one of ${VALID_SUITES.join(", ")}.`);
  process.exit(2);
}

if (listOnly) {
  console.log(`发现 ${allTests.length} 个 Node 测试文件：`);
  for (const name of SUITE_ORDER) {
    console.log(`\n[${name}] ${groups[name].length} 个`);
    for (const file of groups[name]) console.log(`  ${file}${SANDBOX_DEPENDENT.has(file) ? "   # 受限环境依赖" : ""}`);
  }
  console.log(`\n[python] ${PYTHON_TESTS.length} 个`);
  for (const file of PYTHON_TESTS) console.log(`  ${file}${PYTHON_SANDBOX_DEPENDENT.has(file) ? "   # 受限环境依赖" : ""}`);
  console.log(`\n[generated/release] ${GENERATED_CHECKS.length} 项声明式检查`);
  for (const check of GENERATED_CHECKS) console.log(`  ${check.id}`);
  process.exit(0);
}

const includeBase = mode === "base" || mode === "all";
const includeIntegration = mode === "integration" || mode === "all";

if (includeBase) {
  record(detectNode());

  const pythonDetection = detectPython({
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    logDir,
  });
  const python = pythonDetection.python;
  // Python 只在默认运行或显式 --suite=python 时属于必需套件。
  const wantPython = !onlySuite || onlySuite === "python";

  if (wantPython) {
    record({
      id: "env:python",
      label: "Python 解释器与必需模块",
      kind: "env",
      ok: Boolean(python),
      detail: python
        ? `${python.exe}${python.args.length ? ` ${python.args.join(" ")}` : ""}（${python.source}），Python ${python.version}，PyYAML ${python.hasYaml ? "可用" : "**缺失**"}`
        : pythonDetection.error || "未找到可用 Python 3。设置 VERIFY_PYTHON=<exe> 指定解释器。",
    });
    if (python && !python.hasYaml) {
      record({ id: "env:python-yaml", label: "Python PyYAML", kind: "env", ok: false, detail: `${python.exe} 缺少 PyYAML；卡包/Skill 校验需要它。` });
    }
  }

  for (const name of suitesToRun) {
    for (const file of groups[name]) runNodeTest(file);
  }
  if (wantPython && python) {
    for (const file of PYTHON_TESTS) runPythonTest(file, python);
  }
  if (wantPython && !python) {
    for (const file of PYTHON_TESTS) {
      record({
        id: `python:${file}`,
        label: file,
        kind: "test",
        ok: false,
        failed: true,
        sandboxDiagnostic: false,
        skippedByEnvironment: true,
        durationMs: 0,
        counts: null,
        detail: "未找到可用 Python 3，该必需套件未能执行。",
        logPath: null,
      });
    }
  }

  const checksForSuite = (name) => {
    if (name === "generated") return GENERATED_CHECKS.filter((c) => c.id.startsWith("generated:"));
    if (name === "release") return GENERATED_CHECKS.filter((c) => c.id.startsWith("release:"));
    if (name === "acceptance") return GENERATED_CHECKS.filter((c) => c.id.startsWith("acceptance:"));
    return null;
  };
  const runReleaseChecks = () => {
    checkReleaseIgnoreRules();
    if (probeReleaseManifestCapability()) {
      for (const check of GENERATED_CHECKS.filter((c) => c.id.startsWith("release:"))) runScriptCheck(check);
    } else {
      record({
        id: "env:release-manifest-capability",
        label: "完整发布清单检查所需能力",
        kind: "env",
        ok: false,
        detail: "check_release_manifest.mjs 以 --stdin 管道调用 git check-ignore，本环境拒绝管道，因此完整清单检查未执行。"
          + "白名单与私密路径隔离已由 release:ignore-rules 覆盖；完整检查需在非受限 shell 中运行 npm run verify。",
      });
    }
  };
  const runGeneratedChecks = () => {
    for (const check of GENERATED_CHECKS.filter((c) => c.id.startsWith("generated:"))) runScriptCheck(check);
  };
  const runAcceptanceChecks = () => {
    for (const check of GENERATED_CHECKS.filter((c) => c.id.startsWith("acceptance:"))) runScriptCheck(check);
  };

  if (onlySuite === "generated") {
    results.length = 0;
    record(detectNode());
    runGeneratedChecks();
  } else if (onlySuite === "release") {
    results.length = 0;
    record(detectNode());
    runReleaseChecks();
  } else if (onlySuite === "acceptance") {
    results.length = 0;
    record(detectNode());
    runAcceptanceChecks();
  } else if (!onlySuite) {
    runGeneratedChecks();
    runAcceptanceChecks();
    runReleaseChecks();
  }
}

if (includeIntegration) {
  const pi = detectPiHost();
  record({
    id: "env:pi-host",
    label: "Pi 宿主",
    kind: "env",
    ok: Boolean(pi),
    detail: pi
      ? `${pi.name}@${pi.version}（声明已验证 ${runtime.engine?.testedVersion}）`
      : "未找到 Pi 宿主安装。集成模式要求明确宿主，环境缺失即失败（可设置 VERIFY_PI_HOME）。",
  });
  if (pi && pi.version !== runtime.engine?.testedVersion) {
    record({
      id: "env:pi-version",
      label: "Pi 版本与声明一致",
      kind: "env",
      ok: false,
      detail: `安装版本 ${pi.version} 与 development-runtime.json 声明 ${runtime.engine?.testedVersion} 不一致；请先验证再更新声明。`,
    });
  }

  if (pi) {
    // 1. 宿主能离线转译扩展入口。
    record(checkPiExtensionTranspile({
      root,
      logDir,
      piHostDir: pi.dir,
      entryFile: ".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts",
    }));
    // 2. 卡包 launch/lock 契约的夹具正反例。
    const fixtureDir = join(root, ".verify", "runtime-package-fixture");
    try {
      record(await checkRuntimePackageFixture({
        fixtureDir,
        engineName: runtime.engine?.name,
        engineVersion: runtime.engine?.testedVersion,
      }));
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  } else {
    for (const check of INTEGRATION_CHECKS) {
      record({
        id: check.id,
        label: check.label,
        kind: "check",
        ok: false,
        failed: true,
        sandboxDiagnostic: false,
        durationMs: 0,
        counts: null,
        detail: "未找到 Pi 宿主，离线集成验收无法执行（不静默跳过）。",
        logPath: null,
      });
    }
  }

  // 3. 若显式提供了已打包卡目录，再对真实产物跑一次同样的契约校验。
  if (integrationCard) {
    if (!existsSync(resolve(root, integrationCard))) {
      record({
        id: "integration:card",
        label: "指定的已打包卡目录",
        kind: "check",
        ok: false,
        failed: true,
        sandboxDiagnostic: false,
        durationMs: 0,
        counts: null,
        detail: `--card 指向的目录不存在：${integrationCard}`,
        logPath: null,
      });
    } else {
      runScriptCheck({
        id: "integration:card",
        label: `已打包卡契约校验（${integrationCard}）`,
        command: [".agents/skills/st-card-to-pi-rp/scripts/validate_runtime_package.mjs", integrationCard],
        reason: "对显式指定的真实卡包产物校验 launch/lock 与组件引用。",
      });
    }
  }
}

process.exitCode = printSummary();
