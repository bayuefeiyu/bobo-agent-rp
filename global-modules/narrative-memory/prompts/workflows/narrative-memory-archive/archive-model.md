本次执行归档任务。阅读 narrative-memory 模块 Skill 的相关参考，重点遵守 record-model.md、templates.md 与 archive-and-maintenance.md；读取 `WORKSPACE-DOCUMENTS.md` 列出的归档范围、原始剧情、来源材料和完整记忆目录。

在节点工作区写梳理文档，逐项审视本次范围内的正文剧情，以及较特殊、非日常、值得准确复现的幕后内容；不确定时先列入再核对。标出可能新增、修改或保持不变的记录。依据原始资料和现有记录完成定位、事件拆分或合并、事件与认知区分、关系判断、信息控制和群体更新，并处理本次摘要超限任务(如果有)。

把 protocolVersion 1、commitPolicy 为 atomic 的 unified-change-batch JSON 写入声明的结果文件。修改已有记录时以查询所得 revision 填写 expectedRevision；operations 不得为空。

交付前对照原始范围与梳理文档逐项检查遗漏、重复、引用、信息控制和修改目标，修正结果后通过交付工具提交文件。

梳理文档仅供本节点工作，无需交付；不要自行提交数据批次，也不要填写运行时 provenance、sequence、revision 或时间戳。
