import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { validateJsonSchema } from "./rp-data-schema.mjs";
import { noTextOutputError } from "./rp-model-failures.mjs";

const INTERNAL = ".rp-delivery";
const LIMITS = { files: 500, bytes: 20 * 1024 * 1024, fileBytes: 5 * 1024 * 1024, depth: 12 };
const DEFAULT_INPUTS = ["handoff", "materials", "trigger", ".call-snapshots", "WORKSPACE-DOCUMENTS.md", "CALL-INPUTS.md"];
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const key = value => process.platform === "win32" ? value.toLowerCase() : value;
const canonical = value => key(posix.normalize(value.replaceAll("\\", "/")));
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Lexical + component checks: reject symlinks/junctions, including ancestors of new files. */
export async function workspacePath(workspace, requested, { root = false, internal = false } = {}) {
  if (typeof requested !== "string" || !requested.trim() || isAbsolute(requested) || /^[a-z]:/i.test(requested) || requested.includes(":")) {
    throw failure("delivery_path_invalid", "Use a path relative to this node workspace.");
  }
  const parts = requested.replaceAll("\\", "/").split("/");
  if (parts.includes("..")) throw failure("delivery_path_invalid", "Parent traversal is not allowed.");
  const base = resolve(workspace);
  const target = resolve(base, requested);
  const rel = relative(base, target);
  if ((!root && !rel) || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw failure("delivery_path_invalid", "Path must stay inside the node workspace.");
  const normalized = rel.replaceAll("\\", "/");
  if (!internal && overlaps(key(normalized), key(INTERNAL))) throw failure("delivery_path_invalid", "Delivery receipts and staging files are runtime-private.");
  let cursor = base;
  for (const part of rel ? rel.split(sep) : []) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw failure("delivery_path_invalid", "Symbolic links and junctions are not allowed.");
  }
  return { path: target, relative: normalized };
}

