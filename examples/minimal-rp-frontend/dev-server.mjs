import { createServer } from "node:http";
import { once } from "node:events";
import { createStaticHost } from "../../packages/rp-web-server/static-host.mjs";
const backend = new URL(process.argv[2]);
if (backend.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(backend.hostname)) throw new Error("Specify an explicit local backend URL.");
const staticHost = createStaticHost({ root: import.meta.dirname });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/vendor/") && !url.pathname.startsWith("/platform/") && await staticHost(request, response, url)) return;
    const target = new URL(url.pathname.replace(/^\/platform\//, "/") + url.search, backend);
    const headers = { ...request.headers, host: backend.host };
    if (headers.origin) {
      if (new URL(headers.origin).host !== request.headers.host) { response.writeHead(403); response.end(); return; }
      headers.origin = backend.origin;
    }
    const upstream = await fetch(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request, duplex: "half", redirect: "manual" });
    const outputHeaders = Object.fromEntries(upstream.headers); delete outputHeaders["transfer-encoding"]; delete outputHeaders["content-encoding"];
    const body = Buffer.from(await upstream.arrayBuffer()); outputHeaders["content-length"] = body.length;
    response.writeHead(upstream.status, outputHeaders); response.end(body);
  } catch (error) { response.writeHead(502); response.end(error.message); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
console.log(`Standalone frontend: http://127.0.0.1:${server.address().port}/`);
