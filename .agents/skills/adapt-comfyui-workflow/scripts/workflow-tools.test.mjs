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
  await writeFile(resolve(directory, "profile.json"), JSON.stringify({ schemaVersion: 1, id: "demo", title: "Demo", revision: "1", guideId: "demo", connectionId: "local", workflowFile: "workflow.api.json", bindings: { positive: [{ nodeId: "1", input: "missing" }], negative: [], seed: [], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] }, prompt: { separator: ", ", positivePrefix: "", positiveSuffix: "", negative: "" }, output: { nodeIds: ["2"] }, seedRange: { min: 0, max: 1125899906842624, source: "explicit" } }));
  await assert.rejects(execute(process.execPath, [resolve(scriptDirectory, "validate-profile.mjs"), directory]), error => /does not exist/.test(error.stderr));
});

// RC-07: the seed derived by the runtime exceeded the bound node's limit, so ComfyUI accepted the
// queue entry, skipped the save branch, and still reported success. The profile must state the range
// the bound node accepts, and the validator must refuse a range it cannot prove.
test("profile validator requires a declared, node-compatible seed range", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "comfy-profile-seed-"));
  const directory = resolve(root, "seed-demo");
  await mkdir(directory);
  await writeFile(resolve(directory, "workflow.api.json"), JSON.stringify({
    "1": { class_type: "CLIPTextEncode", inputs: { text: "" } },
    "2": { class_type: "SaveImage", inputs: { filename_prefix: "" } },
    "3": { class_type: "Seed (rgthree)", inputs: { seed: 0, max: 1125899906842624 } },
  }));
  const profile = {
    schemaVersion: 1, id: "seed-demo", title: "Seed demo", revision: "1", guideId: "seed-demo", connectionId: "local", workflowFile: "workflow.api.json",
    bindings: { positive: [{ nodeId: "1", input: "text" }], negative: [], seed: [{ nodeId: "3", input: "seed" }], filenamePrefix: [{ nodeId: "2", input: "filename_prefix" }] },
    prompt: { separator: ", ", positivePrefix: "", positiveSuffix: "", negative: "" },
    output: { nodeIds: ["2"] },
    seedRange: { min: 0, max: 1125899906842624, source: "Seed (rgthree) node 3" },
  };
  await writeFile(resolve(directory, "profile.json"), JSON.stringify(profile));
  const accepted = await execute(process.execPath, [resolve(scriptDirectory, "validate-profile.mjs"), directory]);
  assert.equal(JSON.parse(accepted.stdout).ok, true);

  const withoutRange = { ...profile };
  delete withoutRange.seedRange;
  await writeFile(resolve(directory, "profile.json"), JSON.stringify(withoutRange));
  await assert.rejects(execute(process.execPath, [resolve(scriptDirectory, "validate-profile.mjs"), directory]), error => /seedRange is required/.test(error.stderr));

  await writeFile(resolve(directory, "profile.json"), JSON.stringify({ ...profile, seedRange: { min: 0, max: 2 ** 53, source: "too large to represent exactly" } }));
  await assert.rejects(execute(process.execPath, [resolve(scriptDirectory, "validate-profile.mjs"), directory]), error => /safe integer/.test(error.stderr));

  await writeFile(resolve(directory, "profile.json"), JSON.stringify({ ...profile, seedRange: { min: 0, max: 2 ** 52 - 1, source: "legacy 13 hex digits" } }));
  await assert.rejects(execute(process.execPath, [resolve(scriptDirectory, "validate-profile.mjs"), directory]), error => /seedRange.max is/.test(error.stderr));
});
