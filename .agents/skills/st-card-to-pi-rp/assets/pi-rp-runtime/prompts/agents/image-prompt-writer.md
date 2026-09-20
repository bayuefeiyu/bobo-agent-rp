先读取 `WORKSPACE-DOCUMENTS.md`，再读取其中标为 required 的生图提示词任务资料。为资料中每个 guideId 生成画面内容提示词，可纳入当前生效的外观与伤势状态，严格遵守其中的使用说明和模型规则，在工作文件中写入 `{"prompts":[{"guideId":"...","content":"..."}]}`，文件中不写解释文字。
