# 提示词来源清单

本清单回答“项目里的提示词在哪里维护”。它同时列出创作类与非创作类来源，但不会把模块 Skill、静态资料或代码中的普通说明误称为提示词模板。

需要手写或组合提示词时，先阅读[提示词目录、角色与手写指南](../assets/prompt-templates/README.md)；本清单只负责定位唯一维护源。

## 维护规则

- 项目提供的 Agent 与 Agent／team 节点都以 `promptFile` 指向的 Markdown 为唯一正文来源；JSON 不重复保存正文。
- 新定义必须使用 `promptFile`，不保留旧的内联 `prompt` 兼容路径，也不同时填写两种来源。
- `assets/pi-rp-runtime/prompts/` 只提供卡片公共层的 system、tools、model heads/tails、prefix、tail 和其他 common prompts；`assets/prompt-templates/` 只供转卡时选取，不会被打包器整目录复制。
- 模块提示词由所属 `global-modules/<module-id>/prompts/` 维护。选中模块后完整复制到 `features/<module-id>/`，`promptFile` 继续使用模块相对路径；不把模块提示词拆到卡片根 `prompts/`、`agents/` 或 `workflows/`。
- 每个模块 schema 7 manifest 都以 `agentFiles` 和 `workflowFiles` 登记全部自有组件；工作流 schema 4 声明 `ownerModuleId`，Agent、工作流和触发器引用使用全限定 `module-id/local-id`。
- 模块运行时组件也随模块完整复制到 `features/<module-id>/runtime/`；代码节点的 `entryFile` 是模块相对路径，公共运行时只承载 engine、tools、system、model heads/tails 和 common prompts。

## Pi RP 通用运行时

| 类型 | 用途 | 唯一维护源 |
| --- | --- | --- |
| 基础 SYSTEM | 所有 Agent 节点的运行环境、工具和当前工作目录外壳 | `assets/pi-rp-runtime/prompts/system/base.md` |
| 工具说明 | 基础 SYSTEM 中各运行时工具的说明 | `assets/pi-rp-runtime/prompts/system/tools.json` |
| 总前置提示词 | 可选的卡级前置消息 | `assets/pi-rp-runtime/prompts/prefix/total.md` |
| 总尾部提示词 | 可选的卡级尾部消息 | `assets/pi-rp-runtime/prompts/tail/total.md` |
| 提示词角色配置 | 各提示词来源的默认角色及尾部模式；它是配置而非提示词正文 | `assets/pi-rp-runtime/prompts/context-options.json` |

以上路径均相对 `.agents/skills/st-card-to-pi-rp/`。

## 正文模块 Agent

| 类别 | Agent | 提示词正文 | Agent 定义 |
| --- | --- | --- | --- |
| 创作类 | 正文创作 Agent | `global-modules/narrative-controls/prompts/agents/narrative-writer.md` | `global-modules/narrative-controls/agents/narrative-writer/agent.json` |

## 正文模块工作流节点

| 类别 | 工作流／节点 | 提示词正文 | 工作流定义 |
| --- | --- | --- | --- |
| 创作类 | `narrative-controls/standard-rp/write-narrative` | `global-modules/narrative-controls/prompts/workflows/standard-rp/write-narrative.md` | `global-modules/narrative-controls/workflows/standard-rp/workflow.json` |
| 创作类 | `narrative-controls/advanced-memory-rp/write-narrative` | `global-modules/narrative-controls/prompts/workflows/advanced-memory-rp/write-narrative.md` | `global-modules/narrative-controls/workflows/advanced-memory-rp/workflow.json` |

没有 `prompt` 或 `promptFile` 的代码、调用、返回和结束节点不在此表中。

## 全局模块：创作与生图 Agent

这些模块 Agent 的定义通过 `promptFile` 引用模块自己的 Markdown。

| 类别 | Agent | 提示词正文 |
| --- | --- | --- |
| 创作类 | 近场叙事创作 Agent | `global-modules/local-scene-narrative/prompts/agents/local-narrative-writer.md` |
| 创作类 | 广域叙事创作 Agent | `global-modules/world-scope-narrative/prompts/agents/world-narrative-writer.md` |
| 专项生成 | 生图提示词 Agent | `global-modules/comfy-image-generation/prompts/agents/image-prompt-writer.md` |

