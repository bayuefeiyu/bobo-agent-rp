# 提示词来源清单

本清单回答“项目里的提示词在哪里维护”。它同时列出创作类与非创作类来源，但不会把模块 Skill、静态资料或代码中的普通说明误称为提示词模板。

需要手写或组合提示词时，先阅读[提示词目录、角色与手写指南](../assets/prompt-templates/README.md)；本清单只负责定位唯一维护源。

## 维护规则

- 项目提供的 Agent 与 Agent／team 节点都以 `promptFile` 指向的 Markdown 为唯一正文来源；JSON 不重复保存正文。
- 运行时继续支持旧卡的内联 `prompt`，但新定义不要同时填写 `prompt` 与 `promptFile`。
- `assets/pi-rp-runtime/prompts/` 会进入新卡；`assets/prompt-templates/` 只供转卡时选取，不会被打包器整目录复制。
- 模块提示词由所属 `global-modules/<module-id>/prompts/` 维护。导入时复制到卡片 `prompts/modules/<module-id>/`；选中模块并复制进卡后，副本归该卡所有。

## Pi RP 通用运行时

| 类型 | 用途 | 唯一维护源 |
| --- | --- | --- |
| 基础 SYSTEM | 所有 Agent 节点的运行环境、工具和当前工作目录外壳 | `assets/pi-rp-runtime/prompts/system/base.md` |
| 工具说明 | 基础 SYSTEM 中各运行时工具的说明 | `assets/pi-rp-runtime/prompts/system/tools.json` |
| 总前置提示词 | 可选的卡级前置消息 | `assets/pi-rp-runtime/prompts/prefix/total.md` |
| 总尾部提示词 | 可选的卡级尾部消息 | `assets/pi-rp-runtime/prompts/tail/total.md` |
| 提示词角色配置 | 各提示词来源的默认角色及尾部模式；它是配置而非提示词正文 | `assets/pi-rp-runtime/prompts/context-options.json` |

以上路径均相对 `.agents/skills/st-card-to-pi-rp/`。

## 通用 Agent

| 类别 | Agent | 提示词正文 | Agent 定义 |
| --- | --- | --- | --- |
| 创作类 | 正文创作 Agent | `assets/pi-rp-runtime/prompts/agents/narrative-writer.md` | `assets/pi-rp-runtime/agents/narrative-writer/agent.json` |

## 通用工作流节点

| 类别 | 工作流／节点 | 提示词正文 | 工作流定义 |
| --- | --- | --- | --- |
| 创作类 | `standard-rp/write-narrative` | `assets/pi-rp-runtime/prompts/workflows/standard-rp/write-narrative.md` | `assets/pi-rp-runtime/workflows/standard-rp/workflow.json` |
| 创作类 | `advanced-memory-rp/write-narrative` | `assets/pi-rp-runtime/prompts/workflows/advanced-memory-rp/write-narrative.md` | `assets/pi-rp-runtime/workflows/advanced-memory-rp/workflow.json` |

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
| 叙事记忆检索 Agent | `narrative-memory-retriever.md` |
| 叙事记忆维护 Agent | `narrative-memory-maintainer.md` |
| 叙事记忆事件压缩 Agent | `narrative-memory-compressor.md` |
| 叙事记忆归档 Agent | `narrative-memory-archive-editor.md` |

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

起步材料位于 `assets/prompt-templates/`：通用 Agent 提示词可通过 `{{include:agent-preferences/路径.md}}` 引用默认片段，新卡打包时展开成完整的卡内提示词；其他 `agent-preferences/` 片段、`task-defaults/` 和 `static-materials/` 按转卡方案选择。具体规则见该目录的 `README.md`。模板目录本身不会进入卡片。

模块 `skill/SKILL.md`、静态创作资料、数据契约和 schema 会影响 Agent 工作，但各自承担模块规则、资料或结构约束，不属于这份“提示词模板来源”清单。
