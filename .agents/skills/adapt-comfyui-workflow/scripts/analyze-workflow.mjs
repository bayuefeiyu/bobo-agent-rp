#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function usage() {
  console.error("Usage: node analyze-workflow.mjs <workflow.api.json>");
  process.exitCode = 2;
}

const path = process.argv[2];
if (!path) usage();
else {
  try {
    const workflow = JSON.parse(await readFile(path, "utf8"));
    if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) throw new Error("Workflow root must be an API-format node object.");
    const nodes = [];
    const customNodes = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
        throw new Error(`Node ${nodeId} is not a ComfyUI API-format node.`);
      }
      const inputs = Object.keys(node.inputs);
      const type = node.class_type;
      const candidates = [];
      let seedLimit = null;
      for (const input of inputs) {
        if (/^(text|prompt|positive)$/i.test(input)) candidates.push({ role: "prompt", input });
        if (/negative/i.test(input)) candidates.push({ role: "negative", input });
        if (/^(seed|noise_seed)$/i.test(input)) candidates.push({ role: "seed", input });
        if (/^(width|height|batch_size)$/i.test(input)) candidates.push({ role: "dimension", input });
        if (/filename.*prefix|prefix.*filename/i.test(input)) candidates.push({ role: "filenamePrefix", input });
        if (/lora|strength_model|strength_clip/i.test(input)) candidates.push({ role: "lora", input });
        if (/ckpt|unet_name|model_name|vae_name|clip_name/i.test(input)) candidates.push({ role: "loader", input });
        // A seed node sometimes carries its own ceiling as a sibling input. Reporting it here is what
        // lets the adaptation step write a verified `seedRange`. No static class-name table is kept:
        // a custom seed node's limit belongs to the installed node version, not to this parser, so a
        // null result means the limit must come from `/object_info` or the node's documented behaviour
        // — and the profile's `seedRange.source` must say which.
        if (/^(max|maximum)$/i.test(input) && Number.isSafeInteger(node.inputs[input]) && node.inputs[input] >= 0) seedLimit = node.inputs[input];
      }
      const output = /saveimage|previewimage|save.*image|image.*save/i.test(type);
      if (output) candidates.push({ role: "output", input: null });
      if (!/^(CLIPTextEncode|KSampler|KSamplerAdvanced|CheckpointLoaderSimple|UNETLoader|VAELoader|LoraLoader|EmptyLatentImage|SaveImage|PreviewImage|LoadImage)$/i.test(type)) customNodes.push({ nodeId, classType: type });
      nodes.push({ nodeId, classType: type, title: node._meta?.title || "", candidates, declaredSeedLimit: seedLimit });
    }
    console.log(JSON.stringify({ schemaVersion: 1, nodeCount: nodes.length, nodes: nodes.filter(item => item.candidates.length), customNodes }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