近场、广域与生图节点的任务提示词：

- `global-modules/local-scene-narrative/prompts/workflows/create-story-candidate/write.md`
- `global-modules/world-scope-narrative/prompts/workflows/create-story-candidate/write.md`
- `global-modules/comfy-image-generation/prompts/workflows/agent-image-generation/generate-content-prompts.md`

## 全局模块：叙事记忆非创作 Agent

以下提示词位于 `global-modules/narrative-memory/prompts/agents/`：

| Agent | 提示词正文 |
| --- | --- |
| 叙事记忆检索 Agent | `global-modules/narrative-memory/prompts/agents/narrative-memory-retriever.md` |
| 叙事记忆维护 Agent | `global-modules/narrative-memory/prompts/agents/narrative-memory-maintainer.md` |
| 叙事记忆事件压缩 Agent | `global-modules/narrative-memory/prompts/agents/narrative-memory-compressor.md` |
| 叙事记忆归档 Agent | `global-modules/narrative-memory/prompts/agents/narrative-memory-archive-editor.md` |

节点任务位于 `global-modules/narrative-memory/prompts/workflows/<workflow-id>/<node-id>.md`：

| 工作流 | 含提示词的节点 |
| --- | --- |
| `global-modules/narrative-memory/workflows/narrative-memory-retrieve/workflow.json` | `memory-retrieval` |
| `global-modules/narrative-memory/workflows/narrative-memory-compression/workflow.json` | `plan-compression` |
| `global-modules/narrative-memory/workflows/narrative-memory-archive/workflow.json` | `archive-model` |
| `global-modules/narrative-memory/workflows/narrative-memory-range-repair/workflow.json` | `range-model` |
| `global-modules/narrative-memory/workflows/narrative-memory-maintenance/workflow.json` | `maintenance-model` |

## 全局模块：世界叙事统筹非正文 Agent

以下提示词位于 `global-modules/world-narrative-coordinator/prompts/agents/`：

| Agent | 提示词正文 |
| --- | --- |
| 世界叙事日常导演 | `world-narrative-daily-director.md` |
| 世界叙事深度导演 | `world-narrative-deep-director.md` |
| 非正文故事统审导演 | `world-narrative-story-reviewer.md` |
| 世界叙事完整性修复 Agent | `world-narrative-integrity-repairer.md` |
| 世界叙事数据维护 Agent | `world-narrative-maintainer.md` |
| 世界叙事总导演 | `world-narrative-team-leader.md` |
| 世界叙事会议秘书 | `world-narrative-team-secretary.md` |
| 世界叙事推演专家 | `world-narrative-team-expert.md` |

节点任务位于 `global-modules/world-narrative-coordinator/prompts/workflows/<workflow-id>/<node-id>.md`：

| 工作流 | 含提示词的节点 |
| --- | --- |
| `global-modules/world-narrative-coordinator/workflows/pre-director-update/workflow.json` | `adjust` |
| `global-modules/world-narrative-coordinator/workflows/post-director-update/workflow.json` | `review` |
| `global-modules/world-narrative-coordinator/workflows/review-story-candidates/workflow.json` | `review` |
| `global-modules/world-narrative-coordinator/workflows/deep-director-planning/workflow.json` | `plan` |
| `global-modules/world-narrative-coordinator/workflows/deep-director-team-planning/workflow.json` | `meeting` |
| `global-modules/world-narrative-coordinator/workflows/director-data-maintenance/workflow.json` | `maintain` |
| `global-modules/world-narrative-coordinator/workflows/director-integrity-repair/workflow.json` | `repair` |

## 可选提示词与静态资料模板

起步材料位于 `assets/prompt-templates/`：模块 Agent 提示词可通过 `{{include:agent-preferences/路径.md}}` 引用默认片段，新卡打包时展开成完整的卡内提示词；其他 `agent-preferences/` 片段、`task-defaults/` 和 `static-materials/` 按转卡方案选择。具体规则见该目录的 `README.md`。模板目录本身不会进入卡片。模块专属提示词仍随完整模块复制到 `features/<module-id>/prompts/`，并由模块相对 `promptFile` 引用。

模块 `skill/SKILL.md`、静态创作资料、数据契约和 schema 会影响 Agent 工作，但各自承担模块规则、资料或结构约束，不属于这份“提示词模板来源”清单。
