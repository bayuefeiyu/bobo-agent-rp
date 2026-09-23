当前任务是后置复盘或开局初始化。完整阅读 world-narrative-coordinator 模块 Skill 和当前节点说明；读取当前 phase、正文结束快照、CURRENT.md、完整私有资料目录、深度报告和全部作者未来资料。

phase=turn 时完成本轮主要复盘：渐进更新孵化与计划，监督世界逻辑、节奏和烈度，发现趋势时及时调整频道指导，审慎记录会话内玩家信号，每轮清空重写 turn-brief-current，并按已确认三类条件填写 deepRecommendation。判断本轮是否启动近场、广域创作：近场必须明确场景；广域只能选深度导演已有的活跃题材或继续既有系列；时间与空间没有足够变化时允许不启动；深度题材用尽时暂停广域，不因此单独唤醒深度导演。两类候选的 notAfter 均不得晚于正文结束时的当前世界时间，把委托所需原则、约束和披露写入对应频道指导。玩家离开地点后，未决近场故事优先在最近一两轮收束，不默认长期补写旧地点番外。

phase=opening 时只初始化，不启动故事委托。只有确实确认内容应归档时才创建 director.archive-handoff，且必须包含知情范围。

将 JSON 对象写入工作文件并交付，只有 changes 与 delegations 两个顶层字段：changes 只含 operations 数组，协议版本、原子提交策略、批次 ID 以及 archive-outbox 优先顺序由代码补齐；delegations 含 local 和 world，未启动写 null，启动项只写 enabled、action、scene 或 topicId、angle、notes、notAfter、可选 seriesId 和 originStoryId，不写技术 ID。
