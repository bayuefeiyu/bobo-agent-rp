#!/usr/bin/env node
import { resolve } from "node:path";
import { LibraryClient } from "./client.mjs";
import { createSemanticManager } from "./semantic-manager.mjs";
import { readFile } from "node:fs/promises";
import { RetrievalSession } from "./client.mjs";
const [command, root, ...args] = process.argv.slice(2);
const client = new LibraryClient();
let manager;
try {
  if (!root) throw new Error("Usage: cli.mjs import ROOT PACKAGE REVIEW | rebuild ROOT | search ROOT KEYWORDS | read ROOT ID | status ROOT | semantic-{config,test,status,build,cancel,resume,search} ROOT CONFIG_DIRECTORY [CONFIG_FILE|JOB_ID|QUERY|--force-encoding]");
  let result;
  if (command.startsWith("semantic-")) {
    if (!args[0]) throw new Error("Semantic commands require a private configuration directory as the first argument after ROOT.");
    manager = createSemanticManager({ configurationDirectory: resolve(args[0]), getRoot: () => resolve(root) });
    if (command === "semantic-config") { const config = JSON.parse(await readFile(resolve(args[1]), "utf8")); result = await manager.save({ config, ...(process.env.REFERENCE_EMBEDDING_KEY ? { embeddingKey: process.env.REFERENCE_EMBEDDING_KEY } : {}), ...(process.env.REFERENCE_RERANK_KEY ? { rerankKey: process.env.REFERENCE_RERANK_KEY } : {}) }); }
    else if (command === "semantic-test") result = await manager.test();
    else if (command === "semantic-status") result = await manager.status();
    else if (command === "semantic-cancel") result = await manager.cancel(args[1]);
    else if (["semantic-build", "semantic-resume"].includes(command)) { const job = await manager.start(command === "semantic-resume" ? { resumeJobId: args[1] } : { forceEncoding: args.includes("--force-encoding") }); process.stderr.write(`jobId: ${job.jobId}\n`); result = await manager.wait(job.jobId); if (result.status !== "completed") process.exitCode = 1; }
    else if (command === "semantic-search") { const snapshot = await manager.snapshot(); result = await manager.withClient(resolve(root), undefined, snapshot, async (c, _formal, info) => new RetrievalSession(c, undefined, { ...snapshot, info }).searchPassages({ text: args.slice(1).join(" ") })); }
    else throw new Error("Unknown semantic command.");
  }
  else if (command === "import") result = await client.publish(resolve(root), resolve(args[0]), resolve(args[1]));
  else if (command === "rebuild") result = await client.publish(resolve(root), null, null, { rebuild: true });
  else { const snapshot = await client.open(resolve(root)); if (command === "status") result = snapshot; else if (command === "search") result = await client.search({ text: args.join(" ") }); else if (command === "read") result = await client.read(args[0]); else throw new Error("Unknown command."); }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) { process.stderr.write(`${error.code ?? "error"}: ${error.message}\n`); process.exitCode = 1; }
finally { await manager?.close(); await client.close(); }
