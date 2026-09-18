import assert from "node:assert/strict";
import test from "node:test";

import { classifyNodeErrors, describeNodeError, executionErrors, outputLineage, unrelatedStatusMessages } from "./rp-comfyui-diagnostics.mjs";

/**
 * The failing real history is the fixture: `status_str: "success"`, no image outputs, and the only
 * clue in the ComfyUI log was that the seed exceeded the bound node's limit. Because the save branch
 * was skipped while an unrelated text node still ran, the history alone looked healthy — so the
 * runtime must read node errors and decide whether they are on the requested output's path.
 */
const workflow = {
  "508": { class_type: "StringFunction", inputs: { text_a: "" } },
  "720": { class_type: "Seed (rgthree)", inputs: { seed: 0 } },
  "736": { class_type: "KSampler", inputs: { seed: ["720", 0], positive: ["749", 0] } },
  "749": { class_type: "CLIPTextEncode", inputs: { text: ["508", 0] } },
  "702": { class_type: "SaveImage", inputs: { images: ["913", 0] } },
  "913": { class_type: "VAEDecode", inputs: { samples: ["736", 0] } },
  "999": { class_type: "Note", inputs: {} },
};

const seedErrorHistory = {
  status: {
    status_str: "success",
    completed: true,
    messages: [
      ["execution_start", { prompt_id: "p1" }],
      ["execution_error", { prompt_id: "p1", node_id: "720", node_type: "Seed (rgthree)", exception_type: "ValueError", exception_message: "seed exceeds maximum 1125899906842624" }],
      ["execution_success", { prompt_id: "p1" }],
    ],
  },
  outputs: { "508": { text: ["masterpiece..."] } },
};

test("an error on the output path explains a missing image", () => {
  const classified = classifyNodeErrors({ history: seedErrorHistory, workflow, targetNodeIds: ["702"] });
  assert.equal(classified.blocking.length, 1);
  assert.equal(classified.blocking[0].nodeId, "720");
  assert.match(describeNodeError(classified.blocking[0]), /node 720 \(Seed \(rgthree\)\): seed exceeds maximum/);
  assert.deepEqual(classified.unrelated, []);
});

test("an error off the output path is a warning, not the cause", () => {
  const history = {
    status: { status_str: "success", messages: [["execution_error", { node_id: "999", node_type: "Note", exception_message: "note failed to render" }]] },
    outputs: { "702": { images: [{ filename: "out.png", subfolder: "", type: "output" }] } },
  };
  const classified = classifyNodeErrors({ history, workflow, targetNodeIds: ["702"] });
  assert.deepEqual(classified.blocking, []);
  assert.equal(classified.unrelated.length, 1);
  assert.equal(classified.unrelated[0].nodeId, "999");
});

test("the lineage follows link references, including through intermediate nodes", () => {
  const lineage = outputLineage(workflow, ["702"]);
  for (const nodeId of ["702", "913", "736", "749", "720", "508"]) assert.equal(lineage.has(nodeId), true, nodeId);
  assert.equal(lineage.has("999"), false, "an unrelated branch is not part of the lineage");
});

test("status entries are normalized and unrelated entries are preserved for display", () => {
  const errors = executionErrors(seedErrorHistory);
  assert.deepEqual(errors, [{ nodeId: "720", nodeType: "Seed (rgthree)", message: "seed exceeds maximum 1125899906842624", details: "ValueError" }]);
  const other = {
    status: { status_str: "success", messages: [["execution_start", {}], ["execution_cached", { nodes: [] }], ["execution_success", {}], ["execution_interrupted", { node_id: "1" }]] },
    outputs: {},
  };
  assert.deepEqual(unrelatedStatusMessages(other), [{ type: "execution_interrupted", payload: { node_id: "1" } }]);
  assert.deepEqual(executionErrors({ status: { messages: [["execution_error", {}]] } }), [{ nodeId: null, nodeType: null, message: "ComfyUI node execution failed.", details: null }]);
});

test("a healthy history produces no findings", () => {
  const history = { status: { status_str: "success", messages: [["execution_success", {}]] }, outputs: { "702": { images: [{ filename: "a.png" }] } } };
  const classified = classifyNodeErrors({ history, workflow, targetNodeIds: ["702"] });
  assert.deepEqual(classified, { blocking: [], unrelated: [], other: [] });
});
