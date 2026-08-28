import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCardStore } from "./server/card-store.mjs";

const webDirectory = dirname(fileURLToPath(import.meta.url));

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendBinary(response, status, body, mimeType) {
  response.writeHead(status, {
    "content-type": mimeType,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256 * 1024) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

async function readBinary(request, maximumSize = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumSize) {
      const error = new Error("Image must be 5 MB or smaller.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    const error = new Error("Image body is empty.");
    error.status = 400;
    throw error;
  }
  return Buffer.concat(chunks);
}

function detectImageMimeType(body) {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 12 && body.toString("ascii", 0, 4) === "RIFF" && body.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function cleanText(value, fieldName, maximumLength = 100_000) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${fieldName} must be a non-empty string.`);
    error.status = 400;
    throw error;
  }
  const text = value.replaceAll("\r\n", "\n").trim();
  if (text.length > maximumLength) {
    const error = new Error(`${fieldName} is too long.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function cleanOptionalText(value, fieldName, maximumLength = 20_000) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") {
    const error = new Error(`${fieldName} must be a string.`);
    error.status = 400;
    throw error;
  }
  const text = value.replaceAll("\r\n", "\n").trim();
  if (text.length > maximumLength) {
    const error = new Error(`${fieldName} is too long.`);
    error.status = 400;
    throw error;
  }
  return text;
}

function cleanSessionId(value) {
  const sessionId = cleanText(value, "sessionId", 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(sessionId)) {
    const error = new Error("sessionId is invalid.");
    error.status = 400;
    throw error;
  }
  return sessionId;
}

function cleanSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    const error = new Error("Message sequence is invalid.");
    error.status = 400;
    throw error;
  }
  return sequence;
}

function cleanModuleIds(value, fieldName) {
  if (!Array.isArray(value) || value.length > 500) {
    const error = new Error(`${fieldName} must be an array with at most 500 module IDs.`);
    error.status = 400;
    throw error;
  }
  const ids = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(item) || ids.includes(item)) {
      const error = new Error(`${fieldName} contains an invalid or duplicate module ID.`);
      error.status = 400;
      throw error;
    }
    ids.push(item);
  }
  return ids;
}