async function inventory(path, limits = LIMITS) {
  const files = [];
  let total = 0;
  let entries = 0;
  const visit = async (target, name, depth) => {
    if (++entries > limits.files * 2) throw failure("delivery_too_large", "Directory contains too many entries.");
    if (depth > limits.depth) throw failure("delivery_too_large", "Directory nesting exceeds the delivery limit.");
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw failure("delivery_path_invalid", "Delivered directories cannot contain symbolic links.");
    if (info.isDirectory()) {
      for (const entry of (await readdir(target)).sort()) await visit(resolve(target, entry), name ? `${name}/${entry}` : entry, depth + 1);
    } else if (info.isFile()) {
      if (info.size > limits.fileBytes) throw failure("delivery_too_large", "Delivery file exceeds size limit.");
      const content = await readFile(target);
      total += content.length;
      if (files.length >= limits.files || total > limits.bytes) throw failure("delivery_too_large", "Delivery exceeds file count or byte limit.");
      files.push({ path: name || ".", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex"), content });
    } else throw failure("delivery_path_invalid", "Only regular files and directories can be delivered.");
  };
  await visit(path, "", 0);
  return files;
}

const manifest = files => files.map(({ content, ...entry }) => entry);
const digest = files => createHash("sha256").update(JSON.stringify(manifest(files))).digest("hex");

function strictJson(text, label) {
  try { return JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (error) {
    throw failure("delivery_invalid_json", `${label}: ${error.message}. Edit the existing file and deliver it again; do not add Markdown fences.`);
  }
}

export function agentDeliveryContract(node, agent = {}) {
  const generatedId = node.metadata?.documentWorkspaceSnapshot?.output;
  const outputs = Object.fromEntries(Object.entries(node.outputs || {}).filter(([id]) => id !== generatedId));
  if (!Object.keys(outputs).length) throw failure("workflow_configuration_invalid", `Agent node ${node.id} must declare file or directory outputs.`);
  const primary = node.delivery?.primaryOutput || node.metadata?.textOutput || null;
  if (primary && (!outputs[primary] || outputs[primary].kind === "directory")) throw failure("workflow_configuration_invalid", `Node ${node.id} delivery.primaryOutput must name an Agent file output.`);
  if (agent.outputMode === "json" && (!primary || outputs[primary].format !== "json")) throw failure("workflow_configuration_invalid", `JSON Agent node ${node.id} must declare a JSON delivery.primaryOutput.`);
  const entries = Object.entries(node.outputs || {});
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (overlaps(canonical(entries[i][1].path), canonical(entries[j][1].path))) throw failure("workflow_configuration_invalid", `Node ${node.id} output paths must not overlap.`);
    }
  }
  return { outputs, primary, maxReminders: node.delivery?.maxReminders ?? 2 };
}

export function deliveryPrompt(contract) {
  return [
    "## 本节点统一交付协议",
    "在工作区内完成任务。可以直接写正式产物，也可以起草、检查和修改；步骤自行决定，不要求草稿、检查或修改轮数。草稿满意后可以直接作为正式产物交付。",
    "产物写入文件；最后一条聊天回复不作为作品。输入资料只读，临时文件可自行组织。rp_files 可列举文件或统计字数；统计仅供参考，不是达标要求。",
    "完成一项产物后调用 rp_deliver({output:产物标识,path:实际相对路径})。实际路径可以不同于预定路径，工具会复制到预定位置。目录交付包含目录内全部文件，不要混入输入或无关草稿。",
    "只有交付工具成功回执才表示形式检查通过，不代表内容质量正确。失败时修改现有文件并重新交付；更新已经交付的版本也要重新交付。可以分次交付不同产物。",
    "所有必需产物交付成功且任务完成后，单独调用一次 rp_node_complete({})，不得与其他工具放在同一条消息中。收到交付回执后再决定结束，不需要额外结束语。",
    "正式产物清单：",
    ...Object.entries(contract.outputs).map(([id, output]) => `- ${id}: ${output.kind || "file"}; ${output.format || "text"}; 预定路径 ${output.path}; ${output.required === false ? "可选" : "必需"}${output.requiredFiles?.length ? `; 必需子文件 ${output.requiredFiles.join(", ")}` : ""}${output.jsonSchema ? `; JSON结构 ${JSON.stringify(output.jsonSchema)}` : ""}`),
    "JSON 文件必须是完整可解析的 JSON，不包含代码围栏或解释文字。",
  ].join("\n");
}

export async function createAgentDelivery({ workspace, node, agent, inputPaths = [], beforeComplete = async () => {} }) {
  const contract = agentDeliveryContract(node, agent);
  const protectedPaths = [...DEFAULT_INPUTS, ...inputPaths].filter(Boolean).map(canonical);
  const generatedPaths = Object.entries(node.outputs || {}).filter(([id]) => !(id in contract.outputs)).map(([, value]) => canonical(value.path));
  const receipts = new Map();
  let completed = false;
  const attempt = randomUUID();
  const privateRoot = (await workspacePath(workspace, `${INTERNAL}/${attempt}`, { internal: true })).path;
  await mkdir(privateRoot, { recursive: true });

  const access = async (requested, write = false, allowRoot = false) => {
    if (completed) throw failure("node_already_completed", "This node has already completed.");
    const target = await workspacePath(workspace, requested, { root: allowRoot });
    if (write && [...protectedPaths, ...generatedPaths].some(path => overlaps(key(target.relative), path))) throw failure("workspace_input_readonly", "Input documents and runtime-generated outputs are read-only.");
    return target;
  };
  for (const output of Object.values(contract.outputs)) await access(output.path, true);
  const protect = async requested => {
    const target = await workspacePath(workspace, requested);
    protectedPaths.push(key(target.relative));
  };
  const assertCallOutputPath = async requested => {
    const target = await access(requested, true);
    if (Object.values(node.outputs || {}).some(output => overlaps(key(target.relative), canonical(output.path)))) {
      throw failure("delivery_path_overlap", "A workflow call output cannot overlap this node's formal deliveries.");
    }
    return target;
  };

  async function validate(path, definition) {
    const info = await lstat(path);
    if (definition.kind === "directory" ? !info.isDirectory() : !info.isFile()) throw failure("delivery_wrong_kind", `Expected ${definition.kind || "file"}.`);
    const files = await inventory(path);
    if (!files.length || files.every(file => !file.bytes)) throw failure("delivery_empty", "The delivered artifact is empty.");
    const required = [...(definition.requiredFiles || []), ...(definition.format === "document-set" ? ["DOCUMENTS.md"] : []), ...(definition.format === "story-candidate-draft" ? ["story.md", "metadata.json"] : [])];
    for (const name of required) if (!files.some(file => file.path === name && file.bytes)) throw failure("delivery_missing_file", `Required directory file is missing or empty: ${name}`);
    for (const file of files) {
      const textFormat = definition.kind !== "directory" && ["text", "markdown", "narrative", "json"].includes(definition.format);
      const textExtension = /\.(?:json|md|markdown|txt|html|css|js|mjs|ts|yaml|yml|xml|csv)$/i.test(file.path);
      if (textFormat || textExtension) {
        try { new TextDecoder("utf-8", { fatal: true }).decode(file.content); }
        catch { throw failure("delivery_invalid_text", `${file.path}: text file must use valid UTF-8.`); }
      }
      if ((definition.kind !== "directory" && definition.format === "json") || file.path.toLowerCase().endsWith(".json")) {
        const value = strictJson(file.content.toString("utf8"), file.path);
        if (definition.kind !== "directory" && definition.jsonSchema) {
          const errors = validateJsonSchema(value, definition.jsonSchema, "");
          if (errors.length) throw failure("delivery_invalid_structure", errors.slice(0, 10).map(error => `${error.path || "/"}: ${error.message}`).join("\n"));
        }
      }
    }
    return files;
  }

  async function deliver({ output: id, path: requested }) {
    const definition = contract.outputs[id];
    if (!definition) throw failure("delivery_unknown_output", `Unknown Agent output: ${id}`);
    const source = await access(requested);
    if (protectedPaths.some(path => overlaps(key(source.relative), path))) throw failure("workspace_input_readonly", "Submit your working artifact, not an input document or a directory containing inputs.");
    const destination = await access(definition.path, true);
    if (source.relative !== destination.relative && overlaps(key(source.relative), key(destination.relative))) throw failure("delivery_path_overlap", "Source and destination directories cannot contain each other.");
    const files = await validate(source.path, definition);
    const version = randomUUID();
    const staging = resolve(privateRoot, `${version}-stage`);
    const backup = resolve(privateRoot, `${version}-backup`);
    if (definition.kind === "directory") await mkdir(staging);
    for (const file of files) {
      const target = definition.kind === "directory" ? resolve(staging, file.path) : staging;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    await mkdir(dirname(destination.path), { recursive: true });
    // Recheck destination ancestors immediately before replacing anything.
    await access(definition.path, true);
    let backedUp = false;
    try {
      await rename(destination.path, backup).then(() => { backedUp = true; }, error => { if (error.code !== "ENOENT") throw error; });
      await rename(staging, destination.path);
    } catch (error) {
      if (backedUp) await rename(backup, destination.path);
      throw error;
    }
    const receipt = { output: id, path: definition.path, kind: definition.kind || "file", version, digest: digest(files), files: manifest(files), checks: ["exists", "kind", "format"], acceptedAt: new Date().toISOString() };
    receipts.set(id, receipt);
    // Receipt stays authoritative in memory; best-effort cleanup cannot undo a successful commit.
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    await writeFile(resolve(privateRoot, "receipts.json"), JSON.stringify([...receipts.values()], null, 2)).catch(() => {});
    return { ok: true, ...receipt, message: "交付成功，仅表示形式检查通过。需要更新内容时请重新交付。" };
  }

  async function check() {
    const problems = [];
    for (const [id, definition] of Object.entries(contract.outputs)) {
      const receipt = receipts.get(id);
      if (!receipt) { if (definition.required !== false) problems.push(`${id}: 尚未成功交付`); continue; }
      try {
        const target = await workspacePath(workspace, definition.path);
        const files = await validate(target.path, definition);
        if (digest(files) !== receipt.digest) problems.push(`${id}: 交付后内容发生变化，请重新交付`);
      } catch (error) { problems.push(`${id}: ${error.message}`); }
    }
    return problems;
  }

  async function complete() {
    if (completed) throw failure("node_already_completed", "Node completion has already been accepted.");
    const problems = await check();
    if (problems.length) throw failure("delivery_incomplete", problems.join("\n"));
    await beforeComplete();
    completed = true;
    return { ok: true, completed: true, outputs: [...receipts.values()] };
  }

  async function result() {
    if (!completed) throw failure("delivery_incomplete", "Node has not explicitly completed.");
    const problems = await check();
    if (problems.length) throw failure("delivery_changed", problems.join("\n"));
    if (!contract.primary) return { outputs: Object.fromEntries([...receipts].map(([id, receipt]) => [id, receipt.path])) };
    const definition = contract.outputs[contract.primary];
    if (!receipts.has(contract.primary)) throw failure("delivery_incomplete", "Primary output was not delivered.");
    const content = await readFile((await workspacePath(workspace, definition.path)).path, "utf8");
    return definition.format === "json" ? strictJson(content, definition.path) : content;
  }
  return { contract, access, protect, assertCallOutputPath, deliver, check, complete, result, get completed() { return completed; }, get receipts() { return [...receipts.values()]; } };
}

export async function runAgentDeliverySession({ session, prompt, delivery }) {
  let next = prompt;
  for (let round = 0; round <= delivery.contract.maxReminders; round++) {
    await session.prompt(next, { expandPromptTemplates: false, source: "extension" });
    if (delivery.completed) return;
    const last = [...session.messages].reverse().find(message => message.role === "assistant");
    if (["error", "aborted"].includes(last?.stopReason)) throw noTextOutputError({ message: last, label: "Workflow Agent" });
    const problems = await delivery.check();
    next = ["节点尚未结束。请沿用当前文件继续工作，不必重写已完成内容。", ...problems, problems.length ? "请完成交付后，再单独调用 rp_node_complete。" : "产物已交付，请单独调用 rp_node_complete 结束节点。"].join("\n");
  }
  throw failure("agent_delivery_not_completed", `Agent did not complete explicit delivery and node completion after ${delivery.contract.maxReminders} reminders.`);
}
