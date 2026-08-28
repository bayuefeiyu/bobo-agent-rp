function primitiveNode(value) {
  if (value === null) return { kind: "value", valueType: "null", display: "空值" };
  if (typeof value === "boolean") return { kind: "value", valueType: "boolean", display: value ? "是" : "否" };
  if (typeof value === "string") return { kind: "value", valueType: "string", display: value || "—" };
  if (typeof value === "number") return { kind: "value", valueType: "number", display: String(value) };
  return { kind: "value", valueType: "unknown", display: value === undefined ? "—" : String(value) };
}

export function buildModuleJsonTree(value) {
  if (Array.isArray(value)) {
    return {
      kind: "array",
      count: value.length,
      emptyLabel: "空列表",
      entries: value.map((item, index) => ({ key: `第 ${index + 1} 项`, node: buildModuleJsonTree(item) })),
    };
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return {
      kind: "object",
      count: entries.length,
      emptyLabel: "暂无字段",
      entries: entries.map(([key, item]) => ({ key, node: buildModuleJsonTree(item) })),
    };
  }
  return primitiveNode(value);
}
