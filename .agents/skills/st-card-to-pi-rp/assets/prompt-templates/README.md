# 提示词目录、角色与手写指南

本文是项目提示词的创作者入口，回答四个问题：提示词在哪里、各自负责什么、通过什么机制进入卡片或模型请求，以及应该怎样手写。

这里涉及三类来源：

- `assets/pi-rp-runtime/prompts/` 是新卡运行模板的一部分。这里只维护公共系统、总前后置和模型相关提示词；转卡打包时复制进卡，随后由该卡独立维护。
- `global-modules/<module-id>/prompts/` 保存所属 Agent 和节点的提示词，随整个模块进入卡内 `features/<module-id>/`。
- `assets/prompt-templates/agent-preferences/` 中被模块 Agent 提示词以 `{{include:agent-preferences/路径.md}}` 引用的片段，是该 Agent 的默认内容；新卡打包时按引用位置展开。其他 Agent 偏好、`task-defaults/` 和 `static-materials/` 仍是转卡阶段可选的起步材料。

完整的创作类、非创作类、系统、Agent 和工作流提示词位置见 [提示词来源清单](../../references/prompt-inventory.md)。

## 目录清单

以下路径相对 `st-card-to-pi-rp/` Skill 根目录。

```text
assets/
├─ pi-rp-runtime/
│  ├─ prompts/
│  │  ├─ README.md
│  │  ├─ context-options.json
│  │  ├─ system/
│  │  │  ├─ base.md
│  │  │  └─ tools.json
│  │  ├─ prefix/
│  │  │  └─ total.md
│  │  └─ tail/
│  │     └─ total.md
│  └─ .pi/                    # 公共引擎、工具与运行库
└─ prompt-templates/
   ├─ README.md               # 本文
   ├─ agent-preferences/      # Agent 默认引用或转卡时选用的片段
   │  ├─ 创作agent身份定位.md
   │  └─ common-creative.md
   ├─ task-defaults/          # 其他可选节点片段；字数、语言、扩写已移入正文模块拨档
   └─ static-materials/       # 导入卡片 context library 的可选静态资料
      ├─ INDEX.md             # 部分材料的可选使用时机预设
      ├─ styles/
      └─ creative-guidelines/
```

转卡后，`pi-rp-runtime/prompts/` 会成为卡内的 `prompts/`。`prompt-templates/` 不会整目录打包。项目全局模块的专属 Agent 和节点提示词仍在各自的 `global-modules/<module-id>/` 中维护，选择模块时随模块复制进卡。

## 角色是什么意思

这里的角色是发送给模型的消息角色，并不表示是谁编辑了文件。

| 角色 | 适合放什么 | 主要限制 |
| --- | --- | --- |
| `system` | Agent 身份、长期职责、工具边界和始终有效的规则 | 必须出现在所有 `user`／`assistant` 消息之前 |
| `user` | 当前任务、卡片概述、玩家资料、场景输入和靠近本轮执行的提醒 | 相邻的 `user` 消息会按顺序合并 |
| `assistant` | 已完成回复、少量正例或经验证的 assistant prefill | 当前运行路径不接受以 `assistant` 结束；只适合放在后续 `user` 消息之前作为历史或示例 |

支持分角色的 Markdown 使用以下精确标记，标记必须单独占一行、小写且没有额外字符：

```md
<!-- role: system -->
你负责依据资料完成当前 Agent 的职责。

<!-- role: user -->
示例输入：角色站在封闭的车站里，远处传来脚步声。

<!-- role: assistant -->
示例输出：她停在检票口前，没有立刻回头。
```

标记本身不会发送给模型。标记之前的正文使用该来源的默认角色；空角色块会被忽略。形似角色标记但格式不正确的行会导致加载失败。为了让文件脱离配置后仍然容易阅读，多角色文件应从第一个角色标记开始写，不要依赖“标记之前正文”的隐式角色。

只有以下来源会解析角色标记：

- 总前缀 `prefix/total.md`；
- 模型配置中的前缀；
- Agent 提示词；
- 总尾部 `tail/total.md`；
- 模型配置中的尾部。

