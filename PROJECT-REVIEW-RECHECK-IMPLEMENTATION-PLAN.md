# 再次复核问题修复实施方案

日期：2026-09-14。状态：**F01—F08 已逐项确认、完成实施并通过本轮验证。**

依据：[再次复核报告](M:/ai/SillyTavern/bobo-agent-rp/PROJECT-REVIEW-RECHECK-2026-09-14.md)。本文件只记录用户逐项确认的处理方案；未确认条目不提前形成实施决定。

## 共同边界

- 修改目标限于根目录公共运行时/Web 模板、全局模块、相关技能参考、测试与项目文档。
- 不修改或同步 `play/`、已安装卡、现有 session，不执行数据迁移。
- R03 继续保留记忆 Agent 的灵活控制；R15 不增加新的硬性查询次数限制。
- 固定提示词及必要非聊天上下文必须继续正常装配。
- 工作流展示状态必须与持久记录及外部任务状态一致；错误详情保留到具体 render，不以正常函数返回掩盖失败或待恢复状态。

## F01：生图失败及待恢复状态必须传播到工作流和 Web

状态：**已确认。**

### 处理方案

1. 为公共 Workflow v3 增加通用的 `awaiting-recovery` 节点及运行状态，用于已经产生或可能产生外部副作用、不能安全重新开始、但仍可沿原身份恢复的任务。该状态不归类为模型选择，也不自动视为失败或完成。
2. 扩展节点执行结果协议，使代码节点能够明确报告：
   - `completed`：全部必要 render 已达到完成或用户明确取消等允许的终态；
   - `failed`：发生确定失败，需要明确重试或形成新操作；
   - `recovery-required`：至少一个 render 位于 `submitting`、`submitted` 或其他无法确认的状态；
   - `partially-completed`：多个 render 中已有完成项，同时仍有失败或待恢复项。
3. `executeImageOperation` 继续保留逐 render 的状态、错误、promptId 和输出，但不得仅因捕获异常便正常结束。它生成汇总状态；持久化节点依据汇总结果完成、失败或进入 `awaiting-recovery`。
4. 数据提交的 revision conflict、权限拒绝、failed/partial/未知回执必须向节点传播。不得刷新 expectedRevision 后静默覆盖，也不得把未写入 `submitting/completed` 的任务报告为工作流完成。
5. 子模块工作流不是 `completed` 时，顶层调用节点及顶层工作流继承相应状态。父流程不得把子流程的失败或待恢复包装成成功。
6. Web 工作流列表和生图区域显示 `awaiting-recovery`、确定失败及部分完成，并展示已完成图片和每个未完成 render 的原因。
7. Web 提供“恢复原任务”操作。该操作沿用原 request、render、attemptId 和 promptId，只查询或补记原任务结果；“重新生成”继续代表新的 operationId，两种行为不得混用。
8. 取消只处理用户明确取消的本地生命周期；若远端任务是否已接收仍不确定，界面需说明取消本地等待并不等价于撤销远端任务。

### 兼容与恢复

- 现有 `completed`、`failed`、`cancelled` 工作流记录保持原解释；新状态只用于新运行及恢复后的非终态运行。
- 旧 render 已有 promptId 且处于 `submitting/submitted` 时可以进入恢复路径；缺少可查询身份的旧记录不得宣称可以安全再次提交。
- 多 profile 操作保留已完成结果，只处理未完成 render；不得为恢复一个失败项重做已完成项。

### 验收

- 用实际顶层与模块生图工作流、RpWorkflowEngine、RpDataStore 和真实提交路径注入 revision conflict；render 保持原状态，子流程与父流程不得为 `completed`，POST 数为 0。
- 模拟一个完成、一个确定失败、一个 `submitting` 的多 render 操作；已完成输出保留，汇总状态为部分完成且等待恢复，恢复只查询未完成项。
- 模拟响应丢失和 completed 写入失败；Web 的恢复入口沿原 promptId 完成补记，Agent 与远端 POST 计数不增加。
- 确定失败、待恢复、用户取消和全部完成在 API、持久运行记录及 Web 上语义一致；重启后仍能恢复 `awaiting-recovery`。
- 既有模型失败选择、普通代码重试、下一回合阻塞和取消测试无回归。

## F02：只在能够确认远端未接收时允许重新提交

状态：**已确认。**

### 处理方案

