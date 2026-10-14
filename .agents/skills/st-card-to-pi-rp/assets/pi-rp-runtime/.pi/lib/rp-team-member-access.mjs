import { workspacePath } from "./rp-agent-delivery.mjs";

const canonical = path => path.replaceAll("\\", "/").toLowerCase().replace(/\/$/, "");
const contains = (root, path) => path === root || path.startsWith(`${root}/`);
export async function collaborationMemberPath({ workspace, node, config, memberId, inputPaths, dynamicDocuments }, requested, write = false, allowRoot = false) {
  const target = await workspacePath(workspace, requested, { root: allowRoot });
  const path = canonical(target.relative);
  if (path === "team/shared/transcript.md" && !write) return target;
  if (contains("team", path) || contains(".call-snapshots", path)) throw new Error("Team state and operation records are runtime-private.");
  const own = canonical(`work/${memberId}`);
  const generated = node.metadata?.documentWorkspaceSnapshot?.output;
  const outputs = Object.entries(node.outputs || {}).filter(([id]) => id !== generated);
  if (write) {
    const owner = outputs.find(([, output]) => contains(canonical(output.path), path));
    if (outputs.some(([id, output]) => config.outputOwners[id] !== memberId && (contains(canonical(output.path), path) || contains(path, canonical(output.path))))) throw new Error("Another member exclusively owns this output.");
    if (!contains(own, path) && (!owner || config.outputOwners[owner[0]] !== memberId)) throw new Error("Write only your own work directory or an output you own.");
    const readonly = [...inputPaths, ...dynamicDocuments.map(document => document.path), ...Object.entries(node.outputs || {}).filter(([id]) => id === generated).map(([, output]) => output.path)];
    if (readonly.some(root => contains(canonical(root), path) || contains(path, canonical(root)))) throw new Error("Input and runtime-generated documents are read-only.");
  } else if (!(allowRoot && !path) && path !== "work" && !contains("work", path) && ![...inputPaths, ...dynamicDocuments.map(document => document.path), ...outputs.map(([, output]) => output.path), "WORKSPACE-DOCUMENTS.md", "CALL-INPUTS.md"].some(root => contains(canonical(root), path) || contains(path, canonical(root)))) {
    throw new Error("Read only authorized node inputs and team work documents.");
  }
  return target;
}
