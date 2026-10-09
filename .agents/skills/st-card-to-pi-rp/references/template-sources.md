# 模板的唯一维护来源

项目采用一个明确的维护源。某些模块必须独立复制进卡，因此源码仓库仍保留自动生成的模块副本；这些副本不单独编辑。发布检查会拒绝源与生成结果不一致的版本。

提示词文件的角色、装配顺序、引入机制和手写格式见[提示词目录、角色与手写指南](../assets/prompt-templates/README.md)。

## 维护位置

以下路径相对仓库根目录。

| 内容 | 唯一维护源 | 自动生成或复制的位置 |
| --- | --- | --- |
| 公共运行库、默认配置和公共提示词 | `.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/` | 新卡打包时复制到卡片公共层；只提供 engine、tools、system、model heads/tails 和其他 common prompts |
| Agent 默认引用、可选提示词与静态资料模板 | `.agents/skills/st-card-to-pi-rp/assets/prompt-templates/` | Agent 提示词显式引用的 `agent-preferences/` 片段在新卡打包时展开；其他片段仅在转卡方案明确选中后拼入卡内；`prompt-templates/` 不会整目录打包 |
| 正文 Agent、正文入口和最近故事准备 | `global-modules/narrative-controls/` | 作为完整模块复制到 `features/narrative-controls/`，包含 `narrative-writer`、`standard-rp`、`advanced-memory-rp` 和 `prepare-recent-narrative-stories`；不是只有可选控件 |
| 生图 Agent、工作流和运行时 | `global-modules/comfy-image-generation/` | 选中后完整复制到 `features/comfy-image-generation/`；模块内同时保留 `agent-image-generation` 与 `agent-image-generation-entry`，不复制到卡根 `agents/` 或 `workflows/` |
| 记忆、导演及场景叙事模块 | 对应的 `global-modules/<module-id>/` | 选中后完整复制到 `features/<module-id>/`，保留模块内的 `agents/`、`prompts/`、`workflows/`、`runtime/`、`documents/` 和 `module.json`；每个 schema 7 manifest 以 `agentFiles`/`workflowFiles` 注册全部组件 |
| 模块 Agent、节点提示词和运行时代码 | 对应的 `global-modules/<module-id>/` | `promptFile`/`entryFile` 保持模块相对路径；工作流 schema 4 的 `ownerModuleId`、Agent/工作流/触发器引用和 profile key 使用全限定模块 ID |
| 叙事公共代码及故事 schema | `.agents/skills/create-pi-rp-feature-module/assets/story-narrative-runtime/` | 场景叙事、世界叙事、导演模块中的相应库及 schema |
| 模块测试的运行库定位器 | `.agents/skills/create-pi-rp-feature-module/assets/module-testing/runtime-test-runtime.mjs` | 记忆及导演模块的测试辅助文件 |
| Anima 的 ComfyUI API 图 | `global-modules/comfy-image-generation/profiles/anima/workflow.api.json` | `anima-simple/workflow.api.json`；两个 profile 自己的参数仍分别维护 |
| 卡内 Web、设定资料库、卡用辅助脚本 | 转卡 Skill 的 `assets/pi-rp-web/`、`assets/card-context-library/`、`assets/card-runtime/` | 转卡时复制进卡 |
| 模块专属定义、代码和资料 | 对应的 `global-modules/<id>/` | 选择模块后复制进卡 |

## 修改与检查

修改源文件后，在仓库根执行：

```powershell
node .agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.mjs
node .agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.mjs --check
node .agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs
```

同步命令只更新仓库里的已声明生成目标，不更新 `play/`、已转换卡或存档。

一致性检查同时拒绝公共运行时与不同全局模块重复声明同一个全限定 Agent ID。普通转卡可运行 `--check`，但不能为修复检查结果擅自更新根模板。

`assets/prompt-templates/` 中只含 HTML 注释或空白的文件是待填写入口，不是可发布模板。普通转卡不得展示或复制它们；填入实际内容后即可按目录内 `README.md` 的说明借用，不需要同步生成另一份根模板。模板子目录和文件可由创作者自由增删、改名和重组，转卡时递归检查实际文件。完整提示词来源清单见 [prompt-inventory.md](prompt-inventory.md)。

## 本次保留的相似结构

- 模块入口工作流与其同模块的子工作流只有在确有包装语义时才并存，例如 `narrative-memory-archive-entry` 与 `narrative-memory-archive`；两者均登记在同一 `module.json`，不在卡根另存一份。
- 场景叙事和世界叙事的模块清单、数据契约和调用入口虽然结构相似，但拥有不同的 ID、能力、提示词和设置。其公共执行代码及故事 schema 已共用维护源，不继续为少量声明字段增加生成层。
- 不同集合的空初始记录文件各自属于对应数据集合，不合并。

2026-09-20 检查覆盖根 Skills 和全局模块中的模板、脚本及资料，进行了全文重复比对、同名文件相似内容比对及引用核对。这里保证已列出的重复内容只有一个维护入口，不宣称不同业务文件不存在任何相似片段。
