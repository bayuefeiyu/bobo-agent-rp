# 正文团队协作

本文说明 `narrative-controls` 的 `team` 节点如何在保留既有会议协议的同时使用 `collaboration` 协议。它描述节点、成员、文件交付和配置覆盖的接口；工作流的通用边界仍以 [workflow-system.md](../../.agents/skills/st-card-to-pi-rp/references/workflow-system.md) 为准。

## 两种 team 协议

`team` 仍是一个工作流节点。`team.schemaVersion: 1`、未声明协议的旧配置，以及显式 `protocol: "meeting"` 都继续使用 v1 会议语义：Leader、Secretary、experts、agenda、base retrieval、assistants 和会议报告等旧字段及恢复语义保持不变。旧会议配置不会被自动改写成协作配置。

协作节点必须同时声明 `schemaVersion: 2` 和 `protocol: "collaboration"`。它使用成员列表和阶段责任，不使用会议专属的 `leader`、`secretary`、`experts`、`agenda`、`baseRetrieval` 或 `assistants` 字段；混用这些字段会在配置校验阶段失败。v1 meeting 和 v2 collaboration 共用 `team` 节点类型，但执行器、公开记录和交付规则按协议分别处理。

`delivery` 只接受普通 `agent` 节点，或协议为 `collaboration` 的 `team` 节点。v1 meeting 节点不能声明 Agent 文件交付。协作配置仍保留原工作流和节点 ID，因此下游依赖、输入、输出、调用绑定和 `turn-finalize` 引用不因模式切换而改变。

## v2 配置契约

协作配置至少需要以下结构：

- `members` 至少有两项。每项有唯一的安全 `id`、形如 `module-id/agent-id` 的全限定 `agentId`，以及只由 `read`、`write`、`edit`、`rp_files`、`rp_call` 组成的 `tools`。成员的 `label`、`prompt`、`focus` 和可选 `modelId` 不改变 ID 引用关系。
- `initialMemberId`、`stageOwnerId` 和 `completionMemberId` 都必须引用当前成员。它们分别指定初始发言者、阶段推进责任和节点完成责任，不授予超出成员工具列表的权限。
- `outputOwners` 为每一个需要成员生成的节点输出指定一个成员。运行时生成的 `metadata.documentWorkspaceSnapshot.output` 不属于成员输出，不填写 owner；除此之外，节点声明的每个输出都必须有 owner，且 owner 必须拥有 `write`。
- `limits.maxActivations`、`limits.maxToolCalls` 和 `limits.maxProtocolReminders` 必须是 1 到 10000 的正整数。省略时使用运行时默认值 32、128、2；这些值限制执行次数、工具调用和协议提醒，不等于固定讨论轮数。

如果节点声明了 `requiredCalls`，至少一名成员还必须具有 `rp_call`。成员只能调用父节点显式声明的 `workflowCalls`，所有成员共用该节点的调用额度。成员声明的基础工具还必须在其 Agent 配置中存在；启动前检查这一交集，避免成员拥有文件归属却无法写入。配置校验不会根据 `label` 或 `role` 推断权限；“主笔”“共创者”是提示词与默认配置的角色名称。

每次 provider 请求前都会执行上下文和资源 guard。运行时还用 `maxToolCalls + maxActivations * (maxProtocolReminders + 1)` 计算派生的请求预算，用来阻止畸形工具 schema 或重复提醒形成无界循环；它是资源上限，不是讨论轮数或模型质量判断。

一个最小的正文协作成员配置可以写成：

```json
{
  "schemaVersion": 2,
  "protocol": "collaboration",
  "initialMemberId": "writer",
  "stageOwnerId": "writer",
  "completionMemberId": "writer",
  "members": [
    {
      "id": "writer",
      "agentId": "narrative-controls/narrative-team-writer",
      "tools": ["read", "write", "edit", "rp_files"],
      "modelId": null
    },
    {
      "id": "co-creator",
      "agentId": "narrative-controls/narrative-co-creator",
      "tools": ["read", "write", "edit", "rp_files", "rp_call"],
      "modelId": null
    }
  ],
  "outputOwners": { "narrative": "writer" },
  "limits": {
    "maxActivations": 32,
    "maxToolCalls": 128,
    "maxProtocolReminders": 2
  }
}
```

## 发言、交接与默认正文角色

交接必须使用 `rp_team_handoff({"to": "member-id"})` 这一独立工具调用。两成员团队可以省略 `to` 表示交给另一名成员；多成员团队必须明确目标。目标必须是当前团队中除自己以外的有效成员。普通回复中的文字标记不会交接，运行时也不会从回复内容猜测交接。

交接提交公开事件后释放当前成员占用的模型槽位，再在同一个父 team 节点内让目标成员取得自己的模型槽位。它不会创建新的工作流节点，也不会把一个未完成的工具调用移交给另一名成员。工具执行按 activation 和调用 ID 保存回执；已经失去发言权的旧 activation 或 epoch 请求会被拒绝。

默认正文提示词采用一次聚焦交换：主笔先读取已授权资料并给出自己的判断和查询意图；共创者给出独立观点、补充、纠错并按需执行已声明的 `rp_call`；主笔读取公开结果、总结并进入下一阶段。通常只进行一轮 writer/co-creator 交换，必要时由提示词要求追加聚焦讨论；这是提示词协议，不是把讨论轮数写死在 schema 中。两者都可读取共享授权资料，并使用 `read`、`write`、`edit` 处理自己的工作文件；对方专属产物只能提出意见，不能越过文件归属直接修改。

