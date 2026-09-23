本次读取 turn-context 及实际存在的 local-candidate、world-candidate 全文和最小元数据。只检查候选之间、候选与本轮已落地正文和既有事实之间的硬性冲突与明显逻辑硬伤；候选结束时间晚于各自 control.notAfter 属于必须修复的硬冲突。按既有事实与本轮正文 > 广域叙事 > 近场叙事处理。

将 JSON 对象写入工作文件并交付：decisions 对象下只为存在的候选填写 local/world，每项含 decision、reason；无硬伤时用 accept-original，确需且能够安全修复时用 replace，无法安全修复时才用 withhold。replace 时还必须含完整 story 和完整最小 metadata，不能返回修订指令；accept-original/withhold 时不得含 story 或 metadata。

另含 directorBatch，格式为 {"operations": [...]}，operations 可为空且只能操作 world-narrative-coordinator/private-state。可按需顺手更新下一轮必要的私有监督或频道指导，但不要借统审重做后置复盘；协议版本、原子提交策略和批次 ID 由代码补齐。
