function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some(type => type === valueType(value) || (type === "number" && typeof value === "number" && Number.isFinite(value)) || (type === "object" && value && typeof value === "object" && !Array.isArray(value)));
}

export function validateJsonSchema(value, schema, path = "/data") {
  const errors = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [{ path, code: "invalid_schema", message: "Schema must be an object." }];
  if (schema.type !== undefined && !matchesType(value, schema.type)) return [{ path, code: "type", message: `Expected ${JSON.stringify(schema.type)} but received ${valueType(value)}.` }];
  if (schema.const !== undefined && !Object.is(value, schema.const)) errors.push({ path, code: "const", message: "Value does not match const." });
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) errors.push({ path, code: "enum", message: "Value is not in enum." });
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push({ path, code: "minLength", message: `String is shorter than ${schema.minLength}.` });
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push({ path, code: "maxLength", message: `String is longer than ${schema.maxLength}.` });
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push({ path, code: "pattern", message: "String does not match pattern." });
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push({ path, code: "minimum", message: `Number is below ${schema.minimum}.` });
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push({ path, code: "maximum", message: `Number is above ${schema.maximum}.` });
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push({ path, code: "minItems", message: `Array has fewer than ${schema.minItems} items.` });
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push({ path, code: "maxItems", message: `Array has more than ${schema.maxItems} items.` });
    if (schema.items && typeof schema.items === "object") value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, `${path}/${index}`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push({ path: `${path}/${key}`, code: "required", message: "Required property is missing." });
    for (const [key, child] of Object.entries(schema.properties || {})) if (Object.hasOwn(value, key)) errors.push(...validateJsonSchema(value[key], child, `${path}/${key}`));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties || {}, key)) errors.push({ path: `${path}/${key}`, code: "additionalProperties", message: "Additional property is not allowed." });
    }
  }
  for (const [keyword, mode] of [["allOf", "all"], ["anyOf", "any"], ["oneOf", "one"]]) {
    if (!Array.isArray(schema[keyword])) continue;
    const branches = schema[keyword].map(child => validateJsonSchema(value, child, path));
    const passes = branches.filter(branch => branch.length === 0).length;
    if ((mode === "all" && passes !== branches.length) || (mode === "any" && passes === 0) || (mode === "one" && passes !== 1)) errors.push({ path, code: keyword, message: `Value does not satisfy ${keyword}.` });
  }
  return errors;
}