1. ComfyUI 提交错误分为三类：
   - `pre-submit-failure`：本地参数/profile 校验或 `submitting` 持久化失败，确定没有发出 POST；
   - `confirmed-rejection`：能够识别为 ComfyUI 明确未接收的业务拒绝；
   - `submission-uncertain`：超时、连接中断、502/503/504、响应无法解析、任务 ID 响应不完整及其他不能证明未接收的情况。
2. 只有前两类可以进入确定失败。`submission-uncertain` 保留原 attemptId/promptId 和 `submitting`，并按 F01 进入 `awaiting-recovery`；不得生成新任务身份或自动再次 POST。
3. 明确拒绝不能只按“HTTP 非 2xx”判断。适配器需校验响应来源及 ComfyUI 可识别的拒绝结构；不能可靠分类的响应一律按不确定处理。具体错误保留 HTTP 状态、响应摘要、发生阶段和时间，但不得保存凭据。
4. 恢复入口先使用原 connection、promptId、outputNodeIds 查询 history/queue。一次查询没有结果不等于从未接收，继续保留不确定状态，并记录最后查询时间和结果。
5. 用户可选择：继续查询原任务，或放弃本地等待并创建新的生图操作。新操作使用新的 operationId；界面明确说明原远端任务仍可能存在。不得以“重试”名义把新操作伪装成原任务恢复。
6. 若以后接入的 ComfyUI 兼容服务能提供明确的幂等提交或“未接收”证明，可由适配器能力声明缩小不确定范围；公共模块默认采用保守语义。

### 验收

- 使用实际 ComfyUI 适配器和本机 HTTP 替身覆盖：明确的工作流校验拒绝、鉴权拒绝、限流、502/503/504、超时、连接复位、空响应、非 JSON 响应、响应任务 ID 不完整或不一致。
- 模拟服务先记录已接收任务再返回 502；首次结果必须为 `awaiting-recovery`，继续恢复时 POST 总数保持 1，promptId 不变。
- 模拟本地持久化 `submitting` 失败；POST 总数必须为 0。
- 模拟一次 history/queue 未找到后稍后出现结果；系统不得在空查询后重新提交，并能沿原身份完成。
- 用户明确创建新操作时 operationId 改变，旧操作保留原状态和审计信息。

## F03：冻结实际生效的 profile，并用同一快照构造远端请求

状态：**已确认。**

### 数据归属与去重

1. 生图 request 是本次操作冻结配置的唯一所有者。它为每个选定 profile 保存一份 `effectiveProfileSnapshot`；同一 request 下的 render 只引用对应快照 ID/digest，不重复保存整份 API 工作流和固定配置。
2. 每份快照至少包含：profile ID/revision、原始 profile digest、覆盖内容及 digest、合并后的有效 profile digest、API 工作流及 workflow digest、节点 bindings、合并后的固定正面/负面提示词配置、模型指导内容及 digest、connectionId、当时的 base URL、输出节点和快照格式版本。
3. 快照不保存 API token 或其他凭据。执行时可以按 connectionId 读取当前凭据，但请求地址及任务语义使用冻结值。
4. render 保存本次独有的画面内容提示词、最终正/负提示词、seed、filenamePrefix、promptId、attemptId 和实际提交载荷 digest。seed 与最终载荷参数必须在 POST 前持久化。

### 执行规则

1. profile 加载阶段生成“有效 profile”：原 profile、合法覆盖、工作流、bindings、模型指导和连接信息在同一次读取中合并、规范化并计算有效 digest。
2. 创建 request 时原子保存有效 profile 快照及输入来源；提示词 Agent 和后续执行节点读取同一冻结版本。
3. 真正提交时，ComfyUI 适配器接收冻结快照及 render 参数，构造实际工作流载荷；不得按 profileId 再读取当前 profile 或重新合并当前覆盖。
4. POST 前校验构造结果与保存的最终提示词和载荷 digest 一致。出现内部不一致时在提交前确定失败，POST 数为 0。
5. profile 或覆盖的后续修改只影响新 operationId。旧操作执行、查询和恢复继续使用自身快照；需要采用新配置时创建新操作。
6. 固定提示词、LoRA、采样、负面提示词等仍由 profile 控制，Agent 只负责随剧情变化的内容片段；该职责边界不改变。

### 兼容与容量

- 新 request 使用新快照结构。旧 request 有足够的已保存 render/绑定信息时按显式兼容路径恢复；信息不足时报告“无法可靠恢复”，不得按当前 profile 猜测原执行配置。
- 快照只在 request 中保存一次，且不进入 Agent 默认上下文或普通前端列表。Web 只读取展示所需摘要；完整执行快照仅供受控执行与诊断。
- 不新增跨 session 的 profile 快照集合，避免把项目配置复制成另一份长期全局权威；快照生命周期随其 request。

