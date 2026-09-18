import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DATA_GET_PARAMETERS, DATA_GET_REQUIRED, DATA_QUERY_PARAMETERS, DATA_QUERY_REQUIRED } from "./rp-data-tool-schemas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXTENSION = resolve(here, "..", "extensions", "pi-rp-web.ts");
const Type = await loadType();

/** Load the typebox build Pi itself ships; the repository does not vendor it. */
async function loadType() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  for (const candidate of [
    resolve(appData, "npm", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "typebox", "build", "index.mjs"),
    resolve(appData, "npm", "node_modules", "typebox", "build", "index.mjs"),
  ]) {
    const loaded = await import(pathToFileURL(candidate).href).catch(() => null);
    if (loaded?.Type) return loaded.Type;
  }
  return null;
}

/**
 * Every function-calling tool the bridge registers, with the exact `parameters:` expression the
 * provider receives. RC-02 shipped `rp_data_query`/`rp_data_get` with a `Type.Any()` root, which
 * typebox compiles to `{}`; providers reject that as `type: null` before the Agent runs, so no
 * amount of retrying or model switching could help. These assertions read the shipped source and
 * compile each declaration, which is the same text the extension compiles at load time.
 */
function toolDeclarationSource(source) {
  const tools = [];
  const marker = "registerTool({";
  let cursor = 0;
  while (true) {
    const start = source.indexOf(marker, cursor);
    if (start === -1) break;
    const block = source.slice(start + marker.length);
    const name = /name:\s*"([^"]+)"/.exec(block)?.[1];
    const parametersAt = block.indexOf("parameters:");
    assert.ok(parametersAt !== -1, `tool ${name} declares parameters`);
    const expression = balancedExpression(block.slice(parametersAt + "parameters:".length).trimStart());
    assert.ok(name, `tool at offset ${start} declares a name`);
    tools.push({ name, expression });
    cursor = start + marker.length;
  }
  return tools;
}

/** Slice one balanced JS expression, seeing through strings, template literals, and comments. */
function balancedExpression(text) {
  const closers = { "(": ")", "[": "]", "{": "}" };
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipString(text, index);
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index = text.indexOf("*/", index) + 1;
      continue;
    }
    if (closers[character]) {
      stack.push(closers[character]);
      continue;
    }
    if (character === ")" || character === "]" || character === "}") {
      // Only the bracket that closes the outermost expression ends it; inner literals such as
      // `Type.String({ minLength: 1 })` must not be mistaken for the end of the declaration.
      if (!stack.length || stack.pop() !== character) return text.slice(0, index);
      if (!stack.length) return text.slice(0, index + 1);
    }
  }
  return text.split("\n")[0].replace(/,\s*$/, "");
}

function skipString(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return text.length;
}

/**
 * Take the shipped `toolParameters` builder from the extension so the test compiles the real one
 * rather than a re-implementation. Its two parameter annotations are removed here; everything else
 * in the body is copied verbatim.
 */
function toolParametersFactory(source) {
  const start = source.indexOf("function toolParameters(");
  assert.notEqual(start, -1, "the extension declares a toolParameters builder");
  const signature = source.slice(source.indexOf("(", start), source.indexOf("{", start));
  const body = balancedExpression(source.slice(source.indexOf("{", start)));
  const typed = signature.replace("parameters: Record<string, any>", "parameters").replace("required: readonly string[]", "required");
  return `function ${typed} ${body}`;
}

function compile(expression, Type, source) {
  const scope = {
    Type,
    DATA_QUERY_PARAMETERS,
    DATA_GET_PARAMETERS,
    DATA_QUERY_REQUIRED,
    DATA_GET_REQUIRED,
    allowedWorkflowIds: ["memory/retrieve", "narrative-memory/narrative-memory-retrieve"],
  };
  const names = Object.keys(scope);
  const declaration = toolParametersFactory(source);
  // `rp_call` builds its workflow union from a typed callback; drop exactly that annotation.
  const evaluated = expression.replace("(reference: string) =>", "reference =>");
  const statement = `"use strict"; const toolParameters = ${declaration}; return (${evaluated});`;
  try {
    return Function(...names, statement)(...names.map(name => scope[name]));
  } catch (error) {
    throw new Error(`${error.message}\n--- generated ---\n${statement}`);
  }
}

