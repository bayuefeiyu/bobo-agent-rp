# 开发与验证指南

面向开发者的操作指南：从干净检出开始，如何安装开发依赖、运行验证、校验卡包与模块，以及本项目对生成副本和发布完整性的要求。

当前能力、限制和最新验证结果见 [PROJECT_STATUS.md](PROJECT_STATUS.md)；历史实施记录见 [DEVELOPMENT-HISTORY.md](DEVELOPMENT-HISTORY.md)；本机与受限环境的故障排查见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

> **不要从 `play/` 游玩环境发起开发。** 根目录修改不会传播到已安装运行时、已转换卡或 session。修改授权边界见 [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)。

## 1. 前置条件

| 工具 | 要求 | 说明 |
| --- | --- | --- |
| Node.js | 开发与验证需 24 或更高 | 打包运行时的最低声明为 20；开发测试和 TypeScript 源码执行使用 Node 24。两者见 `scripts/development-runtime.json`；本轮没有验证 Node 20 游玩。 |
| Pi Coding Agent | `@earendil-works/pi-coding-agent` | 游玩与转换流程的宿主。已验证版本记录在发布声明中（当前 `0.86.0`），由打包器写入 `runtime/launch.json` 与 `runtime-lock.json`。 |
| Python 3 | 3.9 或更高 | 仅用于卡包校验、卡提取与部分 Skill 契约测试；**不是**运行时依赖。需要 `PyYAML`（Skill 快速校验）。 |
| PowerShell | 5.1 或 pwsh 7+ | 文档中的命令以 PowerShell 给出。 |

