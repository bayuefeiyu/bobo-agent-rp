import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function writeCollisionSafeFile(destination, content, label) {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { flag: "wx" }).catch(async error => {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(destination);
    const expected = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (!existing.equals(expected)) throw new Error(`Output path collision for ${label}.`);
  });
}

export async function copyWorkspaceEntry(sourcePath, destinationPath, label = "workspace entry") {
  const root = await lstat(sourcePath);
  if (root.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link.`);
  if (root.isFile()) {
    await writeCollisionSafeFile(destinationPath, await readFile(sourcePath), label);
    return { kind: "file", path: destinationPath };
  }
  if (!root.isDirectory()) throw new Error(`${label} must be a regular file or real directory.`);
  const visit = async (source, destination, relativeLabel) => {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`${label} cannot contain symbolic links.`);
      const sourcePath = resolve(source, entry.name);
      const destinationPath = resolve(destination, entry.name);
      const entryLabel = `${relativeLabel}/${entry.name}`;
      if (entry.isDirectory()) await visit(sourcePath, destinationPath, entryLabel);
      else if (entry.isFile()) await writeCollisionSafeFile(destinationPath, await readFile(sourcePath), entryLabel);
      else throw new Error(`${label} contains an unsupported filesystem entry.`);
    }
  };
  await visit(sourcePath, destinationPath, label);
  return { kind: "directory", path: destinationPath };
}

export async function copyDocumentSet(sourceDirectory, destinationDirectory, label = "document set") {
  const copied = await copyWorkspaceEntry(sourceDirectory, destinationDirectory, label);
  if (copied.kind !== "directory") throw new Error(`${label} must be a real directory.`);
  const indexPath = resolve(destinationDirectory, "DOCUMENTS.md");
  if (!(await lstat(indexPath).then(value => value.isFile()).catch(() => false))) throw new Error(`${label} must contain DOCUMENTS.md.`);
  return { directory: destinationDirectory, index: indexPath };
}
