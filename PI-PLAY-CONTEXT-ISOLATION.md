# Pi 游玩上下文隔离

本仓库根目录用于转换、数据设计、模块开发和角色卡定制，`play/` 仅用于游玩。两者必须从不同工作目录启动新的 Pi 会话。完整开发边界见 [PI-RP-DEVELOPMENT-SCOPE.md](PI-RP-DEVELOPMENT-SCOPE.md)。

仅切换到 `play/` 还不够：Pi 会向上扫描直到 Git 根目录，并发现根目录下用于转换、维护和开发的 `.agents/skills/`。因此首次游玩前，需要在 `play/` 写入项目级资源覆盖，禁用这些根目录 skills。

## 首次设置

1. 退出当前用于转换的 Pi 会话，打开一个新终端并进入游玩目录：

   ```powershell
   cd M:\ai\SillyTavern\bobo-agent-rp\play
   ```

2. 打开 Pi 的项目级资源配置：

   ```powershell
   pi config -l --approve
   ```

3. 切换到项目级配置范围，将根目录发现的 `st-card-to-pi-rp`、`design-pi-rp-data`、`create-pi-rp-feature-module`、`adapt-comfyui-workflow`、`manage-pi-rp-config-ui`、`audit-and-upgrade-pi-rp-card`、`debug-pi-rp-play` 和 `codex-delegate-bounded-tasks` 设为 `unload`/禁用。只保留 `play-pi-rp`、`play-pi-rp-web` 和卡片自身用于游玩的 module Skills。

4. 保存并退出配置界面。Pi 会把覆盖写入 `play/.pi/settings.json`。该文件属于本地游玩环境，不应移动到仓库根目录。

5. 仍在 `play/` 中启动一个全新的游玩会话：

   ```powershell
   pi --approve
   ```

已有 Pi 会话不会因为切换工作目录或修改资源配置而自动清除已经载入的上下文，所以必须退出旧会话后重新启动；不要用根目录下的转换会话继续游玩。

## 日常使用

- 转换角色卡：在仓库根目录启动 Pi，输出到 `play/cards/<card-id>/`。
- 设计数据或开发模块：在仓库根目录调用 `design-pi-rp-data` 或 `create-pi-rp-feature-module`。
- 检查或升级既有卡：在仓库根目录明确调用 `audit-and-upgrade-pi-rp-card`，完成逐项讨论和最终确认后才修改目标卡。
- 排查游玩会话或工作流异常：在仓库根目录调用 `debug-pi-rp-play`，读取指定卡和会话的运行证据，并按用户选定的范围处理。
- 游玩角色卡：在 `play/` 启动 Pi，并使用 `play-pi-rp` 或 `play-pi-rp-web`。
- 即使开发目标位于 `play/cards/`，也不得从游玩会话直接修改卡包、模块、workflow、schema 或前端。
- 不要把转换素材、转换报告或根目录 `.agents/` 复制到 `play/`。
- 不要把 `play/sessions/`、`play/settings/` 或 `play/cards/` 移回仓库根目录。

## 更新运行时后

同步新版 `.pi` 运行时不会替代上面的项目级隔离设置。更新后检查 `play/.pi/settings.json` 仍存在；若任一根目录 skill 再次出现在游玩技能列表中，重新执行 `pi config -l --approve` 并将其设为项目级禁用，然后重启 Pi。