function assertObjectRoot(schema, label) {
  assert.equal(schema.type, "object", `${label} must declare an object root schema`);
  assert.ok(schema.properties && typeof schema.properties === "object", `${label} must declare properties`);
  assert.ok(Array.isArray(schema.required), `${label} must declare required`);
  for (const name of schema.required) assert.ok(Object.hasOwn(schema.properties, name), `${label}.required names declared property ${name}`);
}

test("the shipped data tool descriptors stay object-rooted and complete", () => {
  assert.ok(Object.keys(DATA_QUERY_PARAMETERS).length >= 10, "rp_data_query exposes the full query surface");
  for (const [name, schema] of Object.entries(DATA_QUERY_PARAMETERS)) assert.equal(typeof schema.type === "string" || Array.isArray(schema.type), true, `${name} declares a type`);
  assert.deepEqual(DATA_QUERY_REQUIRED, ["moduleId", "collectionId"]);
  assert.deepEqual(DATA_GET_REQUIRED, ["moduleId", "collectionId", "id"]);
  for (const name of DATA_GET_REQUIRED) assert.ok(Object.hasOwn(DATA_GET_PARAMETERS, name), `rp_data_get declares ${name}`);
});

test("the extension no longer builds a data tool root out of Type.Any()", async () => {
  const source = await readFile(EXTENSION, "utf8");
  const declarations = toolDeclarationSource(source);
  assert.ok(declarations.length >= 7, `expected every registered tool, found ${declarations.length}`);
  const dataQuery = declarations.find(item => item.name === "rp_data_query");
  const dataGet = declarations.find(item => item.name === "rp_data_get");
  assert.ok(dataQuery, "rp_data_query is registered");
  assert.ok(dataGet, "rp_data_get is registered");
  for (const declaration of [dataQuery, dataGet]) {
    assert.equal(declaration.expression.includes("Type.Any()"), false, `${declaration.name} must not use Type.Any() as its parameter root`);
    assert.match(declaration.expression, /toolParameters\(/, `${declaration.name} uses the shared descriptor builder`);
  }
  assert.equal(source.includes("parameters: Type.Any()"), false, "no registered tool may declare an untyped parameter root");
});

test("every registered tool compiles to a provider-acceptable object schema", async t => {
  const source = await readFile(EXTENSION, "utf8");
  const declarations = toolDeclarationSource(source);
  if (!Type) {
    t.diagnostic("typebox is not installed next to Pi; the source-level assertions above still ran");
    return;
  }
  for (const declaration of declarations) {
    let schema;
    try {
      schema = compile(declaration.expression, Type, source);
    } catch (error) {
      assert.fail(`${declaration.name} parameter declaration is not a valid expression: ${error.message}\n${declaration.expression}`);
    }
    assertObjectRoot(schema, declaration.name);
  }
  const query = compile(declarations.find(item => item.name === "rp_data_query").expression, Type, source);
  assert.deepEqual(query.required, ["moduleId", "collectionId"]);
  assert.equal(query.properties.where.type, "object", "where stays an operator map");
  assert.equal(query.properties.where.additionalProperties.maxProperties, 1, "where values accept exactly one operator");
  assert.equal(query.properties.limit.type, "integer");
  assert.deepEqual(query.properties.cursor.type, ["string", "null"]);
  const get = compile(declarations.find(item => item.name === "rp_data_get").expression, Type, source);
  assert.deepEqual(get.required, ["moduleId", "collectionId", "id"]);
});
