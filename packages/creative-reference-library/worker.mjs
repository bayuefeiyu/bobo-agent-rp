import { parentPort } from "node:worker_threads";
import { publish, openSnapshot, SnapshotReader } from "./core.mjs";
import { SemanticReader } from "./semantic-index.mjs";
import { buildSemanticIndex } from "./semantic-build.mjs";
let reader;
let semantic;
parentPort.on("message", async ({ sequence, operation, arguments: args }) => {
  try {
    let result;
    if (operation === "publish") result = await publish(...args);
    else if (operation === "open") { semantic?.close(); semantic = null; reader?.close(); reader = new SnapshotReader(args[0], await openSnapshot(...args)); result = reader.snapshot; }
    else if (operation === "openSemantic") { if (!reader) throw new Error("Open a snapshot first."); semantic?.close(); semantic = await SemanticReader.create(args[0], reader.snapshot, args[1], args[2]); result = { generation: semantic.manifest.generation, count: semantic.manifest.count, dimensions: semantic.manifest.dimensions, vectorBytes: semantic.manifest.vectorBytes, coverage: semantic.coverage }; }
    else if (operation === "semanticSearch") { if (!semantic) throw new Error("Open a semantic snapshot first."); result = await semantic.search(...args); }
    else if (operation === "passage") { if (!semantic) throw new Error("Open a semantic snapshot first."); result = semantic.passage(...args); }
    else if (operation === "passageInfo") { if (!semantic) throw new Error("Open a semantic snapshot first."); result = semantic.inspect(...args); }
    else if (operation === "semanticBuild") result = await buildSemanticIndex(...args);
    else if (["search", "read", "inspect", "measureRanges", "readRanges"].includes(operation)) { if (!reader) throw new Error("Open a snapshot first."); result = reader[operation](...args); }
    else throw new Error("Unknown operation.");
    parentPort.postMessage({ sequence, result });
  } catch (error) { parentPort.postMessage({ sequence, error: { code: error.code ?? "library_failure", message: error.message } }); }
});
