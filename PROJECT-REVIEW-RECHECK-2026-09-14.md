# 修复验收再次复核报告

日期：2026-09-14。范围：根目录公共运行时/Web 模板、全局模块、已确认修复方案及上次验收证据。

后续处理：[再次复核问题修复实施方案](M:/ai/SillyTavern/bobo-agent-rp/PROJECT-REVIEW-RECHECK-IMPLEMENTATION-PLAN.md)正在逐项讨论；已确认条目以该文档为准。

## 结论

**本次复核不通过，撤回上次“确定性范围全部通过”的结论。** 确认 8 项缺陷或验收缺口，其中 5 项 P1、3 项 P2。它们可以用本地实际代码和模拟服务复现，并非必须连接真实模型、真实 ComfyUI 或重新转卡才能验证的外部边界。

本轮只新增复核报告、可复现探针并纠正状态记录，没有修改业务实现、用户工作区 Git 索引、已有卡或 session。所有数据写入和 Git 暂存实验均在脚本新建的系统临时目录内完成。

## 问题清单

| 编号 | 优先级 | 问题 | 原修复范围 |
|---|---|---|---|
| F01 | P1 | 生图提交冲突被转为普通返回值，父子工作流仍显示完成 | V13、V05/V06 |
| F02 | P1 | HTTP 502 等不确定响应被一概视为明确拒绝，重试会重复入队 | V06 |
| F03 | P1 | profile 覆盖不参与冻结校验，保存的提示词与实际发出的提示词不同 | V05/V06 |
| F04 | P1 | 旧操作恢复前重新读取当前 profile，配置变化阻断原任务恢复 | V05/V06 |
| F05 | P2 | 同 operationId 的冲突检查遗漏活动请求参数和编辑后的提示词 | V05 |
| F06 | P2 | 内部工作流多实例配置虽能规范化，实例键仍被强制合并 | V01、上次验收追加修改 |
| F07 | P1 | 后台排队期间进入下一回合，冻结剧情被清理，深度导演失去输入 | V08 |
| F08 | P2 | 发布检查只读工作区内容，错误的暂存区生成文件仍能通过 | G01 |

## 逐项证据与处理要求

### F01：生图数据提交失败仍使工作流完成

位置：[image-execution.mjs:290](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/image-execution.mjs:290)、[persist-and-render.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/persist-and-render.mjs)。

`executeImageOperation` 捕获异常后把错误加入 `outcomes` 并正常返回。公共严格提交函数虽然抛出了失败，外层又将其吞掉。调用节点没有检查结果中的未完成/失败状态，模块返回节点也没有对外导出该结果。

探针使用**实际顶层和模块生图工作流、RpWorkflowEngine、RpDataStore、数据契约、输入准备和持久化代码**，只以确定性结果代替提示词 Agent，并在 `submitting` 事务中注入过时 revision。结果为：`parentStatus=completed`、`childStatus=completed`、render 仍为 `pending`，错误包含 `revision conflict`，POST 数为 0。

同一异常收集路径也会把网络不确定状态作为正常节点结果。静态检查还显示，Web 生图界面只有新生成及派生重生成入口，未提供原 render 的恢复操作；新点击生成会产生新 operationId。不能把测试中手动再次调用底层 `executeImageOperation` 当作用户已能恢复原任务的证据。

处理要求：在保留逐 render 错误信息的同时，明确区分任务完成、确定失败和待恢复；让真实工作流及 Web 接口呈现并处理这些状态，提供沿用原身份的恢复路径。复验应检查顶层最终状态与实际恢复入口。

### F02：不确定 HTTP 错误会触发第二次远端提交

位置：[rp-comfyui.mjs:191](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui.mjs:191)、[image-execution.mjs:267](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/image-execution.mjs:267)。

所有非 2xx 响应均标为 `comfy_queue_rejected`。上层将它列为明确失败，把 render 转为 `failed`；下一次执行重新生成任务 ID 并 POST。网关已经转交任务、但未能返回上游响应时的 502 并不证明任务没有被接收。

探针使用实际 ComfyUI 适配器和本机 HTTP 服务：服务记录已接收的任务后返回 502，下一次调用正常响应。实际结果为第一次 `failed`，重试 `completed`，**接收 POST 数为 2，任务 ID 改变**。

处理要求：仅把有明确未接收证据的拒绝归为可重新提交；不确定响应保留原任务身份并查询原任务。补 HTTP 状态与业务拒绝体的故障矩阵，不能只测连接直接断开。

### F03：有效 profile 覆盖没有被冻结