### 验收

- 准备完成后修改 profile 固定提示词覆盖；旧操作实际 HTTP 载荷仍使用旧快照，新 operationId 使用新覆盖。
- 对最终正面提示词、负面提示词、seed、filenamePrefix、节点 bindings、输出节点及载荷 digest 做保存值与实际 POST 逐项对比。
- 在准备完成后重启运行时，仍能由 request 快照构造同一执行载荷。
- profile 被编辑、删除或连接地址改变时，已经提交的任务仍能按原地址和 promptId 查询；新操作按当前配置执行。
- 多 render request 只保存每 profile 一份完整快照；render 不重复嵌入工作流。检查快照及日志中不存在 token。
- 固定提示词、Agent 内容片段及非聊天必要资料的现有装配测试保持通过。

## F04：恢复入口先识别已有操作，再读取当前环境

状态：**已确认。**

### 处理方案

1. 将生图入口拆分为“新操作”和“已有操作”两条路径。requestId 仍由 operationId 确定，因此入口可在读取当前聊天、偏好和 profile 之前定点查询已有 request。
2. 新操作不存在既有 request 时，才读取当前偏好、聊天范围和 profile，解析实际消息 revision，建立 F03 的有效 profile 快照并原子持久化完整冻结输入。
3. 已有操作首先比较调用意图；一致时直接读取 request 中冻结的来源、消息 revision、模型指导及有效 profile 快照，不重新选择当前最近回合、不采用当前默认偏好，也不要求当前 profile 仍然存在。
4. request 分别保存：
   - `invocationFingerprint`：由规范化后的用户调用参数计算；
   - `resolvedInputFingerprint`：由首次实际选中的消息 revision、冻结内容、有效 profile 快照和派生来源计算。
   两者用途分离，恢复时不得用当前环境重新计算 resolved 值。
5. 调用参数在计算 invocationFingerprint 前统一规范化：补齐默认值、清理文本、去除重复 ID，并对语义无序集合使用稳定顺序；会影响输出顺序的 profile 顺序保持不变。
6. 各状态按冻结记录继续：
   - `preparing`：从冻结来源和模型指导重建任务文档，必要时重新调用提示词 Agent；
   - `ready/pending`：跳过 Agent，使用已保存提示词和执行快照；
   - `submitting/submitted`：只查询原 promptId；
   - `completed/cancelled`：直接返回原结果；
   - `failed`：依据失败分类决定修复或要求创建新 operationId。
7. `persist-and-render` 不再先查询当前 profiles；它以已有 request 快照为执行输入。只有新操作准备阶段可以读取当前 profile。
8. 旧格式 request 仅在已保存信息足以证明原身份时兼容恢复；缺少 promptId、连接或执行配置时明确报告无法可靠恢复，不按当前配置猜测或自动修改 session。

### 验收

- 保存 ready/submitting/submitted/completed 请求后，分别修改或删除 profile、修改连接地址、改变默认偏好、推进聊天回合并编辑源消息；同 operationId 仍读取原冻结内容并按原状态继续。
- 同一个“最近若干回合”操作在后续回合恢复时，所选消息 ID/revision 和内容保持首次快照，不切换到当前最新回合。
- 已有 `preparing` 请求可从持久记录重建 Agent 任务资料；固定提示词、模型指导和剧情来源与首次准备一致。
- 调用意图改变时返回明确冲突；当前环境变化但调用意图未变时不误报冲突。
- 旧记录信息不足时返回可解释的兼容错误，POST 和 Agent 调用计数不增加。

## F05：同一 operationId 的活动运行和持久请求使用统一冲突判定

状态：**已确认。**

### 处理方案

