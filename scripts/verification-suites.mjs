// 验证套件定义：以**目录**为单位发现测试，不使用逐个模块名称的易漏清单。
//
// 设计约束（来自实施方案 S2）：
// - 默认套件自动发现 ENGINE/lib、MODULES、Web 与各 Skill scripts 中实际属于发布源码的测试。
// - 排除项必须逐条给出原因，且排除的是"规则"而非"某个模块名"。
// - 不使用固定测试数量作为验收门槛；只报告发现数量与实际执行数量。
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// 源码树中不应被当作发布测试来源的目录（结构性排除，不含具体模块名）。
export const NEVER_DESCEND = new Set([
  ".git",
  "node_modules",
  ".tmp",
  ".verify",
  ".pi-rp-local",
  "play",                       // 本地游玩根：含已安装运行时、卡包、会话，不属于源码验证
  "my-cards",                   // 本地待转换素材
  "my-comfyui-wf",              // 本地 ComfyUI 素材
  "ref",                        // 本地参考材料，未被 Git 跟踪
  "local-development-records",  // 本机开发记录与一次性脚本
  ".card-maintenance-backups",
  ".workbuddy",
  "__pycache__",
  "headtree",
]);

// 已知依赖受限沙箱以外的能力（符号链接特权或子进程管道）的测试文件。
// 这些都是本机环境限制，不是被测代码的缺陷；每一项都保留原因供诊断。
// verify.mjs 的 --sandbox-skips 只打开原因诊断，不会把失败变成通过。
export const SANDBOX_DEPENDENT = new Map([
  [".agents/skills/adapt-comfyui-workflow/scripts/workflow-tools.test.mjs", "测试体自身 spawn 子进程（管道被拒）"],
  [".agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.test.mjs", "测试体自身 spawn 子进程（管道被拒）"],
  [".agents/skills/st-card-to-pi-rp/assets/pi-rp-launcher/server.test.mjs", "受限路径下夹具资源不可用"],
  [".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-agent-delivery.test.mjs", "依赖符号链接/junction 制造越界场景"],
  [".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-data-artifacts.test.mjs", "依赖符号链接制造越界场景"],
  [".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-document-sets.test.mjs", "测试体创建符号链接（EPERM）"],
  [".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-node-context.test.mjs", "测试体创建符号链接（EPERM）"],
  ["global-modules/narrative-memory/runtime/test/portable-package.test.mjs", "测试体自身 spawn 子进程（管道被拒）"],
]);

// Python 套件：测试是显式调用外部解释器的脚本，无法从文件名安全推断。
export const PYTHON_TESTS = [
  ".agents/skills/audit-and-upgrade-pi-rp-card/scripts/test_inventory_card.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_contract_samples.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_extract_card.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_name_templates.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_real_asset_validation.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_s8_behavior_baseline.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_s8_lint_undefined.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_skill_contract.py",
  ".agents/skills/st-card-to-pi-rp/scripts/test_validate_card_pack.py",
  ".agents/skills/st-card-to-pi-rp/tests/test_module_call_surface.py",
];

// Python 侧已知受阻于受限沙箱的项（临时目录 WinError 5），原因逐条记录。
export const PYTHON_SANDBOX_DEPENDENT = new Map([
  [".agents/skills/audit-and-upgrade-pi-rp-card/scripts/test_inventory_card.py", "tempfile 临时目录在受限沙箱不可用"],
  [".agents/skills/st-card-to-pi-rp/scripts/test_extract_card.py", "tempfile 临时目录在受限沙箱不可用"],
  [".agents/skills/st-card-to-pi-rp/scripts/test_name_templates.py", "tempfile 临时目录在受限沙箱不可用"],
  [".agents/skills/st-card-to-pi-rp/scripts/test_validate_card_pack.py", "tempfile 临时目录在受限沙箱不可用"],
]);

// 以目录为单位发现测试文件。root 为仓库根。
export function discoverTests(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (NEVER_DESCEND.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".test.mjs")) {
        found.push(relative(root, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(root);
  return found.sort();
}

// 套件划分：按**职责目录**分组，便于定向运行；同一文件只归属一个套件。
export const SUITE_ORDER = ["engine", "web", "modules", "tools"];

export function classify(file) {
  if (file.startsWith(".agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/")) return "engine";
  if (file.startsWith(".agents/skills/st-card-to-pi-rp/assets/pi-rp-web/")) return "web";
  if (file.startsWith("global-modules/")) return "modules";
  return "tools"; // 其余 Skill scripts 与 pi-rp-launcher
}

export function groupSuites(files) {
  const groups = Object.fromEntries(SUITE_ORDER.map(name => [name, []]));
  for (const file of files) groups[classify(file)].push(file);
  return groups;
}

// 声明式检查（生成一致性与发布完整性）：只以 --check / 只读模式运行。
export const GENERATED_CHECKS = [
  {
    id: "generated:template-assets",
    label: "生成副本一致性（模板资产）",
    command: [".agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.mjs", "--check"],
    reason: "校验模板/故事规范的生成副本与唯一维护源一致；不写入。",
  },
  {
    id: "generated:story-mechanics",
    label: "生成副本一致性（故事机制）",
    command: [".agents/skills/create-pi-rp-feature-module/scripts/sync_story_mechanics.mjs", "--check"],
    reason: "同上，覆盖故事机制规范。",
  },
  {
    id: "release:manifest",
    label: "发布清单与白名单完整性",
    command: [".agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs"],
    reason: "核对发布路径存在、模块声明一致且发布文件未被 Git 忽略。",
  },
  {
    id: "acceptance:global-conditions",
    label: "架构结构门槛（行为由测试套件验证）",
    command: ["scripts/verification-acceptance.mjs"],
    reason: "检查依赖方向、配置入口和职责拆分；不读取本机记录，不把文件存在当作行为验收。",
  },
];

// 离线集成验收：需要明确的 Pi 宿主，缺失即失败（不得静默跳过）。
// 这里声明的是**可离线执行**的宿主级验收，不调用真实模型或 ComfyUI：
//   1. 用 Pi 自带的 esbuild 转译 Pi 扩展入口，验证宿主能离线加载该入口；
//   2. 构造满足当前 launch/lock 契约的夹具卡包，验证 validateRuntimePackage 的正例，
//      再篡改一个已登记文件，验证它能检出内容变化（不能只验证通过路径）。
// 真实设备与模型生成不属于默认验收。
export const INTEGRATION_CHECKS = [
  {
    id: "integration:pi-extension-transpile",
    label: "Pi 宿主离线转译扩展入口",
    kind: "transpile",
    reason: "用 Pi 自带 esbuild 转译 pi-rp-web.ts，覆盖扩展入口的语法与 import 解析。",
  },
  {
    id: "integration:runtime-package-fixture",
    label: "卡包 launch/lock 契约（夹具正反例）",
    kind: "runtime-package-fixture",
    reason: "在隔离夹具目录构造合规卡包并校验，再篡改文件确认变化被检出。",
  },
];

export function relativeToRoot(root, file) {
  return relative(root, join(root, file)).replaceAll("\\", "/");
}
