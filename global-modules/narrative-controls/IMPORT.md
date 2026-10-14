# 正文模块导入

## 默认创作参考检索

转卡选用本模块时，默认配套 `creative-reference-library`，在方案中展示并允许用户明确排除。`standard-rp` 和 `advanced-memory-rp` 的正文节点只授权 b（`search-units`）一次，固定 `includeSemanticCandidates: false`。具体位置为已有资料与前置导演指导返回后、正文阶段开头、具体情节设计之前；协作模式由共创者调用，全体共享一次及返回资料，再交回主笔构思和写作。

未绑定或文本索引未就绪时不开放入口，提示词跳过；空结果正常继续。资料仅供参考，不自动成为本卡设定或剧情事实。用户明确排除时，转卡只移除资料库绑定和对应检索指引，保留其他创作流程；其他模块暂不默认接入。完整规则见[资料库默认接入](../creative-reference-library/IMPORT.md)。

## 正文文档与视图

本模块还拥有聊天的 `conversation` 集合。玩家输入、开场（第0轮）和每轮正文都是 `narrative.message` 文档，采用统一 Record Envelope v2。已采用正文按50回合分区保存到 `sessions/<卡ID>/<聊天ID>/modules/<正文模块ID>/collections/conversation/records/`；各尝试文档与关联模块成果由公共执行清单和共享不可变版本保存。`turn-finalize` 在所属尝试内发布，采用后更新正式集合。文档ID就是消息ID，绑定所属回合；修改保留同一ID、递增revision、追加完整修订。

前端最新轮有再次生成和版本选择，可预览候选及对应成果，再采用。进入下一轮后候选锁定但保留；删除后续轮次可重新选择。手改保留生成来源与用户修订来源，不强制其他成果重算。完整规则见[工作流执行协议](../../.agents/skills/design-pi-rp-data/references/workflow-executions.md)。

`rp` 对象视图输出 `role`、`kind`、`content`、`narrativeSource`。前端正文区、运行时消息转录、最近上下文和记忆归档都读取这些文档的当前有效修订；最近上下文与归档只是同一视图的不同回合范围。`messages.jsonl` 是兼容现有消息接口的投影缓存，删除或改动后会从模块权威记录重建。`transcript.json` 固定本聊天的provider并记录当前投影指纹；权威记录损坏时报告错误，不以缓存反向覆盖权威记录。

宿主开场、输入、发布和编辑使用统一原子变更批次，与权威分区、索引、投影和聊天元数据一起提交。浏览器编辑带 `expectedRevision` 和稳定 `operationId`，过期编辑返回409，同一操作重试不生成额外修订。普通创作Agent继续接收工作流冻结的消息投影，不获得正文写权限。

删除某楼层会删除该楼层及之后全部文档的所有修订，并按原有消息绑定规则清理其他模块数据和工作流状态；删除本轮assistant正文时，其之前的玩家输入保留。正文拨档设置仍按原规则保留。最近完整回合窗口保持既有语义：开场计为第0轮，正文Agent从窗口内第一条assistant正文开始，之前的玩家输入不补入。

前端消息增加稳定 `id` 和 `revision`；`GET /api/transcript` 支持 `fromTurn`、`toTurn`、`beforeSequence`、`cursor`、`limit`（最多500条），返回当前修订的消息投影；`GET /api/messages/<sequence>/history` 支持 `revision`、`beforeRevision`、`limit`（最多100条），返回最新修订及历史修订，按revision倒序排列。这些接口沿用当前正文区域，不引入新渲染器。

替代正文模块只需采用相同文档结构和对象视图，在卡manifest显式声明 `transcript_provider: {schemaVersion:1,moduleId,collectionId,recordType,view}`。打包器可从唯一的 `conversation/narrative.message` 集合发现provider；多候选需显式指定。聊天首次写入后provider固定，不能通过改配置切换已有聊天的权威来源。本阶段只保留这一接入接口。

## 旧聊天迁移边界

旧聊天只有 `messages.jsonl` 时，新运行时明确提示需迁移，不自动导入。本次开发只修改根目录源码和模板，没有升级已安装的卡、`play/` 或真实聊天。迁移是另行指定卡和聊天范围的维护操作：先冻结依赖并备份运行目录，再逐条保留旧消息ID、sequence、turn、revision、时间和来源信息转换为统一文档，绑定自身ID，通过同一事务写入分区、provider清单及投影，最后核对条数、内容和其他模块引用并验证恢复聊天。旧格式已覆盖的修订无法还原，不能伪造历史版本；迁移失败须保留原文件和备份。

用户确认导入后，将全局源包 `global-modules/narrative-controls/` 完整复制到卡片 `features/narrative-controls/` 并注册其 `module.json`。`agents/`、`prompts/`、`workflows/`、`runtime/`、`documents/` 与 `module.json` 都留在模块目录内，不把内容摊平到卡片根目录，也不建立根级提示词或工作流副本。模块 manifest 使用 schema 7，以 `agentFiles` 和 `workflowFiles` 注册全部自有 Agent 与工作流；每个工作流使用 schema 4 并声明 `ownerModuleId`，Agent、工作流目标和触发器引用使用 `narrative-controls/<id>` 这类全限定 ID，`promptFile` 与 `entryFile` 保持模块相对路径。这是独立的卡片副本；根目录、已有卡片和会话之间没有自动同步。

