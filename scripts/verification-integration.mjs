// 离线集成检查的实现（S2）。全部在隔离夹具目录内完成，不调用真实模型、ComfyUI
// 或网络；结束时清理夹具。
//
// 受限环境注意：子进程输出不能走管道，因此这里的辅助函数把输出写入文件后读取。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { validateRuntimePackage } from "../.agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/validate-runtime-package.mjs";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------- esbuild ----
// 定位 Pi 自带的 esbuild 平台二进制。必须直接调用平台二进制：其 bin 包装脚本
// 使用管道子进程，在受限环境会被拒。
function resolveEsbuild(piHostDir) {
  const candidates = [];
  if (process.env.VERIFY_ESBUILD) candidates.push(process.env.VERIFY_ESBUILD);
  if (piHostDir) {
    const platformDir = `@esbuild/${process.platform === "win32" ? "win32-x64" : process.platform === "darwin" ? "darwin-x64" : "linux-x64"}`;
    const exe = process.platform === "win32" ? "esbuild.exe" : "esbuild";
    candidates.push(join(piHostDir, "node_modules", platformDir, exe));
    candidates.push(join(piHostDir, "node_modules", "esbuild", "bin", "esbuild"));
  }
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
  return null;
}

export function checkPiExtensionTranspile({ root, logDir, piHostDir, entryFile }) {
  const started = Date.now();
  const finish = (ok, detail, logPath = null) => ({
    id: "integration:pi-extension-transpile",
    label: "Pi 宿主离线转译扩展入口",
    kind: "check",
    ok,
    failed: !ok,
    excused: false,
    durationMs: Date.now() - started,
    counts: null,
    detail,
    logPath,
  });

  const esbuild = resolveEsbuild(piHostDir);
  if (!esbuild) {
    return finish(false, "未找到 Pi 自带的 esbuild 平台二进制（可设置 VERIFY_ESBUILD）。");
  }
  const source = join(root, entryFile);
  if (!existsSync(source)) return finish(false, `扩展入口不存在：${entryFile}`);

  const outFile = join(logDir, "pi-extension-transpile.mjs");
  const logPath = join(logDir, "pi-extension-transpile.log");
  const fd = openSync(logPath, "w");
  // `--bundle` 是必需的：只有在打包模式下 esbuild 才会**解析 import**。用 `--bundle=false`
  // 时它只逐文件转译，缺少的模块与写错的 specifier 都会被放过（本检查曾因此漏报一次）。
  const res = spawnSync(
    esbuild,
    [source, "--loader:.ts=ts", "--loader:.mjs=js", "--format=esm", "--bundle", "--platform=node", "--packages=external", `--outfile=${outFile}`],
    { cwd: root, stdio: ["ignore", fd, fd], timeout: 120000 },
  );
  closeSync(fd);
  const output = readFileSync(logPath, "utf8");

  if (res.error && res.error.code === "EPERM") {
    return finish(false, "受限环境拒绝了 esbuild 子进程调用（spawn EPERM）。", logPath);
  }
  if (res.status !== 0) {
    const lines = output.split(/\r?\n/).filter(Boolean).slice(0, 12).join("\n");
    return finish(false, `扩展入口转译失败：\n${lines}`, logPath);
  }
  // 转译产物必须存在且非空，避免"命令返回 0 但没有输出"被当成通过。
  if (!existsSync(outFile)) return finish(false, "esbuild 返回成功但没有产出文件。", logPath);
  const produced = readFileSync(outFile, "utf8");
  if (!produced.trim()) return finish(false, "esbuild 产出为空文件。", logPath);
  return finish(true, `转译成功：${relative(root, source)} → ${produced.length} 字节。esbuild ${readEsbuildVersion(esbuild)}`, logPath);
}

function readEsbuildVersion(exe) {
  // 版本仅用于展示；若无法取得则返回 "unknown"，不影响检查结果。
  try {
    const log = join(dirname(exe), ".esbuild-version.tmp");
    const fd = openSync(log, "w");
    const res = spawnSync(exe, ["--version"], { stdio: ["ignore", fd, fd], timeout: 30000 });
    closeSync(fd);
    const out = res.status === 0 ? readFileSync(log, "utf8").trim() : "";
    rmSync(log, { force: true });
    return out || "unknown";
  } catch {
    return "unknown";
  }
}

