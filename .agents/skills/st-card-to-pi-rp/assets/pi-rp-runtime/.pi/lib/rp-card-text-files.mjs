import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { renderCardText } from "./rp-card-text.mjs";

export async function materializeAuthorSkill(sourceSkillPath, destination, playerName) {
  const sourceRoot = dirname(sourceSkillPath);
  const stagedSkillPath = resolve(destination, relative(sourceRoot, sourceSkillPath));
  const existing = await lstat(stagedSkillPath).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Staged skill is not a regular file: ${stagedSkillPath}`);
    return stagedSkillPath;
  }
  async function copyTree(source, target) {
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error(`Skill contains a symbolic link: ${source}`);
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true });
      for (const entry of await readdir(source)) await copyTree(resolve(source, entry), resolve(target, entry));
      return;
    }
    if (!info.isFile()) throw new Error(`Skill contains an unsupported entry: ${source}`);
    if (/\.(md|txt)$/i.test(source)) {
      await writeFile(target, renderCardText(await readFile(source, "utf8"), playerName, source), "utf8");
    } else {
      await writeFile(target, await readFile(source));
    }
  }
  await copyTree(sourceRoot, destination);
  return stagedSkillPath;
}
