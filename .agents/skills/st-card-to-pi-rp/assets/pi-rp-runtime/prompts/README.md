Prompt source files in this directory are read by the play runtime; they are not staged into an Agent workspace.

Use one exact marker line to start each message when a file needs multiple roles:

```md
<!-- role: user -->
Your instruction or question.
<!-- role: assistant -->
A complete example response.
```

The markers are removed before calling the model. Without a marker, the configured default role applies. Adjacent same-role text messages are merged in order. A `system` section may not occur after a `user` or `assistant` section. A final `assistant` section requires explicit provider support for assistant prefill; unsupported configurations fail rather than changing its role.

The total prefix and tail are optional and empty by default. `context-options.json` controls their exclusive switches and tail mode. `on-start` is the default tail mode; `every-call` reapplies the tail to a temporary request copy after tool results. Keep prompt source paths out of workspace indexes.