// --------------------------------------------------- runtime package fixture --
// 构造满足当前契约的最小卡包夹具。字段来自 validateRuntimePackage 实际读取的内容，
// 不使用真实卡或真实聊天数据。
export function buildRuntimePackageFixture(directory, { engineName, engineVersion }) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });

  const files = {
    "runtime/engine/extensions/pi-rp-web.ts": "export default function () {}\n",
    "runtime/engine/skills/play-pi-rp/SKILL.md": "# play\n",
    "runtime/engine/skills/play-pi-rp-web/SKILL.md": "# play web\n",
    "web/server.mjs": "export {};\n",
    "prompts/system/base.md": "# base\n",
    "prompts/system/tools.json": "{}\n",
    "defaults/common.json": "{}\n",
    "defaults/workflow-runtime.json": "{}\n",
    "defaults/model-profiles.json": JSON.stringify({ schemaVersion: 1, profiles: [] }) + "\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const target = join(directory, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }

  const cardId = "verify-fixture";
  const launch = {
    schemaVersion: 1,
    cardId,
    entry: "runtime/engine/extensions/pi-rp-web.ts",
    skills: ["runtime/engine/skills/play-pi-rp/SKILL.md", "runtime/engine/skills/play-pi-rp-web/SKILL.md"],
    engine: { name: engineName, testedVersion: engineVersion, testedNodeMajor: Number(process.versions.node.split(".")[0]) },
  };
  const manifest = { schemaVersion: 1, id: cardId, feature_modules: [] };
  const lock = {
    schemaVersion: 1,
    cardId,
    packageFormat: 2,
    runtimeVersion: "1.0.0",
    launchProtocolVersion: 1,
    testedNodeVersion: process.versions.node,
    externalDependencies: [{ name: engineName, testedVersion: engineVersion }],
    files: Object.fromEntries(Object.entries(files).map(([rel, content]) => [rel, sha256(content)])),
  };

  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(directory, "runtime", "launch.json"), JSON.stringify(launch, null, 2), "utf8");
  writeFileSync(join(directory, "runtime-lock.json"), JSON.stringify(lock, null, 2), "utf8");
  return { cardId, fileCount: Object.keys(files).length };
}

export async function checkRuntimePackageFixture({ fixtureDir, engineName, engineVersion }) {
  const started = Date.now();
  const finish = (ok, detail) => ({
    id: "integration:runtime-package-fixture",
    label: "卡包 launch/lock 契约（夹具正反例）",
    kind: "check",
    ok,
    failed: !ok,
    excused: false,
    durationMs: Date.now() - started,
    counts: null,
    detail,
    logPath: null,
  });

  const built = buildRuntimePackageFixture(fixtureDir, { engineName, engineVersion });

  // 正例：合规夹具必须通过。
  let result;
  try {
    result = await validateRuntimePackage(fixtureDir);
  } catch (error) {
    return finish(false, `校验夹具时抛出异常：${error.message}`);
  }
  if (!result.ok) {
    return finish(false, `合规夹具未通过校验：\n${result.errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  // 反例：篡改一个已登记文件，必须被报告为 changed（只验证通过路径不够）。
  const tampered = join(fixtureDir, "web", "server.mjs");
  writeFileSync(tampered, "export {}; // tampered\n", "utf8");
  const afterTamper = await validateRuntimePackage(fixtureDir);
  if (afterTamper.changed.length !== 1 || !afterTamper.changed.includes("web/server.mjs")) {
    return finish(false, `篡改文件未被检出：changed=${JSON.stringify(afterTamper.changed)}`);
  }

  // 反例：删除一个已登记文件，必须被报告（missing，而不是静默通过）。
  rmSync(join(fixtureDir, "defaults", "common.json"), { force: true });
  const afterDelete = await validateRuntimePackage(fixtureDir);
  const reported = [...afterDelete.errors, ...afterDelete.changed].some((e) => e.includes("defaults/common.json"));
  if (!reported) {
    return finish(false, "已删除的必需文件既未出现在 errors 也未出现在 changed 中。");
  }

  return finish(true, `夹具正例通过（${built.fileCount} 个登记文件）；篡改与缺失均被检出。`);
}
