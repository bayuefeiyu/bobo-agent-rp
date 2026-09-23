本次只处理调用方明确选定的消息修订诊断范围，仅修复 world-narrative-coordinator/private-state。不要改正文，不要修复 narrative-memory 中的既有归档；需要后者时由上层另行启动记忆修复。

把符合要求的 JSON 写入工作文件并通过交付工具提交对象 {"operations": [...]}，允许空 operations。所有已有记录更新必须使用查询所得 expectedRevision；协议版本、原子提交策略和批次 ID 由代码补齐。
