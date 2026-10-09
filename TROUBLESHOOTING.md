# 故障排查

本文件收集在**本机与受限环境**下开发和验证时实际遇到的故障、已确认的根因和可用做法。

它只描述绕行与诊断，不改变验证标准。当前能力与限制见 [PROJECT_STATUS.md](PROJECT_STATUS.md)；正常开发流程见 [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md)。

---

## 1. `python` 命令无效或指向 Windows Store 占位程序

**症状**：`python --version` 没有输出并返回退出码 1；或 `python -V` 输出一段提示要求去 Microsoft Store 安装 Python。

**可能原因**：PATH 上的 `python.exe` 是 `%LOCALAPPDATA%\Microsoft\WindowsApps\` 下的应用执行别名，而非真实解释器；也可能是已安装的 Python 或 Conda 环境未加入当前终端的 PATH。命令查找失败不等于设备没有安装 Python。

**诊断**：

```powershell
# 真实解释器的位置与版本
foreach ($c in 'python','python3','py') {
  $p = Get-Command $c -ErrorAction SilentlyContinue
  if ($p) { "$c -> $($p.Source)"; & $c -V 2>&1 | Out-String } else { "$c -> NOT FOUND" }
}
```

**还必须检查 Anaconda / Conda 环境**：上述命令均不可用时，不要立即要求安装 Python 或跳过 Python 测试。继续查找 `conda`，在可用的终端中执行：

```powershell
conda info --base
conda env list
```

若当前终端也找不到 `conda`，检查设备上已安装的 Anaconda / Miniconda、Anaconda Prompt、`CONDA_EXE` / `CONDA_PREFIX` 环境变量及实际安装目录；必要时从 Anaconda Prompt 运行上述命令。Conda 本身不在 PATH 中，同样不能证明它未安装。根据列出的环境路径查找解释器：Windows 通常为 `<环境目录>\python.exe`，Linux/macOS 通常为 `<环境目录>/bin/python`。选择符合项目版本和依赖要求的环境，不默认使用 base，也不为查找解释器修改全局 PATH。

CUDA 与 Conda 是不同的软件：CUDA 可用于 GPU 计算，但是否安装 CUDA 不能替代 Python / Conda 解释器检查；本项目的 Python 校验与测试不以 CUDA 为前提。

**做法**：显式使用已确认的真实解释器。以下仅为位置示例，不保证任何设备都采用这些路径；还应检查自定义安装目录和 Conda 命名环境：

- Anaconda：`C:\ProgramData\anaconda3\python.exe` 或 `%USERPROFILE%\anaconda3\python.exe`
- 官方安装：`%LOCALAPPDATA%\Programs\Python\Python3xx\python.exe`
- 本机 Codex 运行时自带：`%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`

```powershell
$pythonExe = '<已确认的 Python 解释器绝对路径>'
& $pythonExe -V
& $pythonExe -c "import sys; print(sys.executable)"
& $pythonExe -c "import yaml; print('PyYAML', yaml.__version__)"
# 以上检查成功后，让统一验证入口使用同一个解释器（仅当前 PowerShell 会话）
$env:VERIFY_PYTHON = $pythonExe
npm run test:python
```

**注意**：不是每个 Python 都装了 `PyYAML`。Skill 快速校验需要它；缺少时应安装到所用解释器，而不是换一个恰好能通过的解释器。文档中的命令写 `python`，可替换为你确认可用的解释器（必要时加 `-X utf8`）。

只有完成系统命令、Conda 发行版及其环境、已知安装目录的检查后，才能报告“未找到可用解释器”；报告应列出检查范围，并区分命令不可见、解释器启动失败和依赖缺失，不能笼统断言设备未安装 Python。

---

## 2. `node --test` 因 `spawn EPERM` 失败

**症状**：

```
Error: spawn EPERM
  errno: -4048,
  code: 'EPERM',
  syscall: 'spawn'