位置：[rp-comfyui.mjs:55](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui.mjs:55)、[rp-comfyui.mjs:178](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-comfyui.mjs:178)、[image-execution.mjs:240](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/image-execution.mjs:240)。

profile 的 `digest` 只散列原始 profile 文件，不包含合并后的有效 prompt 覆盖；`generate` 又重新加载当前 profile 并组装 prompt。已保存 render 中的 `positivePrompt/negativePrompt` 未被用于实际提交，也没有与最终提交值比对。

探针先通过真实数据服务保存请求和 render，再通过真实 `saveProfileOverride` 修改前缀，最后执行原操作。render 保存的是 `old style, first prompt`，实际 HTTP 请求却是 `new style, first prompt`，流程仍显示 `completed`，profile digest 保持不变。

处理要求：冻结有效执行配置及真正发送的提示词，覆盖也纳入版本/摘要；提交使用同一份冻结配置，避免检查后再次加载不同配置。需要变更配置时明确形成新操作或报告冲突。

### F04：配置变化后，真实入口到不了原任务恢复分支

位置：[resolve-input.mjs:15](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/resolve-input.mjs:15)、[resolve-input.mjs:53](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/resolve-input.mjs:53)、[persist-and-render.mjs](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/workflow/persist-and-render.mjs)。

入口在查已有 operationId 之前重新读取当前 profile 和聊天内容，重新构建输入指纹。连接地址/profile 改动会先触发 `image_operation_conflict`，即使原请求已经保存提示词和可恢复的 render。持久化节点也在 ready 分支前先调用当前 profiles 查询。底层 `resumeRender` 支持冻结连接，不能证明整条入口链路能抵达它。

探针保存 ready 请求后只修改服务返回的连接地址，再用同一 operationId 和原始请求调用实际 `resolve-input`，得到 `image_operation_conflict`。旧请求没有得到复用。若 profile 被删除或变为无效，当前 profile 加载同样会提前失败。

处理要求：入口先定位已有操作；重放/恢复使用该操作已冻结的源、profile 绑定和 render，分别校验用户是否改变原始请求。新增操作才按当前设置构建输入；补 ready/completed/submitting 记录在配置变化后的真实入口测试。

### F05：同 ID 不同内容的冲突保护不完整

位置：[rp-workflow-engine.mjs:110](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflow-engine.mjs:110)、[image-execution.mjs:34](M:/ai/SillyTavern/bobo-agent-rp/global-modules/comfy-image-generation/runtime/image-execution.mjs:34)。

两条实际路径漏检：活动工作流在 `reuseActive` 时只按键直接返回旧 run，不检查请求内容；派生重生成的输入指纹不包括用户编辑的 `contentPrompts`。

探针分别得到：同 operationId 从 `customBrief=alpha` 改为 `beta`，仍返回原 run；同 operationId 将提示词改为 `different edited prompt`，指纹保持相同并返回旧的 `first prompt`，未报告冲突。

处理要求：对显式同 ID 重放采用一致的业务输入冲突检查；区分普通生成的 Agent 输出和派生重生成的用户输入。不能因不同 ID 的内容相同而阻止用户有意再生成。

### F06：多实例定义与真实实例键不一致

位置：[rp-workflows.mjs:848](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflows.mjs:848)、[rp-workflow-engine.mjs:370](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/lib/rp-workflow-engine.mjs:370)。

上次追加修改只放开了规范化：有精确集合锁的 `module-internal` 可以声明 `mode=multiple`。但 `resolveInstanceKey` 仍对全部内部工作流直接返回规范工作流名，未使用 dedupeKey。

以实际生图内部定义测试，operationId `a` 与 `b` 得到完全相同的 `comfy-image-generation/agent-image-generation` 键。因而“按操作 ID 分开的内部多实例”并未实现。另一个需联动处理的点是：调用前查活动键使用 `normalizedRequest.arguments`，真正 `start` 时提供的 payload 却是 `{call: normalizedRequest}`，仅删除该提前返回仍不足以接通声明的参数路径。

处理要求：统一 start、子调用检查和 restore 的键来源；保留集合锁对写入冲突的调度。或者明确撤销不需要的内部多实例设计，不留下配置允许、运行不生效的接口。

### F07：后台排队时冻结剧情可能在消费前被清理

位置：[director-post-turn/workflow.json:4](M:/ai/SillyTavern/bobo-agent-rp/global-modules/world-narrative-coordinator/integration/workflows/director-post-turn/workflow.json:4)、[pi-rp-web.ts:1649](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:1649)、[pi-rp-web.ts:2594](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/assets/pi-rp-runtime/.pi/extensions/pi-rp-web.ts:2594)。

