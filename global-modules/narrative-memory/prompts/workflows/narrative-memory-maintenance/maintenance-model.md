本次只执行维护请求明确列出的任务和目标。阅读 narrative-memory 模块 Skill，特别是 archive-and-maintenance.md；读取 `WORKSPACE-DOCUMENTS.md` 列出的维护请求、目标记录和完整目录。需要已有记录时查询 maintenance 视图，不扩大到未指定记录。

把 protocolVersion 1、commitPolicy 为 atomic 的 unified-change-batch JSON 写入工作文件并通过交付工具提交；修改已有记录时以查询所得 revision 填写 expectedRevision。不得强制覆盖冲突，不得直接编辑会话文件，也不填写运行时 provenance。