本模块完整拥有正文链路：`narrative-writer` Agent、`standard-rp` 与 `advanced-memory-rp` 正文工作流、`compose-context`，以及两个正文工作流使用的 `runtime/prepare-recent-narrative-stories.mjs`。共享的 `assets/prompt-templates/` 与其他公共起步素材留在模块外，只在转卡时按已确认方案编译或展开到卡内 Agent 提示词、工作流节点提示词或静态资料；它们不是模块文件、manifest 条目或运行时依赖。公共运行时只提供通用的 engine、tools、system、models 与 common head/tail 提示词，不承载正文专属 Agent 或工作流。

正文模式可在现有 `standard-rp` 或 `advanced-memory-rp` 工作流上切换普通 Agent 与 collaboration team profile；切换保留工作流/节点 ID，并通过模块内小型预设引用对应成员、模型和提示词。v1 meeting 与 v2 collaboration 的成员权限、交接、`narrative.md`/`rp_deliver`、共享转录和恢复边界见 [TEAM-COLLABORATION.md](TEAM-COLLABORATION.md)。

## 源资源与生效资料

`documents/options/` 是可切换提示词源资源，与普通静态资料库分开；`controls.json` 明确项目、档位标签和对应文档。不要把它们复制到 `card-context-library/documents/`、Agent 提示词或模块 Skill。全部档位都要保留，不能只复制转卡时选中的一档。保留原文和来源，中文标签、内容可以使用规范 `{{user}}`，ID/路径/键不能使用姓名宏。

正文创作前调用 `narrative-controls/compose-context`：输入 `static-context` 为普通静态资料目录，输出 `context` 是同一目录的副本并加入当前生效的 `creative-requirements.md`；普通资料目录中使用普通创作指导的读取规则，不增设更高的权限或优先级。所有选中内容都为空时不添加空要求文档。

标准和高级记忆工作流模板中的 `prepare-creative-context` 是接入例子。正文 Agent 必须只接收组合后的目录，不能同时收到未经组合的第二份旧目录；目录内部的相对引用保持不变。调用只用代码查询 settings 的 processor 视图，正文 Agent 无需 moduleAccess/rp_call 权限。采用替代正文模块时，正文 Agent、入口工作流及脚本均放在替代模块内；按确认方案决定是否接入可切换要求，不能只保留散落的正文组件。

## 默认与界面

模块与其他前端模块位于同一面板，displayOrder=-1000 默认置顶；用户原有排序仍可覆盖。前端使用 prompt-controls 区域和 controls.json 生成互斥拨档。叙事节奏、抢话方式自动加首档“不追加”和末档“自定义”，默认不追加，以原卡固定创作资料为基础；转卡方案可根据用户确认设置初始档。自定义草稿切回预设仍保存。

正文任务的字数、语言、扩写要求改由拨档提供，三项不增加“不追加”。字数四档为800以内、800-1500、1500以上、自定义；语言两档为中文、自定义；扩写只有扩写、部分扩写、续写三档，以 allowCustom=false 禁用额外自定义。初始选择为800-1500、中文、部分扩写，沿用原高级记忆正文任务默认值。提示词使用已整理的夏瑾系列原文，字数按原变量句式展开指定范围，来源见 [PROMPT-SOURCES.md](PROMPT-SOURCES.md)。不要把这三项再固定加入正文节点或 Agent 提示词，也不要把其他档位复制进普通静态资料。未导入本模块时，转卡方案需按原卡要求确定这三项的固定交付位置。

“其他要求”固定放在全部正文拨档最后，只有“默认”和“自定义”两档，初始选默认。默认正文在 `documents/options/other-requirements/default.md`，由创作者或转卡者填写，项目模板留空；玩家额外偏好填写到独立的 customText。两份内容分别保留，切换不互相覆盖，只有当前一档追加到前面所选要求之后；空文本不生成该段。它与普通静态创作准则同级，不直接插入 Agent 提示词。

设置存入每个聊天的 settings 快照，固定记录 narrative-preferences；使用统一事务及 expectedRevision 更新，绑定 turn=0，删除剧情后缀不会撤销玩家设置。新聊天使用卡片初始选择。每次前置准备读取运行开始时冻结的设置；正在运行的正文保持原设置，保存用于下一次正文生成。拨档准备代码不自动改写过去的剧情或记忆；正文由本模块的 narrative-writer 在前台工作流中创作。

## 扩展与其他材料

新增项目时同步 controls.json、catalog.json、preferences schema 和初始选择，保留“其他要求”的 last=true，使其始终排在新增项目之后。同目录不等于互斥；只把明确互斥的一组选项登记为一个项目。现有文风、NSFW等并列静态材料继续按普通静态资料规则处理，除非转换方案明确决定改为可切换项目。

导入必须使用支持 prompt-controls 的本项目运行时和 Web 模板。验证非法档位、目录越界、未选内容不能进入正文工作区、重启持久化、并发修订冲突、宏替换和同级资料交付。

## 可选历史原文回顾

正文模块提供默认关闭的历史原文回顾：短自然段聚合切片、按保护窗口和 CD 渐进索引、向量召回后 rerank，并把历史原文交付给创作节点。无需装配记忆或资料库模块。服务配置、启用方式及恢复操作见 [历史原文回顾](HISTORY-RECALL.md)。导入更新后的源模块和运行时才会获得此功能；已有卡和会话不会自动更新。