后置导演输出的 `story-context` 使用 `retain=turn`；触发深度导演时只在 payload 中保存源路径，复制发生在消费者实际执行时。深度导演是非阻塞后台任务，可能等待工作槽；下一轮输入会清理上一轮 retain=turn 文件。

探针使用实际后置/深度包装定义、公共工件登记、调度器和清理函数：占住后台工作槽，启动深度导演，清理下一轮工件后释放工作槽。结果为 `awaiting-model-choice`，首节点因原冻结路径 `ENOENT` 失败。这直接违反修复方案要求的“消费者延迟跨回合仍可读”。

处理要求：在触发时建立消费者持有的稳定副本或引用保留机制，生命周期延续到消费完成；复验包含排队、跨回合和重启，不能只测立即读取或单次复制。

### F08：发布检查没有检验实际 Git 目标的内容

位置：[check_release_manifest.mjs:7](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs:7)、[check_release_manifest.mjs:75](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs:75)、[check_release_manifest.mjs:91](M:/ai/SillyTavern/bobo-agent-rp/.agents/skills/st-card-to-pi-rp/scripts/check_release_manifest.mjs:91)。

`--staged`/`--commit` 只从 Git 读取文件名集合，manifest、契约、工作流等内容仍读当前工作区。生成一致性检查还被限定为 workspace 模式。因此工作区正确不能保证实际暂存或提交内容正确。

探针在隔离临时仓库中把故事 schema 改成 `{"broken":true}` 并暂存，再恢复工作区文件。`--staged` 仍退出 0，宣称 5 个模块及全部引用完整；`git show :.../story.schema.json` 确认被检查的暂存区确实是损坏内容。

处理要求：目标模式从相应 Git tree/index 读取内容，依该目标的声明解析依赖并检查生成一致性。补缺模块、漏依赖、生成漂移及工作区/暂存区不同内容的负例。

## 重新运行的验证

现有测试的通过记录有效，但不足以支持全部方案验收通过：

| 验证 | 本次结果 | 退出码 |
|---|---|---|
| 根目录 `node --test` | 39/39 通过 | 0 |
| 公共 `.pi/lib`、Web `test`、ComfyUI 适配 `scripts` 下全部 `*.test.mjs` | 122/122 通过 | 0 |
| Python `test_extract_card.py` | 3/3 通过 | 0 |
| Python `test_skill_contract.py` | 4/4 通过 | 0 |
| Python `test_validate_card_pack.py` | 9/9 通过 | 0 |
| Python `test_inventory_card.py` | 2/2 通过 | 0 |
| Narrative-memory 模块校验 | 通过 | 0 |
| 全部实际工作流定义规范化 | 41 个通过 | 0 |
| 故事规范生成副本 `--check` | 工作区通过 | 0 |
| 发布清单工作区检查 | 5 模块、145 引用、224 模块文件 | 0 |
| `git diff --check` | 通过 | 0 |
| 补充复核探针 | 成功复现上述问题；退出码只表示探针运行完成 | 0 |

Python 使用 `C:\Users\bayue\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -X utf8` 逐文件执行，没有使用 PATH 中的占位解释器。

可复现探针：[PROJECT-REVIEW-RECHECK-PROBES-2026-09-14.mjs](M:/ai/SillyTavern/bobo-agent-rp/PROJECT-REVIEW-RECHECK-PROBES-2026-09-14.mjs)。在仓库根目录运行：

```powershell
rtk node PROJECT-REVIEW-RECHECK-PROBES-2026-09-14.mjs
```

探针创建独立临时数据与本机 HTTP 替身，不连接实际 ComfyUI；发布负例只对临时仓库执行 `git init`/`git add`。控制台给出临时路径和原始观察结果，保留以便复查。

## 原方案状态与验收边界

R04/R12（生图生命周期）、R05（发布检查）、R06/R17（跨回合资料保留）、R18（提交失败传播）不能继续标为全部通过；内部多实例的上次追加交付也尚不完整。其余已验证的排序、目标查询、故事规范源、记忆任务物化等不因本次缺陷而整体撤销。

R03 继续按用户确认保留记忆 Agent 的灵活控制；R15 不增加硬查询次数限制。固定提示词装配仍有原回归覆盖，F03 是生图有效配置与实际执行不一致，并非取消固定提示词需求。

真实模型、实际 ComfyUI 配置、新转换卡完整 RP 回合仍未验收，但本报告中的 8 项问题均已有确定性证据，不能归入这些尚未运行的外部验证。建议先修 F01—F04、F07，再补 F05/F06/F08，并把这些组合与负例加入正常验收，之后重新作出总通过结论。