以下来源不解析角色标记：

- `system/base.md`，它固定进入基础 SYSTEM；
- `system/tools.json`，它是 JSON 工具说明表；
- 工作流节点提示词，它固定嵌入本轮 `user` 任务；
- 静态资料和尚未放入目标位置的可选素材片段。

不要在不解析角色的文件里写 `<!-- role: ... -->`，否则模型看到的只是普通文本。

### 文本宏与文件引用

提示词正文可以使用规范玩家宏 `{{user}}`，运行时会把它替换为当前会话选定的玩家姓名。不要手写旧式 `<user>`，也不要在运行提示词中留下 `{{char}}`、`<char>` 或 `<bot>`；转卡时应先把角色宏解析为确定的角色姓名。宏不得出现在 ID、路径、文件名、JSON 键或其他结构字段中。

`prompts/` 是运行时读取的提示词来源，不会进入 Agent 工作区，Agent 也不能通过文件工具回读这些源文件。因此提示词不应要求 Agent “再打开某个 prompts 文件”。需要在任务过程中读取的设定、规则、文风或格式资料应进入卡片静态资料库，并通过【可用资料】索引交付。

## 默认装配顺序

一个普通 Agent 节点按以下顺序组织内容：

| 顺序 | 来源 | 默认角色 | 是否总会出现 |
| --- | --- | --- | --- |
| 1 | `system/base.md` 和实际可用工具说明 | `system` | 是 |
| 2 | 总前缀 `prefix/total.md` | `system` | 文件有内容时 |
| 3 | 当前模型的前缀 | `system` | 模型配置有内容时 |
| 4 | 当前 Agent 提示词 | `system` | Agent 有提示词时 |
| 5 | 卡片 `core/foundation.md` | `user` | 节点声明需要时 |
| 6 | 当前玩家资料 | `user` | 节点声明需要时 |
| 7 | 最近对话正文 | 原来的 `user`／`assistant` | 节点声明需要时 |
| 8 | 当前任务消息：玩家输入、节点提示词、补充上下文和资料索引 | `user` | 是 |
| 9 | 总尾部和模型尾部 | `user` | 有内容且使用 `on-start` 时 |

运行时把所有位于对话之前的 `system` 内容合成最终 SYSTEM。普通消息中，相邻且角色相同的内容会以一个空行连接成一条消息。例如卡片概述和玩家资料都是 `user`，中间没有 `assistant` 时会合成一条 `user` 消息。

任何来源一旦产生 `user` 或 `assistant`，后续来源便不能再产生 `system`。因此总前缀通常只写 `system` 内容；需要少量 `user`／`assistant` 正例时，更适合把它们放在 Agent 提示词的 SYSTEM 职责之后，因为 Agent 后面通常不再出现 SYSTEM 来源。

最终一条普通消息必须是 `user`。当前运行路径尚未验证 assistant prefill，因此以 `assistant` 结尾会直接报错，不会自动改成其他角色。

## 逐项说明与手写方法

### `prompts/system/base.md`

作用：建立所有 Agent 节点共享的最小运行环境，包括可用工具和当前工作目录。

用在哪儿：每个 Agent 节点的基础 SYSTEM，先于其他提示词装配。

引入机制：作为 `pi-rp-runtime` 的必需文件，由打包器复制到每张新卡；缺失时卡片不能运行。

手写方法：使用普通 Markdown，只写所有 Agent 都需要知道的运行规则。保留 `{{AVAILABLE_TOOLS}}` 和 `{{WORKSPACE}}` 两个占位符，运行时分别填入当前节点真正开放的工具和工作目录。这里不写角色标记，也不要放某个具体 Agent 或某个工作流节点才需要的职责。

### `prompts/system/tools.json`

作用：为基础 SYSTEM 中列出的工具提供简短说明。

用在哪儿：运行时只取当前节点实际开放的工具，把对应说明填入 `{{AVAILABLE_TOOLS}}`。

引入机制：作为 `pi-rp-runtime` 的必需文件随新卡打包。

手写方法：保持为合法 JSON 对象，键必须是运行时工具名，值必须是简短字符串。例如：