1. 建立唯一的 `normalizeImageOperationIntent`/fingerprint 实现，由 Web 生图入口、顶层活动工作流复用、request 首次持久化、已有 request 重放及派生重生成共同调用，不在各入口分别维护字段列表。
2. 普通生图调用意图包含规范化后的 profileIds及顺序、inputPolicy、customBrief、workflowOutput、messageIds、userDirection 和 derivedFrom。补齐默认值、清理字符串、去重 ID；语义无序的 messageIds 使用稳定顺序，会影响 render 顺序的 profileIds 保持顺序。
3. 派生重生成的调用意图还包含来源 request/render ID、重生成范围及用户编辑的每个 guideId 内容提示词。普通提示词 Agent 的生成结果属于执行结果，不纳入初始调用意图；用户提供或编辑的提示词属于调用输入，必须纳入。
4. Workflow Engine 的 `reuseActive` 不再只按实例键返回旧 run。相同实例键下：规范化调用 fingerprint 相同才复用；不同则抛出明确 operation conflict。运行记录保存该 fingerprint，恢复后继续使用。
5. 已持久化 request 使用 F04 的 invocationFingerprint 执行同一规则。活动运行和落盘记录的比较必须调用相同实现或同一规范化结果，不能出现一层复用、下一层冲突。
6. operationId 只标识一次操作，不承担内容去重：同 ID/同输入安全重放；同 ID/不同输入拒绝并由 HTTP 返回 409；不同 ID/相同输入允许再次生成。
7. 冲突检查不得修改旧运行、旧 request 或 render，也不得调用 Agent、提交数据或发送 POST。

### 验收

- 活动顶层工作流：同 ID/同 payload 返回原 run；同 ID 且 customBrief、userDirection、profileIds、消息选择或派生提示词任一变化时返回冲突。
- 运行时重启后对持久 request 重复同一矩阵，结果与活动阶段一致。
- 对对象字段顺序、默认值补齐、文本首尾空白、重复 messageIds 做规范化等价测试；profile 顺序变化按不同意图处理。
- 派生重生成同 ID 且编辑提示词不同必须冲突；不同 ID 且提示词完全相同必须允许。
- 所有冲突场景中旧数据不变，Agent 和 POST 计数均为 0。

## F06：模块多实例的身份来源、调用复用和恢复保持一致

状态：**已确认。**

### 处理方案

1. 保留 `module-internal` 的 keyed multiple 能力。新增统一的 `resolveWorkflowInstanceInput`：顶层工作流从规范化 payload 取实例输入，模块工作流从规范化 arguments 取实例输入。
2. `resolveInstanceKey`、Engine `start`、子调用活动实例检查、运行记录及 `restore` 全部使用同一实例输入。禁止一处按 arguments、另一处按 `{call: ...}` payload 解析。
3. `module-internal` 声明 `mode=multiple` 时必须同时声明稳定 dedupeKey、精确 owner-module 集合写锁及有限的 maxConcurrentInstances；缺任一项在工作流规范化/卡包校验时失败。
4. 运行记录持久化规范 workflow identity、最终 instanceKey、规范化调用 fingerprint 和必要的 instance input。恢复优先使用持久 instanceKey，并验证其 workflow identity 和 fingerprint，不能因代码路径不同重建另一键。
5. 相同 instanceKey 且调用 fingerprint 相同时，后到调用加入并等待原子工作流，随后复用其完成结果，不启动第二个子运行；fingerprint 不同时按 F05 报 operation conflict。
6. 不同 instanceKey 可以登记成独立运行，分别查看、取消和恢复。`maxConcurrentInstances` 限制登记中的活动运行数量，集合写锁继续决定何时真正执行。
7. 当前生图操作都写 `requests`/`renders`，相同集合锁仍会将冲突执行串行化。本轮不新增记录级锁、不放宽事务或 expectedRevision 保护；多实例的收益是身份、排队和恢复独立，不承诺同集合并行写。
8. 单实例内部工作流及默认整模块锁保持现有语义。没有稳定业务键的内部副作用工作流不得改成 multiple。

### 验收

- 用实际生图模块定义验证 operationId `a`/`b` 产生不同 instanceKey、两个运行记录均可存在；集合锁使写入依次执行。
- 相同 operationId/相同调用并发到达时只执行一个子工作流，两个调用取得同一结果；Agent、数据创建和 POST 均只发生一次。
- 相同 operationId/不同调用按 F05 冲突，不等待或复用旧结果。
- 保存运行后重启恢复，instanceKey、fingerprint、排队顺序和写锁语义不变。
- 模块调用预检查和实际 start 对 dedupeKey 使用相同 arguments；增加针对过去 `{call: normalizedRequest}` 形状差异的回归。
- multiple 内部工作流缺 dedupeKey、使用整模块锁或声明越权集合锁时，Workflow v3 规范化和 Python 卡包校验一致拒绝。
- 现有单实例内部工作流、不同集合并行及同集合串行测试保持通过。

## F07：在触发派发时冻结后台消费者所需的跨回合输入