在 shipped 的正文默认配置中，writer 拥有 `narrative`，使用基础文件工具并负责创作；co-creator 具有 `rp_call`，负责声明的工作流或模块工具调用和执行结果整理。只有 co-creator 使用 `rp_call`，只有 writer 对 `narrative` 做最终 `rp_deliver`。这是默认角色与提示词的协作约定；如果其他任务直接编辑通用 v2 配置，权限仍以成员 `tools`、节点 `workflowCalls` 和 `outputOwners` 的实际声明为准。

## 共享记录与文件交付

协作节点在 `team/shared/TRANSCRIPT.md` 保存全体成员可见的公开记录。记录包括公开分析、讨论和创作说明，工具名称、公开参数、完整可见结果和失败信息，读取的范围与文件版本，以及工作流调用、阶段、交接、交付和恢复事件。它记录可见结果而不是模型的隐藏思考；原始 chain-of-thought、provider 内部 reasoning 和其他未公开状态不会写入共享转录。

正文成员在节点工作区中读写各自允许的文件。最终文件和生成快照的接口保持普通 Agent 合同：

```text
<node-workspace>/
  narrative.md
  post-turn-context/
  team/shared/TRANSCRIPT.md
  ...
```

writer 将 `narrative.md` 写成原始正文文件，并用 `rp_deliver({"output":"narrative","path":"narrative.md"})` 交付；交付回执对应的是文件的原始内容，聊天中的最终文字不会替代该文件。`post-turn-context` 是节点结束后由运行时生成的 `document-workspace-snapshot` 合同，包含注册文档、明确交付结果和快照边界；它不是成员输出，也不进入 `outputOwners`。缺少交付回执、节点完成调用或文件内容不匹配时，节点按交付协议继续或失败，不能用一段普通回复伪造交付。

## 正文模式覆盖、预设与恢复

使用时，在配置面板的工作流页选择正文模块及 `standard-rp` 或 `advanced-memory-rp`，找到 `write-narrative` 节点，将“执行方式”改为“协作团队”，分别设置主笔和共创者的模型，然后保存配置方案。角色和工具保留默认值即可开始验证。可以填写“自定义阶段任务”替代默认任务；切回另一种模式再切回时会恢复这一设置。已安装卡是独立副本，需要在明确升级运行时和正文模块后才会出现此入口。

配置界面的正文模式切换是对现有工作流配置的 profile override。它保留 `standard-rp` 和 `advanced-memory-rp` 的工作流 ID，并只替换目标 `write-narrative` 节点所需的 Agent/team、成员模型、协作提示词和预设引用；原有输入、依赖、`workflowCalls`、输出、快照、`narrativeSource` 与 `finalize-turn` 关系继续有效。切换影响新运行；已经开始的运行使用启动时冻结的配置，不能在中途热切换。

正文模块提供 `standard-rp` 和 `advanced-memory-rp` 两个协作预设。节点的 `metadata.collaborationPreset` 引用模块内的小型 JSON 资源；资源自身使用 `schemaVersion: 1`，包含 `nodeId`、`promptFile` 和 `team`，其中 `team` 承载 v2 collaboration 配置。预设是配置转换输入，不是工作流副本，也不改变工作流/节点 ID。预设资源本身只需校验这几个字段和引用文件，不要求在资源层枚举目标节点的全部输出 owner；导入、校验和运行目标节点时，仍由目标节点的完整 `outputs` 与 `outputOwners` 契约校验。

每个成员可以独立绑定 `modelId`。模式编辑器按 `workflowId/nodeId` 保存普通 Agent 和 collaboration 两侧最近一次有效配置的 backup；恢复模式读取对应 backup，并与当前公共输入、输出和调用字段合并，避免恢复一个过期的整份工作流而丢失用户对其他节点的修改。恢复仍只影响后续新运行。

## 冻结、重试与上下文溢出

启动协作节点时保存配置、共享初始资料和任务阶段，预检并冻结成员 Agent 与非秘密模型绑定；成员首次执行时保存解析后的角色提示词。重试沿用同一 run、node、当前发言者、阶段、已提交的公开事件、工具结果、文件版本和交付回执，开启新的 activation/epoch；旧结果不能覆盖重试后的状态。未完成的文件写入和交付通过保存的操作记录恢复，工作流调用使用同一操作 ID 接回已有子运行。若中断后的文件被外部改动，会要求人工检查，避免直接覆盖。

正文运行保持关闭 Pi 自动压缩。共享公开记录或成员上下文超出模型上下文容量时，当前节点进入失败/恢复路径，保留已提交状态和可见结果；运行时不会偷偷删减转录、把两人的内容压成无版本摘要或自动重试成另一种上下文。用户可以按现有恢复入口重试、替换失败成员模型或开始新运行。

工具优先是协议边界：发言权只能由 `rp_team_handoff` 改变，作品只能由 `rp_deliver` 交付，阶段和节点完成只能由相应工具推进。普通文字不能作为 handoff、文件交付或完成信号的后备格式。