```json
{
  "read": "读取当前任务允许访问的资料文件。",
  "rp_call": "调用本节点明确开放的模块工作流，并读取返回资料。"
}
```

这里不写 Markdown 角色标记。说明应描述能力和边界，不应替某个节点编写任务流程。

### `prompts/prefix/total.md`

作用：给所有模型和 Agent 增加一段卡级通用前置提示词。

用在哪儿：位于基础 SYSTEM 之后、模型前缀和 Agent 提示词之前。

引入机制：文件随新卡打包；默认可以为空。`context-options.json` 决定它与模型前缀是叠加还是互斥回退。

手写方法：适合写真正跨模型、跨 Agent 的少量规则。默认角色为 `system`，通常直接写正文即可。若使用多角色内容，必须检查后面的模型前缀和 Agent 提示词不再产生 SYSTEM，否则装配会失败。

### 模型前缀与模型尾部

作用：为某个模型配置补充专用提示，例如模型格式兼容说明。

用在哪儿：模型前缀位于总前缀之后；模型尾部与总尾部一起位于任务末尾或每次模型调用末尾。

引入机制：由模型配置档案提供内联内容，或通过 `headPromptFile`／`tailPromptFile` 指向卡内 `prompts/` 下的文件；它们不是转卡默认素材目录中的固定文件。

手写方法：只写该模型确实需要的差异。前缀默认 `system`，尾部默认 `user`，两者都支持角色标记。不要把通用创作规则复制到每个模型配置中。

### `features/<module-id>/prompts/agents/*.md`

作用：定义一个 Agent 的长期职责、判断边界、工具使用方式和产物要求。

用在哪儿：所有绑定该 Agent 的工作流节点都会读取；具体节点任务仍由工作流节点提示词提供。

引入机制：Agent 文件随所属模块整体复制进卡，Agent 定义通过模块相对的 `promptFile` 引用。Agent 提示词可用 `{{include:agent-preferences/相对路径.md}}` 在指定位置插入项目片段；打包时展开为卡内完整提示词，不留下文件引用。模块专属 Agent 的源文件位于 `global-modules/<module-id>/prompts/agents/`；导入模块时复制到卡片 `features/<module-id>/prompts/agents/`。转卡时额外选中的长期偏好仍可拼入指定 Agent 的提示词。

手写方法：先写“你负责什么”，再写长期有效的约束，最后写通用交付方式。不要写只属于某个节点的一次性任务，也不要在多个 Agent 中重复模块 Skill 已经定义的领域规则。默认角色是 `system`。

一个只含 SYSTEM 的 Agent 可以这样写：

```md
你负责检查候选记录是否符合当前模块的数据契约。

只依据本轮提供的资料判断，不补写未提供的世界事实。把检查结果写入节点声明的正式产物，并按节点要求完成交付。
```

需要提供正例时，可以显式分角色：

```md
<!-- role: system -->
你负责把自然语言要求整理成简洁的检查清单，不替执行者作结论。

<!-- role: user -->
检查港口冲突涉及哪些人物、事件和知情范围。

<!-- role: assistant -->
- 人物：冲突双方及现场见证者
- 事件：冲突起因、发生时间、直接结果
- 知情范围：各人物实际看见或听见的内容
```

这类 `assistant` 块是历史正例，后面仍会有本轮 `user` 任务；它不是最终 prefill。

### `features/<module-id>/prompts/workflows/<workflow-id>/<node>.md`

作用：定义一个具体工作流节点在本轮要完成什么、按什么顺序处理、需要交付什么。

用在哪儿：运行时把节点提示词放入当前 `user` 消息的“【任务】”部分，同时附上玩家输入、补充上下文和资料索引。

引入机制：工作流节点文件随所属模块整体复制进卡，工作流定义通过模块相对的 `promptFile` 引用。模块节点的源文件位于 `global-modules/<module-id>/prompts/workflows/`；导入模块时复制到卡片 `features/<module-id>/prompts/workflows/`。正文的字数、语言、扩写默认值已移到 `narrative-controls` 拨档，导入该模块时仅通过组合后的普通静态《创作要求》交付，不再固定追加到正文任务。