状态：**已确认。**

### 数据所有权与生命周期

1. `story-context` 等生产者产物继续采用 `retain=turn`；不延长生产者文件的生命周期，也不把整个生产者工作区复制到 session 或消费者目录。
2. 非阻塞消费者在触发派发阶段预先分配自己的 runId，并立即把触发声明中实际选中的文档复制到消费者专属目录，例如 `workspace/private/<consumer-workflow>/<run-id>/_trigger-inputs/`。复制成功后，消费者 payload 只引用这份稳定输入，不再引用生产者的回合级源文件。
3. 一次消费者运行只建立一份触发输入快照。该运行内需要同一资料的多个节点通过 `triggerInputs` 引用这份快照，不得各自再次复制；不同消费者仅复制各自触发声明中明确选择的文档。
4. 输入快照随消费者运行生命周期保留。`awaiting-model-choice`、`awaiting-recovery`、排队和可恢复中断均属于非终态，不得清理；只有消费者真正进入 `completed`、`failed` 或 `cancelled` 后才可清理。
5. 输入快照保留原始 artifact ID、来源 workflow/run、内容摘要、消息 revision 和 narrative source 等身份与溯源字段。消费者读取副本时仍能证明它来自哪个生产者产物，不把副本误当成新的业务产物。

### 派发、恢复与清理规则

1. 触发派发按“预分配消费者 runId → 解析并校验选中文档 → 复制并写入快照清单 → 持久化消费者运行及 payload → 加入调度队列”的顺序执行。复制或持久化失败时不得留下可运行但缺少输入的消费者记录。
2. 如果消费者启动前失败，清理由派发事务的补偿路径完成；如果运行已被持久化，则由消费者终态清理统一处理。清理必须以已验证的消费者专属绝对目录为边界。
3. 重启恢复沿用原 runId、原 payload 和原输入快照，不重新读取生产者回合目录，也不按照当前回合内容重建输入。
4. 下一回合清理仍可按原规则删除生产者的 `retain=turn` 文件；该动作不得影响已经派发的消费者。消费者结束后只删除自己的 `_trigger-inputs`，不得反向删除或延长生产者产物。
5. 文档选择和用途说明统一由触发契约及消费者工作流入口声明；下游节点只声明自己使用哪个 `triggerInputs` 条目，不重复描述同一份跨模块传递协议。

### 冗余控制

- 只复制触发声明选中的文档及必要身份元数据，不复制整个 artifact、完整工作区、聊天历史或无关固定资料。
- 同一消费者运行内共享一份输入快照，不按节点重复复制。
- 快照不进入 session 长期数据；消费者终态后删除。
- 多个消费者各自拥有独立生命周期，只接收各自声明的最小输入集合。

### 验收

- 使用实际 post-turn/deep-director 工作流、artifact 注册表、调度器和清理器构造：先占满 worker，派发 deep-director，再进入下一回合并清理生产者文件，最后释放 worker；消费者仍可读取冻结输入并继续执行，且生产者 `retain=turn` 文件已正常删除。
- 在消费者排队、`awaiting-model-choice` 和 `awaiting-recovery` 三种状态下重启运行时，原输入快照保持可用，不产生第二份副本。
- 消费者进入 `completed`、`failed` 或 `cancelled` 后，其 `_trigger-inputs` 被清理；其他运行和生产者目录不受影响。
- 触发派发在复制、清单持久化或入队任一步骤失败时，不留下悬空运行、半份快照或越界文件。
- 快照清单中的 artifact ID、内容摘要、消息 revision 和 narrative source 与生产者登记值一致；消费者 payload 不包含未声明文档、完整聊天历史或重复的固定提示词说明。

## F08：发布检查必须读取所选工作区、暂存区或提交的真实内容

状态：**已确认。**

### 目标读取模型

1. 建立统一的 release target reader，向上层提供列举文件、判断文件存在、读取文本和读取二进制内容等能力：
   - `workspace` 从当前文件系统读取；
   - `staged` 从 Git index 读取，文件集合使用 `git ls-files --cached`，内容使用等价于 `git show :<path>` 的索引读取；
   - `commit` 从指定 Git tree 读取，文件集合使用 `git ls-tree`，内容使用等价于 `git show <ref>:<path>` 的树对象读取。
