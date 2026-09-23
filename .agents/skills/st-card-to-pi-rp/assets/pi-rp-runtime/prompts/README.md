Prompt source files in this directory are read by the play runtime; they are not staged into an Agent workspace. The complete Chinese directory, role, inclusion, and authoring guide is [提示词目录、角色与手写指南](../../prompt-templates/README.md).

The project-wide list of creative, non-creative, system, Agent, and workflow prompt sources is [prompt-inventory.md](../../../references/prompt-inventory.md). Conversion-only starter material lives separately under [prompt-templates](../../prompt-templates/README.md) and is not copied into a card unless the conversion proposal selects it and places it in an existing Agent prompt, node prompt, or static-resource destination.

Imported modules keep their authored sources under `global-modules/<module-id>/prompts/`. Conversion copies those files into this card-owned prompt tree at `prompts/modules/<module-id>/`; module Agent and workflow JSON already point at those destination paths.

Repository development mode resolves that destination-style path back to the matching global module source. An isolated packaged card never uses this fallback; a missing card-owned module prompt is an error.

Use one exact marker line to start each message when a file needs multiple roles:

```md
<!-- role: user -->
Your instruction or question.
<!-- role: assistant -->
A complete example response.
```

The markers are removed before calling the model. Without a marker, the configured default role applies. Adjacent same-role text messages are merged in order. A `system` section may not occur after a `user` or `assistant` section. A final `assistant` section requires explicit provider support for assistant prefill; unsupported configurations fail rather than changing its role.

The total prefix and tail are optional and empty by default. `context-options.json` controls their exclusive switches and tail mode. `on-start` is the default tail mode; `every-call` reapplies the tail to a temporary request copy after tool results. Keep prompt source paths out of workspace indexes.

## 分阶段节点任务

普通 Agent 节点的任务提示词可以用独占一行的 `<!-- stage -->` 分隔阶段。第一条标记之前的内容是共同要求，只在节点启动时随第一阶段一起发放；每条标记后的非空内容按文件顺序成为一个阶段。后续阶段不会出现在初始模型上下文中，Agent 完成当前阶段并单独调用 `rp_task_next({})` 后，运行时才把下一阶段作为新的用户消息加入同一会话。代码围栏内的标记不参与解析。没有标记的提示词保持单阶段兼容行为。`team` 节点和 team 成员提示词不支持该格式。

分阶段提示词不要在共同要求、Agent 常驻提示或早期阶段中复述后续阶段的具体任务。最后一个阶段完成后仍需调用一次 `rp_task_next({})` 取得“所有阶段均已发放”的回执，再按统一交付协议调用 `rp_node_complete({})`。运行时只约束发放顺序，不判断一个阶段的内容是否已经充分完成。