手写方法：直接写任务步骤，不写“你长期是谁”，也不写角色标记。应明确读取哪些资料、进行哪些判断、调用哪些已开放能力、生成哪个正式产物以及何时结束。例如：

```md
读取【可用资料】中标为必读的条目，结合最近正文和玩家本轮输入判断当前场景。

先形成仅供本轮使用的简短规划，再完成正文。把正文写入工作文件，交付 narrative，确认交付成功后结束节点。
```

项目提供的 Agent 与 Agent／team 节点只用 `promptFile` 保存可定制提示词，不在 JSON 中重复正文。不提供旧目录或旧协议兼容层。新定义不要同时写 `promptFile` 与 `prompt`。

### `prompts/tail/total.md`

作用：在靠近模型执行的位置增加卡级最终提醒。

用在哪儿：默认放在当前任务之后。`tailMode` 为 `every-call` 时，运行时会在包括工具调用后的后续模型请求中重新附加尾部。

引入机制：文件随新卡打包；默认可以为空。`context-options.json` 决定它与模型尾部是叠加还是互斥回退。

手写方法：默认角色为 `user`。只放需要贴近本次输出、且适合反复提醒的短规则。不要复制完整 Agent 职责或大段卡片设定。`every-call` 模式下尾部必须全部是 `user`，不能混入 SYSTEM 或 assistant；无论哪种模式都不能让最终消息停在 assistant。

### `prompts/context-options.json`

作用：配置前后缀组合方式、尾部模式和各来源没有角色标记时的默认角色。

用在哪儿：运行时装配所有 Agent 节点提示词时读取。

引入机制：作为 `pi-rp-runtime` 的必需配置随新卡打包。

手写方法：保持为合法 JSON。主要字段如下：

| 字段 | 含义 |
| --- | --- |
| `prefixExclusive: false` | 总前缀后继续加入模型前缀 |
| `prefixExclusive: true` | 模型前缀非空时只用模型前缀；为空时回退总前缀 |
| `tailExclusive` | 对总尾部与模型尾部应用同样的组合规则 |
| `tailMode: "on-start"` | 只在 Agent 节点初始上下文末尾加入尾部 |
| `tailMode: "every-call"` | 每次模型调用都重新附加尾部，适合工具循环中的短提醒 |
| `defaults.totalPrefixRole` | 总前缀无标记正文的默认角色 |
| `defaults.modelPrefixRole` | 模型前缀无标记正文的默认角色 |
| `defaults.agentRole` | Agent 提示词无标记正文的默认角色 |
| `defaults.cardFoundationRole` | 卡片基础概述的默认角色 |
| `defaults.playerProfileRole` | 玩家资料的默认角色 |
| `defaults.totalTailRole` | 总尾部无标记正文的默认角色 |
| `defaults.modelTailRole` | 模型尾部无标记正文的默认角色 |

除非已经检查完整发送顺序，建议保留前缀和 Agent 为 `system`，卡片概述、玩家资料和尾部为 `user`。

### `prompt-templates/agent-preferences/**`

作用：提供 Agent 提示词可以引用的默认片段，以及转卡时可选择的额外片段。它不限于创作 Agent；可以增加总结、归档或其他 Agent 的通用模板。

用在哪儿：`narrative-writer.md` 默认按文件内顺序引用 `创作agent身份定位.md` 和 `common-creative.md`。新卡打包后，用户可以分别修改卡内每个 Agent 的完整提示词。未被引用的片段由用户为目标 Agent 单独选择，按方案列明的顺序原样加入。

引用写法：在 Agent 提示词中写 `{{include:agent-preferences/文件名.md}}`，子目录使用 `/`。路径相对于本目录的 `agent-preferences/`；打包器只允许读取该目录内的普通文件，缺失文件或未解析引用会使打包失败。展开后的卡片提示词不保留引用，也不依赖项目模板目录。若需改变某张卡的写作习惯，直接编辑该卡的 Agent 提示词。

引入机制：转卡阶段按实际 Agent 和用户选择应用；不自动打包。未选择、空白或只含 HTML 注释的文件不会进入卡片。