```

**根因**：`node --test` 默认每个测试文件起一个子进程，并通过**管道**（命名管道）收集其标准输出。部分受限环境（包括本机使用的 DSH 文件沙箱）拒绝程序打开命名管道，因此启动子进程即失败——**这与被测代码无关**。

**诊断**：

```powershell
node --test <某个测试文件>              # 在受限环境下失败
node <某个测试文件>                      # 直接运行同一文件则通过
```

**做法（三选一）**：

1. **使用统一验证入口**——`npm run verify` 已经内置逐文件运行与结果解析，无需自己拼命令：

   ```powershell
   npm run verify
   ```

2. **逐文件直接运行**——在受限与非受限环境都工作：

   ```powershell
   foreach ($file in $runtimeTests) { node $file }
   ```

3. **关闭测试隔离**，让测试在运行器进程内执行，不再起子进程：

   ```powershell
   node --test --experimental-test-isolation=none <测试文件>
   ```

   该模式在 Node 24 上可用，同样在受限与非受限环境都工作。

**受限环境诊断**：`npm run verify -- --sandbox-skips` 会列出已登记的环境限制，但不会跳过测试或豁免失败。失败仍使命令以非零退出；最终须在具备所需能力的环境中不带此标志验证。

**排查提示**：确认失败位置。若堆栈显示 `node:internal/test_runner/runner` 与 `syscall: 'spawn'`，就是本环境限制；若显示断言失败或 `AssertionError`，则是真实测试失败。

---

## 3. 测试体内建符号链接或子进程的用例在受限环境被拒绝

**症状**：`EPERM: operation not permitted, symlink ...`，或测试体自身 `spawn` 得到 `EPERM`，或断言报 “Missing expected rejection”。

**根因**：沙箱拒绝创建符号链接（Windows 上还需要额外特权）并拒绝命名管道。于是“越界符号链接必须被拒绝”这类**依赖制造符号链接**的用例无法成立，报错来自夹具建立阶段而非被测代码。

**历史受限环境中曾受影响的用例**（仅作为排查线索；不能据此排除当前用例的真实缺陷）：

| 用例 | 原因 |
| --- | --- |
| `adapt-comfyui-workflow/scripts/workflow-tools.test.mjs` | 测试体 `spawn` |
| `create-pi-rp-feature-module/scripts/sync_template_assets.test.mjs` | 测试体 `spawn` |
| `narrative-memory/runtime/test/portable-package.test.mjs` | 测试体 `spawn` |
| `pi-rp-launcher/server.test.mjs` | 受限路径导致资源缺失 |
| `pi-rp-runtime/.pi/lib/rp-document-sets.test.mjs` | 测试体 `symlink` |
| `pi-rp-runtime/.pi/lib/rp-node-context.test.mjs` | 测试体 `symlink` |
| `pi-rp-runtime/.pi/lib/rp-agent-delivery.test.mjs` | 依赖符号链接制造越界 |
| `pi-rp-runtime/.pi/lib/rp-data-artifacts.test.mjs` | 同上，错误文案分支未走到 |

**做法**：在非受限 shell 中重跑这些用例才算完整验证。**不要**因为它们在受限环境失败就放宽断言或跳过整类测试；被测代码需要用它们保护。

---

## 4. 不要用 Windows PowerShell 文本管道处理本仓库的 UTF-8 文件

**症状**：读出的中文变成乱码；更严重的是，经管道往返写回后，文件**内容被不可逆截断**——前导多字节字符会把后续 ASCII 字符（含换行）一起吞掉。

**根因**：本机 Windows PowerShell 按 ANSI（CP936）而非 UTF-8 解码。

**做法**：

- 用编辑器或文件工具读写文件，不要用 `Get-Content` → 处理 → `Set-Content` 这样的往返。
- 需要统计或查找时，优先用 `git`、`rg` 或专用工具。
- 需要导出文件内容时，**不要用 PowerShell 的 `>` 重定向**——它会写成 UTF-16。优先让目标程序自己写文件（例如 `git checkout-index --prefix=`），不要经 shell 重定向。

---

## 5. `check_release_manifest.mjs` 在受限环境报 `git check-ignore failed.`

**现象**：脚本在 `assertIgnoreRules` 处抛出该错误，退出码 1。

**根因**：它以 `--stdin` 向 `git check-ignore` 传路径，即用管道写子进程标准输入。这与第 2 节是同一限制。

**做法**：在非受限 shell 中运行。只想确认白名单是否正确时，可以逐条直接查询（无需管道）：

```powershell
foreach ($p in 'README.md','DEVELOPER-GUIDE.md','play/settings/common.json') {
  git check-ignore --no-index -q -- $p
  "$p -> ignored=$($LASTEXITCODE -eq 0)"
}
```

`ignored=False` 表示该路径会进入发布集；私密路径（`play/` 下）必须为 `True`。

---

## 6. Python 测试报 `PermissionError: [WinError 5]` 于临时目录

**症状**：`tempfile.TemporaryDirectory` 的清理或嵌套 `mkdir` 抛出 `WinError 5 拒绝访问`，且用例在**建立阶段**就报错（与断言无关）。受影响：`test_validate_card_pack.py`、`test_extract_card.py`、`test_inventory_card.py`、`test_name_templates.py`。

**根因**：受限环境不允许在被接管的临时目录内继续建目录或删除。

**做法**：在非受限 shell 中重跑。不要在受限环境下据此判断校验器逻辑错误。需要本地快速迭代时，可把夹具目录指向工作区内一个被 Git 忽略的目录，而**不要**修改用例本身。

---

## 7. `pi --offline` 扩展加载失败

**症状**：离线加载 `pi-rp-web.ts` 时报 `EPERM`，位置在 `~/.pi/` 下建锁文件。

**根因**：写入仓库外的用户目录被拒绝。

**做法**：可用 `npm run verify:integration` 检查 Pi 提供的 esbuild 转译及打包契约；这不能替代真实 Pi 扩展加载。完整加载应在具备用户目录写入权限的环境中执行。

---

## 8. 改了卡内工作流定义却不生效

**症状**：修改了卡内工作流 JSON，重新打开会话仍按旧定义运行。

**根因**：引擎在**会话打开时**缓存卡内工作流定义。

**做法**：改动工作流定义后**重启 Pi** 再验证。
