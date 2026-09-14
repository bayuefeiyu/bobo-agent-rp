import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const scriptDirectory = resolve(fileURLToPath(import.meta.url), "..");

test("analyzer identifies prompt, seed, LoRA, and output candidates", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "comfy-analyze-"));
  const workflowPath = resolve(root, "workflow.json");
  await writeFile(workflowPath, JSON.stringify({
    "3": { class_type: "KSampler", inputs: { seed: 1 } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: "scene" } },
    "8": { class_type: "LoraLoader", inputs: { lora_name: "style.safetensors", strength_model: 1 } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI" } },
  }));
  const { stdout } = await execute(process.execPath, [resolve(scriptDirectory, "analyze-workflow.mjs"), workflowPath]);
  const report = JSON.parse(stdout);
  assert.equal(report.nodeCount, 4);
  assert.ok(report.nodes.some(node => node.candidates.some(item => item.role === "seed")));
  assert.ok(report.nodes.some(node => node.candidates.some(item => item.role === "output")));
});

test("profile validator rejects a binding absent from the API workflow", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "comfy-profile-"));
  const directory = resolve(root, "demo");
  await mkdir(directory);
  await writeFile(resolve(directory, "workflow.api.json"), JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: "" } }, "2": { class_type: "SaveImage", inputs: { filename_prefix: "" } } }));
  await writeFile(resolve(directory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "missing" }], negative: [], seed: [], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "", positiveSuffix: "", negative: "" }, output: { nodeIds: ["2"] } }));
  await assert.rejects(execute(process.execPath, [resolve(scriptDirectory, "validate-profile.mjs"), directory]), error => /does not exist/.test(error.stderr));
});