function contentType(pathname) {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function safePublicPath(pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..")) return null;
  return join(webDirectory, "public", relative);
}

export function createApplication({ cardStore, bridge }) {
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");

      if (request.method === "GET" && url.pathname === "/api/card") {
        return sendJson(response, 200, await cardStore.getPublicCard());
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        return sendJson(response, 200, await bridge.getState());
      }
      if (request.method === "GET" && url.pathname === "/api/sessions") {
        return sendJson(response, 200, await bridge.listSessions());
      }
      if (request.method === "GET" && url.pathname === "/api/cards") {
        return sendJson(response, 200, await bridge.listCards());
      }
      const coverMatch = url.pathname.match(/^\/api\/cards\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/cover$/);
      if (request.method === "GET" && coverMatch) {
        const cover = await bridge.getCardCover(coverMatch[1]);
        return sendBinary(response, 200, cover.body, cover.mimeType);
      }
      if (request.method === "GET" && url.pathname === "/api/settings") {
        return sendJson(response, 200, await bridge.getSettings());
      }
      if (request.method === "GET" && url.pathname === "/api/modules") {
        return sendJson(response, 200, await bridge.listFeatureModules());
      }
      if (request.method === "GET" && url.pathname === "/api/user-avatar") {
        const playerName = cleanText(url.searchParams.get("playerName"), "playerName", 200);
        const avatar = await bridge.getUserAvatar(playerName);
        return sendBinary(response, 200, avatar.body, avatar.mimeType);
      }
      if (request.method === "POST" && url.pathname === "/api/user-avatar") {
        const playerName = cleanText(url.searchParams.get("playerName"), "playerName", 200);
        const body = await readBinary(request);
        const mimeType = detectImageMimeType(body);
        if (!mimeType || request.headers["content-type"] !== mimeType) {
          const error = new Error("Avatar must be a valid PNG, JPEG, or WebP image.");
          error.status = 400;
          throw error;
        }
        return sendJson(response, 200, await bridge.updateUserAvatar({ playerName, mimeType, body }));
      }
      if (request.method === "POST" && url.pathname === "/api/opening") {
        const body = await readJson(request);
        const openingId = cleanText(body.openingId, "openingId", 200);
        const playerName = typeof body.playerName === "string" && body.playerName.trim()
          ? cleanText(body.playerName, "playerName", 200)
          : "玩家";
        const opening = await cardStore.getOpening(openingId, playerName);
        return sendJson(response, 201, await bridge.selectOpening(opening));
      }
      if (request.method === "POST" && url.pathname === "/api/input") {
        const body = await readJson(request);
        await bridge.submitInput(cleanText(body.content, "content"));
        return sendJson(response, 202, { accepted: true });
      }
      if (request.method === "POST" && url.pathname === "/api/user-settings") {
        const body = await readJson(request);
        const playerName = cleanText(body.playerName, "playerName", 200);
        const description = cleanOptionalText(body.description, "description");
        return sendJson(response, 200, await bridge.updateUserSettings({ playerName, description }));
      }
      if (request.method === "POST" && url.pathname === "/api/card-switch") {
        const body = await readJson(request);
        return sendJson(response, 202, await bridge.switchCard(cleanSessionId(body.cardId), body.forceNew === true));
      }
      if (request.method === "POST" && url.pathname === "/api/system-settings") {
        const body = await readJson(request);
        const fontSize = Number(body.fontSize);
        if (!Number.isInteger(fontSize) || fontSize < 14 || fontSize > 24) {
          const error = new Error("fontSize must be an integer from 14 to 24.");
          error.status = 400;
          throw error;
        }
        return sendJson(response, 200, await bridge.updateSystemSettings({ fontSize }));
      }
      if (request.method === "POST" && url.pathname === "/api/module-display-settings") {
        const body = await readJson(request);
        const order = cleanModuleIds(body.order, "order");
        const hidden = cleanModuleIds(body.hidden, "hidden");
        return sendJson(response, 200, await bridge.updateModuleDisplaySettings({ order, hidden }));
      }
      if (request.method === "POST" && url.pathname === "/api/resume") {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.resumeSession(cleanSessionId(body.sessionId)));
      }
      const messageMatch = url.pathname.match(/^\/api\/messages\/(\d+)$/);
      if (request.method === "PUT" && messageMatch) {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.updateMessage(
          cleanSequence(messageMatch[1]),
          cleanText(body.content, "content"),
        ));
      }
      if (request.method === "DELETE" && messageMatch) {
        return sendJson(response, 200, await bridge.deleteMessage(cleanSequence(messageMatch[1])));
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "DELETE" && sessionMatch) {
        return sendJson(response, 200, await bridge.deleteSession(cleanSessionId(sessionMatch[1])));
      }
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const path = safePublicPath(url.pathname);
        if (!path) return sendJson(response, 404, { error: "Not found." });
        try {
          const body = await readFile(path);
          response.writeHead(200, {
            "content-type": contentType(path),
            "content-length": body.length,
            "cache-control": "no-store",
          });
          return response.end(body);
        } catch (error) {
          if (error.code === "ENOENT") return sendJson(response, 404, { error: "Not found." });
          throw error;
        }
      }
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error(error);
      return sendJson(response, status, { error: status >= 500 ? "Internal server error." : error.message });
    }
  };
}

export async function startWebBridge({ cardDirectory, bridge, host = "127.0.0.1", port = 0 }) {
  const cardStore = createCardStore(cardDirectory);
  await cardStore.validate();
  const server = createServer(createApplication({ cardStore, bridge }));
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}