**Python 环境查找约定（适用于所有开发设备及自动化执行者）**：不能仅因 `python` / `python3` / `py` 命令不可用，就判定设备未安装 Python。还必须检查 Anaconda、Miniconda 等 Conda 发行版及其环境；解释器可能已安装但未加入当前终端的 PATH。确认解释器路径、版本和 `PyYAML` 可用后，通过 `VERIFY_PYTHON` 显式指定给验证入口。具体查找步骤见 [故障排查第 1 节](TROUBLESHOOTING.md#1-python-命令无效或指向-windows-store-占位程序)；不要将某台设备的安装路径写成跨设备前提。

公共运行库保留原生 ESM，不引入前端构建工具。Pi 宿主加载 TypeScript 扩展并提供 typebox；根项目将相同版本的 typebox、TypeScript 和 Node 类型声明作为锁定的开发依赖，用于工具 Schema、交付夹具和类型检查。

## 2. 从干净检出开始

```powershell
git clone <repository-url>
cd bobo-agent-rp
```

仓库采用发布白名单：`.gitignore` 先排除根目录全部内容，再逐项放行发布资产。**克隆后只有被放行并已提交的文件存在**，`play/`、`my-cards/`、`local-development-records/` 等本机目录不会出现，这是预期行为。

开发依赖的安装命令与统一验证入口见下一节。

## 3. 验证

### 3.1 先安装开发依赖

从干净检出开始：

```powershell
npm ci --no-audit --no-fund
npm run verify:all
npm run typecheck
```

`package-lock.json` 固定开发依赖。完整离线集成还需要安装 `scripts/development-runtime.json` 声明的 Pi 版本；可通过 `VERIFY_PI_HOME` 指定安装根目录。Python 需满足前置条件并可导入 PyYAML；验证入口先探测系统命令，再检查 Conda 环境变量、环境清单及常见安装位置。自定义位置可设置 `VERIFY_PYTHON`；显式指定但无效的解释器会使验证失败，不会悄悄换用其他环境。

| 命令 | 范围 |
| --- | --- |
| `npm run verify` | 全部 Node/Python 基础套件、生成一致性、结构门槛、发布完整性。包含新卡打包后实际启动 Web、执行无模型工作流、保存和恢复聊天的离线夹具。 |
| `npm run verify:integration` | 检查已安装 Pi 的版本、扩展转译，以及 launch/lock 契约正反例。宿主缺失即失败。可加 `-- --card=<已打包卡目录>` 检查显式指定的产物。 |
| `npm run verify:all` | 基础验证与离线集成全部执行。 |
| `npm run typecheck` | 严格检查全部宿主 TypeScript 及 Pi 边界声明；错误即非零退出。 |
| `npm run typecheck:extension` | 与 `typecheck` 相同的严格检查入口，保留命令名称。 |
| `npm run verify:list` | 列出 Node 目录发现的测试，以及明确登记的 Python 套件；不执行。 |
| `npm run verify:acceptance` | 只检查架构结构门槛。文件存在或字符串匹配不能证明运行行为，不替代测试。 |
| `npm run test:engine` / `test:web` / `test:modules` / `test:tools` / `test:python` | 定向执行套件。 |
| `npm run check:generated` / `check:release` | 生成副本只读比较与发布清单检查。 |

### 3.2 结果与验证边界

验证会报告测试文件的发现、执行、未执行数量和可解析的用例数；环境缺失、测试失败、声明检查失败分别列出并使命令失败。每次运行重建被忽略的 `.verify/`，其中 `results.json` 保存本次结果，各文件日志保存完整输出。需长期保留的结果应另存为开发记录。

架构结构门槛检查宿主/Python/前端的静态 import、旧配置写入口移除、模块职责和依赖锁；不读取 `local-development-records/`，也不宣称实施方案所有条目仅凭此检查即可验收。Python 行为基线保留公开调用面与确定性探针，健康环境中的实际单元测试必须通过；历史权限错误不是必须复现的“预期行为”。

这些命令不调用真实模型 API 或 ComfyUI，不操作个人卡和游玩配置。交付夹具使用真实打包代码、复制后的宿主和 Web 服务，配合 Pi 接口替身执行无模型工作流；它不能替代真实 Pi 交互、模型调用或 GPU 生图验证。收尾证据与方案外调整见 [架构优化收尾记录](.agents/skills/st-card-to-pi-rp/references/architecture-closeout.md)。

### 3.3 受限环境

`--sandbox-skips` 仅输出已登记的环境限制诊断，**任何失败仍使验证失败**，不跳过用例、不豁免断言。

```powershell
npm run verify -- --sandbox-skips
```

最终验证须在具备所需能力的环境中不带此标志运行。不要仅凭 EPERM 或失败文件名称断言问题一定属于沙箱；先判断失败发生在夹具建立、进程启动还是实际断言。详见 [故障排查](TROUBLESHOOTING.md)。

### 3.4 单项校验

```powershell
# 显式使用已确认的解释器；不要因为 PATH 找不到 python 就跳过 Conda 检查
$env:VERIFY_PYTHON = '<已确认的 Python 解释器绝对路径>'
npm run test:python

# 只比较生成副本，不写入
node .agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.mjs --check
node .agents/skills/create-pi-rp-feature-module/scripts/sync_story_mechanics.mjs --check

# 发布清单默认检查工作区
node .agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs

# 模块或显式指定的卡包
python -X utf8 global-modules/narrative-memory/scripts/validate-module.py
python -X utf8 .agents/skills/st-card-to-pi-rp/scripts/validate_card_pack.py <卡包目录>
git diff --check
```

发布前可用 `check_release_manifest.mjs --staged` 或 `--commit <ref>` 检查实际待发布的 Git 文件集。工作区检查允许当前未提交的新文件，不能证明它们已进入提交。

## 4. 交付与打包

卡包在临时目录构建并校验后再发布，发布产物自带 `runtime-lock.json`：

```powershell
node .agents/skills/st-card-to-pi-rp/scripts/package_card_runtime.mjs <临时卡目录> play/cards/<新卡ID>
node .agents/skills/st-card-to-pi-rp/scripts/validate_runtime_package.mjs play/cards/<新卡ID>
```

启动器独立安装，不由每次转卡顺带覆盖：

```powershell
node .agents/skills/st-card-to-pi-rp/scripts/install_launcher.mjs play
node play/launcher/server.mjs play
```

## 5. 开发约定

**验证的纪律**

- `verify` 与各 `--check` 命令**不得**执行同步、安装、转卡或修复操作。生成一致性只运行显式 `--check`。
- 测试可以在隔离夹具目录创建与清理文件，但不能改写源码。
- 默认验证不访问 `play/`、全局 Pi 用户状态、个人设置或网络服务。
- 默认验证不调用真实模型或 ComfyUI。若另行执行真实调用，应单独记录输入、环境、范围和结果。

**生成副本**

模板与故事规范存在“单一维护源 + 受校验的生成副本”。修改时改**维护源**，再用不带 `--check` 的同步命令重新生成，最后用 `--check` 确认一致。**不要手工修改生成副本**去让检查通过。维护位置见 [.agents/skills/st-card-to-pi-rp/references/template-sources.md](.agents/skills/st-card-to-pi-rp/references/template-sources.md)。

**发布白名单**

根目录新增文件不会自动进入版本控制或发布：既要按需在 `.gitignore` 精确放行，也要在 [PROJECT-RELEASE-MANIFEST.json](PROJECT-RELEASE-MANIFEST.json) 登记必须存在的发布路径。放行时只加新正式文件，不要把被忽略目录整体纳入。

**文件读写**

本仓库大量文件是 UTF-8 且含中文。**不要用 Windows PowerShell 文本管道读写这些文件**——它会按 ANSI（CP936）解码，造成不可逆损毁。使用编辑器或文件工具。详见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 第 4 节。
