import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";

export async function indexOperation(path, operation, input, { signal } = {}) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./worker.mjs", import.meta.url));
  try {
    return await new Promise((resolve,reject) => {
      const abort = () => reject(Object.assign(new Error("History operation cancelled."), { code: "cancelled" }));
      signal?.addEventListener("abort",abort,{ once:true });
      const cleanup = () => signal?.removeEventListener("abort",abort);
      worker.once("error",error => { cleanup(); reject(error); });
      worker.once("exit",code => { cleanup(); if (code !== 0) reject(Object.assign(new Error("History worker stopped."), { code: "history_index_unavailable" })); });
      worker.once("message",value => { cleanup(); if (value.error) reject(Object.assign(new Error(value.error.message), { code:value.error.code })); else resolve(value.result); });
      worker.postMessage({ id:randomUUID(),path,operation,input });
    });
  } finally { await worker.terminate(); }
}
export function recallCandidates(path,input,options) { return indexOperation(path,"search",input,options); }
