// Pi 宿主边界冒烟声明（S2）。
//
// 目的：让 `npm run typecheck` 有一个**真实且可通过**的检查对象，而不是只检查一个空文件集。
// 这里以程序方式断言宿主边界的关键形状：TypeBox schema 字面量类型必须被保留，ExtensionAPI /
// ExtensionContext 的成员必须存在。若 `types/pi-rp-host.d.ts` 的声明退化（例如 Static 或
// Type.Literal 塌陷成 any / never），本文件会立即报错。
//
// 注意：本文件不是运行时资产，不进入卡包。
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// —— schema 字面量类型必须被保留 ——
const workflowLiteral = Type.Literal("standard-rp");
const regionType = Type.Union([Type.Literal("record-browser"), Type.Literal("story-browser")]);
const parameters = Type.Object(
  {
    card: Type.String({ minLength: 1 }),
    commitPolicy: Type.Optional(Type.Union([Type.Literal("atomic"), Type.Literal("grouped"), Type.Literal("best-effort")])),
    changes: Type.Array(Type.Object({ action: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("cancel")]) })),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
  },
  { additionalProperties: false },
);

type Parameters = Static<typeof parameters>;

// 必需字段保持必需。
const full: Parameters = {
  card: "demo",
  commitPolicy: "atomic",
  changes: [{ action: "add" }],
  arguments: { any: 1 },
};
export const boundaryParameters: Parameters = full;

// 具体字面量不得退化为 string。
export const boundaryWorkflow: Static<typeof workflowLiteral> = "standard-rp";
export const boundaryRegion: Static<typeof regionType> = "story-browser";

// —— 宿主类型成员必须存在（缺成员会在此处报错） ——
type HostApiSurface = Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand" | "registerProvider" | "unregisterProvider" | "sendUserMessage">;
type HostContextSurface = Pick<ExtensionContext, "cwd" | "ui" | "model" | "modelRegistry" | "sessionManager" | "isIdle" | "abort" | "shutdown">;
// `waitForIdle` 属于 ExtensionCommandContext，而不是 ExtensionContext——不要把它放进上面的断言集。
export type { HostApiSurface, HostContextSurface };

// 负例以注释形式保留，避免它们污染构建：
//   const wrongPolicy: Parameters = { card: "a", commitPolicy: "bogus" };  // 违反字面量联合
//   const missingCard: Parameters = { commitPolicy: "atomic" };            // 缺必需字段
//   const wrongLiteral: Static<typeof workflowLiteral> = "advanced";       // 违反字面量类型
