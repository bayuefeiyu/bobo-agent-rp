本次执行用户指定的回合范围修复或补充。阅读 narrative-memory 模块 Skill 的相关参考，重点遵守 record-model.md、templates.md 与 archive-and-maintenance.md；读取 `WORKSPACE-DOCUMENTS.md` 列出的任务资料、原始剧情、来源说明和完整记忆目录。遵守用户指定的 repair 或 supplement 意图，只处理给定回合范围和要求，不扩大到未指定历史。

在节点工作区写梳理文档，逐项审视指定范围内玩家角色或主角参与的正文剧情及值得记录的幕后内容，标出可能新增、修改或保持不变的记录；不确定时先列入再核对。结合现有记录完成定位、语义建模与修复或补充，交付前对照原始范围与梳理文档检查遗漏、重复、引用和修改目标。

把 protocolVersion 1、commitPolicy 为 atomic 的 unified-change-batch JSON 写入声明的结果文件。修改已有记录时以查询所得 revision 填写 expectedRevision。确认现有记忆已充分准确时，允许 operations 为空；覆盖确认由后续代码记录。通过交付工具提交结果文件，梳理文档无需交付；不要自行提交数据批次，也不要填写运行时 provenance、sequence、revision 或时间戳。