2. manifest 本身必须从所选目标读取并解析。全局模块发现、必需文件、模块 manifest、数据契约、catalog、workflow、schema、初始记录及所有声明路径均在同一目标内解析，不得把 Git 目标的文件名与工作区的文件内容混用。
3. 目标中的必需 JSON 文件必须实际读取并完成 JSON 解析及相应结构校验。文件名存在不能替代内容检查；目标内缺失、无效 JSON、错误引用和越界路径均判定失败。
4. 所有目标路径统一规范化为仓库相对 POSIX 路径，拒绝绝对路径、父目录逃逸和无法在目标中解析的链接。错误信息必须标明检查模式、目标 ref 及具体文件。

### 生成一致性与忽略规则

1. `staged` 和 `commit` 模式将所选目标按 reader 提供的内容释放到隔离临时目录，并在该目录运行现有生成同步检查及目标级结构校验。不得从用户工作区补齐目标中缺少的文件。
2. 为同步检查工具增加显式根目录参数，使当前受信任的同步实现可以检查临时目标树；workspace 模式继续使用仓库根目录。避免为 Git 模式另写一套生成算法。
3. 临时目标仅包含所选目标文件以及运行检查所需的当前校验工具。校验工具读取的业务输入和生成输出必须全部来自临时目标树；不得执行目标树中未经选择的工作区脚本来补齐结果。
4. `.gitignore` 从所选目标读取。临时目录可初始化为隔离 Git 仓库，并使用目标版本的规则检查：发布 manifest 声明的文件不得被忽略，个人设置、卡片、session 等既定私有路径仍必须保持忽略。
5. 临时目录无论检查成功、失败或异常中断都应清理。检查不得执行 `git add`、修改用户工作区、改变用户 index 或创建提交。

### 兼容性与职责边界

- workspace 模式继续检查当前文件系统，可包含尚未跟踪但未被忽略的开发文件；其读取也经统一 reader 完成，以避免三种模式分叉。
- staged 模式只认可 index 中的内容；工作区同路径的新修改不得影响结果。
- commit 模式只认可指定 tree 的内容；当前工作区和 index 均不得影响结果。
- release checker 负责选择并冻结检查目标、验证发布清单和协调既有校验器；模块规范化、生成同步和结构验证继续由现有共享实现负责，避免重复造轮子。

### 验收

- 在隔离仓库中暂存损坏的 schema，再把工作区恢复正确；`--staged` 必须读取损坏的 index 内容并失败。
- 创建包含错误 manifest、模块引用或 workflow 内容的提交，再把工作区修正；`--commit <ref>` 必须按该提交失败，检查当前正确工作区则通过。
- 分别覆盖目标中缺少模块/runtime/schema、JSON 无法解析、引用路径不存在、声明路径越界、生成文件漂移和发布文件被目标 `.gitignore` 忽略，三种模式均按自身目标给出确定结果。
- 验证目标 `.gitignore` 缺少个人设置、卡片或 session 保护规则时失败，规则完整时通过。
- staged/commit 检查前后比较用户仓库 `git status --porcelain=v1` 与 index 摘要，确保无任何变化；临时目录在成功和失败路径下均被删除。
- 保留现有 workspace 发布检查、生成同步检查和项目验证回归，并把本次“暂存内容损坏但工作区正确”的复现探针纳入长期测试。

## 实施跟踪

本轮实现落在公共 Workflow v3 引擎、ComfyUI 适配器与生图模块、Web 桥接与界面、触发输入快照、发布检查器及相应契约文档中。验证包括公共运行时 117 项 Node 测试、Web 模板 6 项测试、全局模块 39 项 Node 测试、19 项 Python 测试、workspace 发布检查，以及 `PROJECT-REVIEW-RECHECK-PROBES-2026-09-14.mjs` 的跨层断言探针。探针覆盖 revision conflict 时父子流程失败且 POST 为 0、同一操作冲突矩阵、旧 profile 快照执行、502 后沿原 promptId 恢复且 POST 总数为 1、生产者清理后的消费者输入读取，以及暂存区损坏 Schema 的目标内容校验。

| 问题 | 状态 | 方案位置 |
|---|---|---|
| F01 | 已实施并验证 | 本文“F01” |
| F02 | 已实施并验证 | 本文“F02” |
| F03 | 已实施并验证 | 本文“F03” |
| F04 | 已实施并验证 | 本文“F04” |
| F05 | 已实施并验证 | 本文“F05” |
| F06 | 已实施并验证 | 本文“F06” |
| F07 | 已实施并验证 | 本文“F07” |
| F08 | 已实施并验证 | 本文“F08” |