手写方法：每份文件写成可以独立拼接的 Agent 固定提示词片段，不写角色标记。创作者可以自行决定把创作规则放在这里，或改写为 `static-materials/` 下按阶段读取的静态资料；框架不强制划分、拆分或去重。

### `prompt-templates/task-defaults/**`

作用：提供可直接加入节点“【任务】”的默认要求。原夏瑾系列字数、语言、续写／扩写素材已迁入 `global-modules/narrative-controls/documents/options/`，完整保留为正文拨档源；此目录供创作者另写其他任务片段。

用在哪儿：用户为实际存在的目标工作流节点分别选择。选中后按方案列明的顺序原样加入该节点已有任务提示词；本轮明确要求可以覆盖默认值时，应在卡内规则中保持这种优先关系。

引入机制：转卡阶段按实际节点和用户选择应用；不自动打包。未选择、空白或只含 HTML 注释的文件不会进入卡片。

手写方法：每份文件写成可以直接追加到节点任务的短指令，不写角色标记、Agent 身份、工具协议或卡片专属设定。

### `prompt-templates/static-materials/**`

作用：提供可导入卡片 context library 的静态资料。`styles/` 存放文风，`creative-guidelines/` 存放推进幅度、阶段节奏等创作准则或指导；创作者也可以增加其他分类。

用在哪儿：选中后成为普通的卡片静态资料，与原卡确定的静态资料使用完全相同的分析、编目、交付和读取逻辑。模板来源只作为来源信息记录在资料目录、溯源和转换报告中，不形成独立运行时层。

引入机制：转卡阶段用户选择；不自动打包。转卡者必须把模板静态资料与原卡静态资料合并为最终资料集合，再统一确定文档边界、分类、`readPolicy`、`appliesAt`、`readWhen`、选择组、回退关系和适用 Agent。由最终资料集合产生的必要总体提醒还要写入调用节点的 `metadata.documentIndex.description`，使简易【可用资料】清单能提示 Agent 何时进入资料集并阅读其 `DOCUMENTS.md`。

手写方法：一份文件描述一个可独立引用的资料单元。文风文件名和标题可以描述文风特点，也可以完全由用户命名；适用场景、目标 Agent、补充／替代关系和回退规则在转卡方案与卡内目录元数据中明确，不能从文件名推断。选中的多份创作准则可以按用户意图合成一份如《创作准则》的静态文档，也可以分别保留。

#### `static-materials/INDEX.md`

作用：允许创作者提前为部分静态资料模板记录常用的使用时机和补充说明，减少每次转卡重复交代。使用自由自然语言，只要能清楚辨认涉及哪些材料、什么时候使用即可；不要求固定标题、字段、列表或条目格式。

处理方式：转卡者先验证其中引用的相对文件路径。用户选中被引用的材料后，集中询问是否沿用对应预设；用户已经明确要求沿用全部预设时可直接采用。用户可以只接受一部分或在本次转卡中改写。预设与原卡规则、其他静态资料或实际工作流冲突时，说明具体差异后再确定。

落实方式：确认后的自然语言意图与所有来源的静态资料一起转换为卡片目录元数据，并在需要时形成 `metadata.documentIndex.description` 中的总体读取提醒。`INDEX.md` 不选择任何材料，不作为静态资料复制进卡片，也不要求用户直接编写运行时字段。缺失或指向目录的路径要报告，不猜测替代文件。

### 自由扩展与组合

可在游玩中拨档切换的正文要求使用独立资源机制：项目源位于 `global-modules/narrative-controls/documents/options/`，卡内副本位于 `features/narrative-controls/documents/options/`，不属于本目录的普通静态材料。叙事节奏与抢话方式已迁入该资源区。转卡选择模块后保留整组档位，由前端选择决定本次交付内容；生成的《创作要求》合入普通静态资料目录，与其他创作准则同级。详见[可切换正文提示词](../../references/switchable-prompts.md)。并列且非互斥的其他静态材料仍按上述规则处理。

