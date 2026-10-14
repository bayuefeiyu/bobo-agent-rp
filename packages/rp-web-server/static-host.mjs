import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8",
});
export const contentType = pathname => MIME[extname(pathname).toLowerCase()] || "application/octet-stream";
const inside = (root, target) => {
  const relation = relative(root, target);
  return relation && !isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`);
};

/** Static hosting is optional and independently composed with the API service. */
export function createStaticHost({ root, entry = "index.html", mounts = {} }) {
  const locations = Object.entries(mounts).sort(([a], [b]) => b.length - a.length);
  return async (request, response, url = new URL(request.url, "http://localhost")) => {
    if (!["GET", "HEAD"].includes(request.method) || url.pathname.startsWith("/api/")) return false;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").some(part => part.startsWith("."))) return false;
    const mount = locations.find(([prefix]) => pathname.startsWith(prefix));
    const directory = resolve(mount ? mount[1] : root);
    const resource = mount ? pathname.slice(mount[0].length) : pathname === "/" ? entry : pathname.slice(1);
    const file = resolve(directory, resource);
    if (!inside(directory, file)) return false;
    try {
      const [realRoot, realFile] = await Promise.all([realpath(directory), realpath(file)]);
      if (!inside(realRoot, realFile) || !(await stat(realFile)).isFile()) return false;
      const body = await readFile(realFile);
      response.writeHead(200, { "content-type": contentType(file), "content-length": body.length, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : body);
      return true;
    } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  };
}
