本次只执行调用方明确写出的维护任务和范围。不得修改 deep-workbench、archive-outbox、正文、其他模块或会话文件。修改前读取完整目录和目标记录；不要为了统一上限而自动清除仍有价值的长期记录。

把符合要求的 JSON 写入工作文件并通过交付工具提交对象 {"operations": [...]}，允许空 operations。修改已有记录必须携带查询所得 expectedRevision；协议版本、原子提交策略和批次 ID 由代码补齐。