创作者可以在上述三个目录下任意新增、删除、改名或重组子目录和 Markdown 文件。转卡者递归检查实际文件，以实际内容为准；`static-materials/INDEX.md` 是保留的目录说明，不属于可选材料。目录名只帮助作者整理，不自动声明互斥关系、拼接顺序、用途或运行规则。README 不维护穷举文件清单，新增文件不需要登记在这里，也不要求写入 `INDEX.md`。

多个 Agent 或节点片段的拼接顺序必须在转卡方案中明示，不能由文件名或目录遍历顺序暗中决定。固定提示词与静态资料可以表达相同或相近的要求；转卡者不自动搬移、拆分或去重，只在发现会改变行为的实际冲突时指出具体条文和影响。

## 选择手写位置

遇到一条新提示词时，可以按持续时间和适用范围决定位置：

| 内容 | 应写位置 |
| --- | --- |
| 所有 Agent 都需要的最小运行规则 | `system/base.md` |
| 某个 Agent 长期负责什么 | 对应 Agent 提示词 |
| 某个工作流节点这一次要做什么 | 对应节点提示词 |
| 所有模型／Agent 都要应用的卡级前置规则 | `prefix/total.md` |
| 靠近输出的短提醒 | `tail/total.md` |
| 仅某个模型需要的兼容说明 | 模型前缀或模型尾部 |
| 卡片的世界、人物、规则、格式或文风资料 | 卡片 context library，而不是运行提示词目录 |
| 供转卡时选用的 Agent 固定片段 | `prompt-templates/agent-preferences/` |
| 供转卡时选用的节点任务片段 | `prompt-templates/task-defaults/` |
| 供转卡时选用的静态资料 | `prompt-templates/static-materials/` |
| 某个全局模块自己的长期职责和任务 | 该 `global-modules/<module-id>/` 内的 Agent、工作流或 Skill |

判断不清时，优先问两个问题：它是否在每个节点都成立，以及它描述的是长期职责还是当前任务。适用范围越窄，越应靠近具体 Agent、节点或静态资料，避免把所有规则堆进总前缀。

## 按 Agent 实际可见上下文编写

写到总体流程、其他角色或前后阶段时，先确认当前 Agent 从哪里知道这些信息：检查实际绑定的 Agent 提示词、节点任务、运行时阶段任务，以及本次确实交付且要求读取的资料。仓库中存在流程说明、工作流声明了前后依赖，或另一个 Agent 已读过资料，都不等于当前 Agent 已获得这些内容。通用 Agent 提示词还要检查它绑定的每个节点，不能只凭其中一个节点提供了说明就假定始终可用。

若理解整个流程并非完成任务所必需，优先把要求改写为当前 Agent 能执行的动作、输入依据、输出和权限边界；若必须理解协作关系，则在实际送达的节点任务或资料中补充最少必要说明，明确当前步骤、所接收的内容和应交付的结果。不要仅要求 Agent 自行猜测角色名、阶段名或寻找未提供的流程文档。

例如，“统审不替代导演的后置复盘”应具体说明只审核当前候选，附带更新限于本次发现的问题，不全面重评整轮剧情或重排长期计划；“正式报告由秘书撰写”用于 Leader 时，应说明其负责综合意见、给出裁定及草稿修订意见，无需编写正式报告文件。协作分工已在当前会议任务中解释时可以保留，但不能用它代替对当前角色动作的说明。

## 编辑后的检查

修改项目根模板中的 `promptFile` 正文后，应从仓库根运行：

```powershell
node .agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.mjs
node .agents/skills/create-pi-rp-feature-module/scripts/sync_template_assets.mjs --check
node .agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs
```

第一条同步其他生成资产并检查所有 Agent／节点的 `promptFile` 引用，第二条以只读方式复查，第三条检查发布引用。检查会拒绝缺失或空白的提示词文件，以及同时保存 `promptFile` 和内联 `prompt` 的定义。只填写 `prompt-templates/` 中的可选素材时不生成另一份副本；转卡时会递归发现其中实际存在且已填写的文件。

转卡后的卡内 `prompts/` 是该卡自己的可编辑副本。修改卡内文件不会反向更新项目模板，也不应修改项目根模板来间接影响已经转换的卡。
