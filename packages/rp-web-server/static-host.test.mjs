import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createStaticHost } from "./static-host.mjs";
test("static host handles build chunks and media MIME without exposing sibling/hidden files", async t => {
  const directory = await mkdtemp(resolve(tmpdir(), "rp-static-")), root = resolve(directory, "public"); await mkdir(resolve(root, "chunks"), { recursive: true });
  await writeFile(resolve(root, "chunks/main.mjs"), "export const value=1;"); await writeFile(resolve(root, "font.woff2"), "font"); await writeFile(resolve(root, "music.mp3"), "audio"); await writeFile(resolve(directory, "secret.txt"), "secret");
  const host = createStaticHost({ root }); const server = createServer(async (req, res) => { if (!await host(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [file, mime] of [["chunks/main.mjs", "text/javascript"], ["font.woff2", "font/woff2"], ["music.mp3", "audio/mpeg"]]) { const response = await fetch(`${origin}/${file}`); assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), new RegExp(mime)); }
  for (const file of ["%2e%2e%2fsecret.txt", "%2eprivate", "missing.js", "chunks/%5c..%5csecret.txt"]) assert.equal((await fetch(`${origin}/${file}`)).status, 404);
});
