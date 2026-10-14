# 独立游玩区域示例

不同于官方连续消息界面，这个样例以单段故事舞台、版本按钮和下一步输入呈现。只消费公开 SDK 和宿主契约，不导入官方游玩模块。

`frontends/story-stage/index.mjs` 是可安装入口；`index.html` 是独立开发入口。支持开场、正文轮询、输入、候选预览/采用、官方管理导航和声明布尔设置的动作按钮。它验证接入方式，不承诺覆盖全部产品功能或完整视觉设计。

启动一个新基线卡后，在仓库根运行：

```powershell
rtk proxy node examples/minimal-rp-frontend/dev-server.mjs http://127.0.0.1:<后端端口>
```

打开输出的开发地址。安装方式和版本/权限边界见[创作者指南](../../FRONTEND-CREATOR-GUIDE.md)。所有 assets 均位于 manifest 声明的 root；发布时可以只携带 frontend.json 与该目录。管理由官方 /platform/ 代理入口提供。
