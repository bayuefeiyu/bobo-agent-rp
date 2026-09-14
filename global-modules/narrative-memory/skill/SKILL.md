---
name: narrative-memory
description: Retrieve, compose, archive, compress, inspect, or maintain this card's narrative-memory records when the active workflow explicitly grants the corresponding narrative-memory capabilities.
---

# 叙事记忆

本模块把长期剧情记忆保存为实体、关系、事件、事件摘要、认知和知情群体。模块 Skill 只解释语义和正确操作；实际查询、提交与工作流启动权限完全由当前节点的 `moduleAccess`、工具白名单和输出契约决定。

## 使用边界

- 调用方 Agent 不直接浏览记忆库；它先完成自身情景或任务分析，提出自然语言资料清单，再读取检索工作流返回的文档集。
- 检索只负责名称匹配、候选选择和查漏，不替创作节点判断人物身份、心理、剧情走向或最佳行动。
- 客观事件与角色认知分开。角色新讲述的旧事默认是认知，除非已有客观来源或明确作者层确认。
- 不创建每个角色的个人记忆副本；需要时按知情范围和信息控制即时组装。
- 所有持久修改通过统一变更批次提交，修改已有记录必须使用查询所得 `revision` 作为 `expectedRevision`。
- 目录、有效事件投影、时间线、筛选面和创作文档都是派生数据，不得作为平行权威记录维护。
- 目录与有效事件时间线统一通过 `narrative-memory-reference-snapshot` 生成；其他模块工作流不得维护或直接组装第二套目录。

## 按任务读取

- 设计、读取或修改记录前，阅读 [references/record-model.md](references/record-model.md) 与 [references/templates.md](references/templates.md)。
- 执行检索或组装前，阅读 [references/retrieval.md](references/retrieval.md)。
- 执行归档、压缩或维护前，阅读 [references/archive-and-maintenance.md](references/archive-and-maintenance.md)。
- 把检索节点接入正文、导演或编辑工作流前，阅读 [references/creative-integration.md](references/creative-integration.md)。
- 配置时间、开局或其他模块来源前，阅读 [references/time-openings-and-sources.md](references/time-openings-and-sources.md)。

## 通用写入要求

只写当前证据支持的内容。不要用常识补造独特历史，不因一次表现创建特殊态度，不把临时合作固化为长期关系，不为了填满模板制造空字段。

保持已有作者文字。转卡或初始化时，对原卡固有设定只做必要的梳理、拆分和重组；主要角色的性格与行为指导不能擅自缩减。

新建或更新记录后，确定性校验器负责去重 ID、派生筛选面、检查时间字段、解析群体和标记摘要超限。Agent不能伪造运行时 provenance、序号或历史修订。
