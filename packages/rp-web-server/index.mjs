import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { RpWebError, API_VERSION, HOST_VERSION, normalizeReadContext } from "../rp-web-contract/index.mjs";
import { createStaticHost } from "./static-host.mjs";
import { normalizeFrontendManifest } from "../rp-web-contract/frontend.mjs";
import { operations, matchOperation, validateOperationRequest, validateOperationResponse } from "../rp-web-contract/operations.mjs";

import { createCardStore } from "./card-store.mjs";

function publicError(error) {
  const outcomeUnknown = error.code === "commit_outcome_unknown";
  const status = outcomeUnknown ? 409 : Number.isInteger(error.status) ? error.status : 500;
  const disclose = error instanceof RpWebError || status < 500;
  const code = outcomeUnknown ? "operation_outcome_unknown" : disclose && error.code || ({ 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "invalid_state", 413: "request_too_large" })[status] || "internal_error";
  return { status, payload: { error: { code, message: disclose ? error.message : "Internal server error.", details: disclose ? error.details || null : null, retryable: disclose && error.retryable === true } } };
}


function sendJson(response, status, payload) {
  if (status < 400 && payload?.nextCursor && response.rpCursor) payload = { ...payload, nextCursor: response.rpCursor(payload.nextCursor) };
  if (status < 400) validateOperationResponse(response.rpOperation, payload);
  const requestId = response.getHeader("x-request-id");
  const body = JSON.stringify(status < 400 ? { data: payload, requestId, readContext: response.rpReadContext?.() || null } : { error: typeof payload.error === "object" ? payload.error : { code: status === 404 ? "not_found" : status === 405 ? "method_not_allowed" : "invalid_request", message: payload.error, retryable: false, details: null }, requestId });
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

function sendCachedBinary(response, status, body, mimeType) {
  response.writeHead(status, {
    "content-type": mimeType,
    "content-length": body.length,
    "cache-control": "private, max-age=300",
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
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    validateOperationRequest(request.rpOperation, payload);
    return payload;
  } catch (cause) {
    if (cause instanceof RpWebError) throw cause;
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

function cleanId(value, fieldName = "id") {
  const id = cleanText(value, fieldName, 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) {
    const error = new Error(`${fieldName} is invalid.`);
    error.status = 400;
    throw error;
  }
  return id;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function cleanComponentReference(value, fieldName = "component reference") {
  let reference;
  try {
    reference = decodeURIComponent(cleanText(value, fieldName, 400));
  } catch (error) {
    if (error?.status === 400) throw error;
    const invalid = new Error(`${fieldName} is invalid.`);
    invalid.status = 400;
    throw invalid;
  }
  const parts = reference.split("/");
  if (parts.length !== 2 || parts.some(part => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
    const error = new Error(`${fieldName} must use module-id/component-id.`);
    error.status = 400;
    throw error;
  }
  return reference;
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

export function createApplication({ cardStore, bridge: services, staticHost = null, identity = () => ({ cardId: null, chatId: null }), mode = "play", unavailable = [], frontend = null }) {
  const serverInstanceId = randomUUID();
  const cursorSecret = randomBytes(32);
  const disabled = new Set(unavailable);
  const supports = operation => (operation.id !== "frontend" || frontend !== null) && !disabled.has(operation.service) && (!operation.service || typeof services[operation.service] === "function") && (!operation.configAuth || typeof services.authorizeConfigMutation === "function");
  const bridge = new Proxy(services, { get(target, key) {
    if (typeof target[key] === "function" && !disabled.has(key)) return target[key].bind(target);
    return () => { throw new RpWebError("unsupported_capability", "This service does not support the requested capability.", { details: { capability: key } }); };
  } });
  const describe = () => ({ apiVersion: API_VERSION, hostVersion: HOST_VERSION, serverInstanceId, mode, readContext: { serverInstanceId, ...identity(), executionId: null }, capabilities: operations.filter(supports).map(item => item.id), resources: { apiRoot: "/api/v1" }, authentication: { configHeader: "x-rp-config-token", connection: "same-origin" } });
  const handler = async function handle(request, response) {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/v1/connection") return sendJson(response, 200, describe());
      if (request.method === "GET" && url.pathname === "/api/v1/frontend") {
        if (!frontend) throw new RpWebError("unsupported_capability", "Presentation packages are unavailable in this mode.");
        const manifest = normalizeFrontendManifest(frontend);
        const assetRoot = manifest.kind === "builtin" ? `/${manifest.root.slice("public/".length)}/` : `/${manifest.root}/`;
        return sendJson(response, 200, { manifest, assetRoot, entryUrl: `${assetRoot}${manifest.entry}` });
      }

      if (request.method === "GET" && url.pathname === "/api/v1/card") {
        return sendJson(response, 200, await cardStore.getPublicCard());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/state") {
        return sendJson(response, 200, await bridge.getState());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/narrative-attempts") return sendJson(response, 200, await bridge.listNarrativeAttempts());
      if (request.method === "POST" && url.pathname === "/api/v1/narrative-attempts/regenerate") {
        const body = await readJson(request);
        if (body.executionId) cleanId(body.executionId, "executionId");
        return sendJson(response, 202, await bridge.regenerateNarrative(body));
      }
      const narrativeAttemptMatch = url.pathname.match(/^\/api\/v1\/narrative-attempts\/([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\/(adopt|history))?$/);
      if (request.method === "GET" && narrativeAttemptMatch?.[2] === "history") {
        const options = {};
        for (const key of ["limit", "beforeRevision", "revision"]) if (url.searchParams.has(key)) options[key] = cleanSequence(url.searchParams.get(key));
        return sendJson(response, 200, await bridge.getNarrativeAttemptHistory(narrativeAttemptMatch[1], options));
      }
      if (request.method === "POST" && narrativeAttemptMatch?.[2] === "adopt") {
        const body = await readJson(request);
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw httpError(400, "A selection revision is required.");
        return sendJson(response, 200, await bridge.adoptNarrativeAttempt(cleanId(narrativeAttemptMatch[1], "attemptId"), body));
      }
      if (request.method === "PUT" && narrativeAttemptMatch && !narrativeAttemptMatch[2]) {
        const body = await readJson(request);
        if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000 || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 || typeof body.operationId !== "string" || !body.operationId.trim()) throw httpError(400, "Invalid narrative revision.");
        return sendJson(response, 200, await bridge.reviseNarrativeAttempt(cleanId(narrativeAttemptMatch[1], "attemptId"), body));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/transcript") {
        const options = {};
        for (const key of ["fromTurn", "toTurn", "beforeSequence", "limit", "cursor"]) if (url.searchParams.has(key)) options[key] = cleanSequence(url.searchParams.get(key));
        return sendJson(response, 200, await bridge.getTranscript(options));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/sessions") {
        return sendJson(response, 200, await bridge.listSessions());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/cards") {
        return sendJson(response, 200, await bridge.listCards());
      }
      const coverMatch = url.pathname.match(/^\/api\/v1\/cards\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/cover$/);
      if (request.method === "GET" && coverMatch) {
        const cover = await bridge.getCardCover(coverMatch[1]);
        return sendBinary(response, 200, cover.body, cover.mimeType);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/settings") {
        return sendJson(response, 200, await bridge.getSettings());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/config/context") return sendJson(response, 200, await bridge.getConfigContext());
      if (request.method === "GET" && url.pathname === "/api/v1/config/catalog") return sendJson(response, 200, await bridge.getConfigCatalog());
      if (request.method === "GET" && url.pathname === "/api/v1/config/reference-library") return sendJson(response, 200, await bridge.getReferenceLibrary());
      if(request.method==="POST"&&url.pathname==="/api/v1/config/reference-library/directories"){
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response,200,await bridge.browseReferenceDirectories(await readJson(request)));
      }
      const historyServiceMatch = url.pathname.match(/^\/api\/v1\/config\/narrative-history\/(config|status|test)$/);
      if (historyServiceMatch) {
        const route = historyServiceMatch[1];
        if (request.method === "GET" && ["config", "status"].includes(route)) return sendJson(response, 200, await bridge.historyServiceManagement(route === "config" ? "settings" : "status", {}));
        const operation = request.method === "PUT" && route === "config" ? "save" : request.method === "POST" && route === "test" ? "test" : null;
        if (!operation) return sendJson(response, 405, { error: "Method not allowed." });
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.historyServiceManagement(operation, await readJson(request)));
      }
      const semanticMatch = url.pathname.match(/^\/api\/v1\/config\/reference-library\/semantic\/(config|status|test|query|jobs|jobs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/(cancel|resume))$/);
      if (semanticMatch) {
        const route = semanticMatch[1];
        if (request.method === "GET" && ["config", "status"].includes(route)) return sendJson(response, 200, await bridge.referenceSemanticManagement(route === "config" ? "settings" : "status", {}));
        const operation = request.method === "PUT" && route === "config" ? "save" : request.method === "POST" && route === "jobs" ? "start" : request.method === "POST" && ["test", "query"].includes(route) ? route : request.method === "POST" && semanticMatch[3] ? semanticMatch[3] : null;
        if (!operation) return sendJson(response, 405, { error: "Method not allowed." });
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        const body = await readJson(request); return sendJson(response, 200, await bridge.referenceSemanticManagement(operation, semanticMatch[2] ? { ...body, jobId: semanticMatch[2] } : body));
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/config/reference-library") {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.saveReferenceLibrary(await readJson(request)));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/config/profiles") return sendJson(response, 200, await bridge.listConfigProfiles());
      if (request.method === "POST" && url.pathname === "/api/v1/config/profiles") {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 201, await bridge.createConfigProfile(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/config/import") {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 201, await bridge.importConfigProfile(await readJson(request)));
      }
      const configExportMatch = url.pathname.match(/^\/api\/v1\/config\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/export$/);
      if (request.method === "GET" && configExportMatch) return sendJson(response, 200, await bridge.exportConfigProfile(cleanSessionId(configExportMatch[1])));
      const configRenameMatch = url.pathname.match(/^\/api\/v1\/config\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/rename$/);
      if (request.method === "POST" && configRenameMatch) {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.renameConfigProfile(cleanSessionId(configRenameMatch[1]), await readJson(request)));
      }
      const configDuplicateMatch = url.pathname.match(/^\/api\/v1\/config\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/duplicate$/);
      if (request.method === "POST" && configDuplicateMatch) {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 201, await bridge.duplicateConfigProfile(cleanSessionId(configDuplicateMatch[1]), await readJson(request)));
      }
      const configActivateMatch = url.pathname.match(/^\/api\/v1\/config\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/activate$/);
      if (request.method === "POST" && configActivateMatch) {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.activateConfigProfile(cleanSessionId(configActivateMatch[1])));
      }
      const configSecretMatch = url.pathname.match(/^\/api\/v1\/config\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/secrets\/models\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "PUT" && configSecretMatch) {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.saveConfigModelSecret(cleanSessionId(configSecretMatch[1]), cleanSessionId(configSecretMatch[2]), await readJson(request)));
      }
      const configProfileMatch = url.pathname.match(/^\/api\/v1\/config\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "GET" && configProfileMatch) return sendJson(response, 200, await bridge.getConfigProfile(cleanSessionId(configProfileMatch[1])));
      if (request.method === "PUT" && configProfileMatch) {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.saveConfigProfile(await readJson(request)));
      }
      if (request.method === "DELETE" && configProfileMatch) {
        await bridge.authorizeConfigMutation(request.headers["x-rp-config-token"]);
        return sendJson(response, 200, await bridge.deleteConfigProfile(cleanSessionId(configProfileMatch[1])));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/modules") {
        return sendJson(response, 200, await bridge.listFeatureModules());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/data-impact") {
        const revisionText = url.searchParams.get("revision");
        const revision = revisionText === null ? null : Number(revisionText);
        if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) {
          const error = new Error("revision must be a positive integer.");
          error.status = 400;
          throw error;
        }
        const moduleId = url.searchParams.get("moduleId");
        return sendJson(response, 200, await bridge.inspectDataImpact(
          cleanId(url.searchParams.get("messageId"), "messageId"),
          revision,
          moduleId === null ? null : cleanId(moduleId, "moduleId"),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/image-generation") {
        return sendJson(response, 200, await bridge.getImageGeneration());
      }
      if (request.method === "PUT" && url.pathname === "/api/v1/image-generation/preferences") {
        return sendJson(response, 200, await bridge.saveImagePreferences(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/image-generation/run") {
        return sendJson(response, 202, await bridge.startImageGeneration(await readJson(request)));
      }
      const imageRecoveryMatch = url.pathname.match(/^\/api\/v1\/image-generation\/requests\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/recover$/);
      if (request.method === "POST" && imageRecoveryMatch) {
        return sendJson(response, 202, await bridge.recoverImageGeneration(cleanId(imageRecoveryMatch[1], "requestId")));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/image-generation/connections") {
        return sendJson(response, 200, await bridge.getComfyConnections());
      }
      if (request.method === "POST" && url.pathname === "/api/v1/image-generation/connections") {
        return sendJson(response, 200, await bridge.saveComfyConnection(await readJson(request)));
      }
      const comfyRemoveMatch = url.pathname.match(/^\/api\/v1\/image-generation\/connections\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "DELETE" && comfyRemoveMatch) {
        return sendJson(response, 200, await bridge.removeComfyConnection(cleanId(comfyRemoveMatch[1], "connectionId")));
      }
      const comfyTestMatch = url.pathname.match(/^\/api\/v1\/image-generation\/connections\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/test$/);
      if (request.method === "POST" && comfyTestMatch) {
        const draft=await readJson(request);
        return sendJson(response, 200, await bridge.testComfyConnection(cleanId(comfyTestMatch[1], "connectionId"),Object.keys(draft).length?draft:null));
      }
      const profileOverrideMatch = url.pathname.match(/^\/api\/v1\/image-generation\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/override$/);
      if (request.method === "PUT" && profileOverrideMatch) {
        return sendJson(response, 200, await bridge.saveComfyProfileOverride(cleanId(profileOverrideMatch[1], "profileId"), await readJson(request)));
      }
      const profileOpenMatch = url.pathname.match(/^\/api\/v1\/image-generation\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/open$/);
      if (request.method === "POST" && profileOpenMatch) {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.openComfyProfileDocument(cleanId(profileOpenMatch[1], "profileId"), body.target));
      }
      const renderImageMatch = url.pathname.match(/^\/api\/v1\/image-generation\/renders\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/images\/(\d+)$/);
      if (request.method === "GET" && renderImageMatch) {
        const image = await bridge.getComfyRenderImage(cleanId(renderImageMatch[1], "renderId"), Number(renderImageMatch[2]), url.searchParams.get("preview"));
        return sendCachedBinary(response, 200, image.body, image.mimeType);
      }
      const renderRegenerateMatch = url.pathname.match(/^\/api\/v1\/image-generation\/renders\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regenerate$/);
      if (request.method === "POST" && renderRegenerateMatch) {
        const body = await readJson(request);
        return sendJson(response, 202, await bridge.regenerateComfyRender(cleanId(renderRegenerateMatch[1], "renderId"), cleanText(body.contentPrompt, "contentPrompt", 20000), body.scope === "all" ? "all" : "current", cleanId(body.operationId, "operationId")));
      }
      const moduleDocumentMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/open$/);
      if (request.method === "POST" && moduleDocumentMatch) {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.openFeatureModuleDocument(
          cleanId(moduleDocumentMatch[1], "moduleId"),
          body.target,
        ));
      }
      const moduleRecordsMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/records$/);
      if (request.method === "GET" && moduleRecordsMatch) {
        const filters = {};
        for (const [key, value] of url.searchParams) if (key.startsWith("filter.")) filters[cleanId(key.slice(7), "filterId")] = value;
        return sendJson(response, 200, await bridge.queryModuleFrontendRegion(
          cleanId(moduleRecordsMatch[1], "moduleId"),
          cleanId(moduleRecordsMatch[2], "regionId"),
          { cursor: url.searchParams.get("cursor"), search: url.searchParams.get("search") || "", filters },
        ));
      }
      const moduleHistoryMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/records\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)\/history$/);
      if (request.method === "GET" && moduleHistoryMatch) {
        return sendJson(response, 200, await bridge.getModuleFrontendHistory(
          cleanId(moduleHistoryMatch[1], "moduleId"), cleanId(moduleHistoryMatch[2], "regionId"), cleanId(moduleHistoryMatch[3], "recordId"), url.searchParams.get("cursor"),
        ));
      }
      const moduleStoryMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/stories\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)$/);
      if (request.method === "GET" && moduleStoryMatch) {
        return sendJson(response, 200, await bridge.getModuleFrontendStory(cleanId(moduleStoryMatch[1], "moduleId"), cleanId(moduleStoryMatch[2], "regionId"), cleanId(moduleStoryMatch[3], "recordId")));
      }
      const moduleStorySourceMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/stories\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)\/open-source$/);
      if (request.method === "POST" && moduleStorySourceMatch) {
        return sendJson(response, 200, await bridge.openModuleAuthoritySource(cleanId(moduleStorySourceMatch[1], "moduleId"), cleanId(moduleStorySourceMatch[2], "regionId"), cleanId(moduleStorySourceMatch[3], "recordId")));
      }
      const moduleSettingsMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/settings$/);
      const moduleOperationMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/operations\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "GET" && moduleOperationMatch) return sendJson(response, 200, await bridge.getModuleFrontendOperation(cleanId(moduleOperationMatch[1]), cleanId(moduleOperationMatch[2]), cleanId(moduleOperationMatch[3])));
      if (request.method === "GET" && moduleSettingsMatch) {
        return sendJson(response, 200, await bridge.getModuleFrontendSettings(cleanId(moduleSettingsMatch[1], "moduleId"), cleanId(moduleSettingsMatch[2], "regionId")));
      }
      if (request.method === "PUT" && moduleSettingsMatch) {
        return sendJson(response, 200, await bridge.updateModuleFrontendSettings(cleanId(moduleSettingsMatch[1], "moduleId"), cleanId(moduleSettingsMatch[2], "regionId"), await readJson(request)));
      }
      const moduleIntegrityMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/integrity$/);
      if (request.method === "GET" && moduleIntegrityMatch) {
        return sendJson(response, 200, await bridge.inspectModuleFrontendIntegrity(
          cleanId(moduleIntegrityMatch[1], "moduleId"), cleanId(moduleIntegrityMatch[2], "regionId"),
        ));
      }
      const moduleWorkflowMatch = url.pathname.match(/^\/api\/v1\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/bindings\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/workflows\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/run$/);
      if (request.method === "POST" && moduleWorkflowMatch) {
        return sendJson(response, 202, await bridge.runModuleFrontendWorkflow(
          cleanId(moduleWorkflowMatch[1], "moduleId"), cleanId(moduleWorkflowMatch[2], "regionId"), cleanId(moduleWorkflowMatch[3], "workflowId"), await readJson(request),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/models") {
        return sendJson(response, 200, await bridge.listModels());
      }
      if (request.method === "POST" && url.pathname === "/api/v1/models/discover") {
        return sendJson(response, 200, await bridge.discoverModels(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/models/test") {
        return sendJson(response, 200, await bridge.testModel(await readJson(request)));
      }

      if (request.method === "GET" && url.pathname === "/api/v1/agents") {
        return sendJson(response, 200, await bridge.listAgents());
      }


      if (request.method === "GET" && url.pathname === "/api/v1/workflows") {
        return sendJson(response, 200, await bridge.listWorkflows());
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workflow-runs") {
        return sendJson(response, 200, await bridge.listWorkflowRuns());
      }
      const reexecuteMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/reexecute$/);
      if (request.method === "POST" && reexecuteMatch) {
        const body = await readJson(request);
        if (body.executionId) cleanId(body.executionId, "executionId");
        return sendJson(response, 202, await bridge.reexecuteWorkflow(cleanId(reexecuteMatch[1], "runId"), body));
      }
      const processRecordMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/process-record\/open$/);
      const processRecordReadMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/process-record$/);
      if (request.method === "GET" && processRecordReadMatch) {
        return sendJson(response, 200, await bridge.getWorkflowNodeProcessRecord(cleanId(processRecordReadMatch[1], "runId"), cleanId(processRecordReadMatch[2], "nodeId"), url.searchParams.get("callId") || undefined, url.searchParams.get("summaryOnly") === "1"));
      }
      if (request.method === "POST" && processRecordMatch) {
        return sendJson(response, 200, await bridge.openWorkflowNodeProcessRecord(
          cleanId(processRecordMatch[1], "runId"),
          cleanId(processRecordMatch[2], "nodeId"),
        ));
      }
      const teamTranscriptMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/team-transcript\/open$/);
      if (request.method === "POST" && teamTranscriptMatch) {
        return sendJson(response, 200, await bridge.openWorkflowTeamTranscript(
          cleanId(teamTranscriptMatch[1], "runId"),
          cleanId(teamTranscriptMatch[2], "nodeId"),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workflow-policy") {
        return sendJson(response, 200, await bridge.getWorkflowPolicy());
      }
      const activateWorkflowMatch = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)\/activate$/);
      if (request.method === "POST" && activateWorkflowMatch) {
        return sendJson(response, 202, await bridge.activateWorkflow(cleanComponentReference(activateWorkflowMatch[1], "workflowId"), await readJson(request)));
      }


      const retryRunMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/retry$/);
      if (request.method === "POST" && retryRunMatch) {
        return sendJson(response, 202, await bridge.retryWorkflowNode(
          cleanId(retryRunMatch[1], "runId"),
          cleanId(retryRunMatch[2], "nodeId"),
          await readJson(request),
        ));
      }
      const recoverRunMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/recover$/);
      if (request.method === "POST" && recoverRunMatch) {
        return sendJson(response, 202, await bridge.recoverWorkflowNode(
          cleanId(recoverRunMatch[1], "runId"),
          cleanId(recoverRunMatch[2], "nodeId"),
        ));
      }
      const cancelRunMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/cancel$/);
      if (request.method === "POST" && cancelRunMatch) {
        return sendJson(response, 200, await bridge.cancelWorkflowRun(cleanId(cancelRunMatch[1], "runId")));
      }
      const skipRunMatch = url.pathname.match(/^\/api\/v1\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/skip$/);
      if (request.method === "POST" && skipRunMatch) {
        return sendJson(response, 200, await bridge.skipWorkflowRun(cleanId(skipRunMatch[1], "runId")));
      }
      if (request.method === "GET" && url.pathname === "/api/v1/user-avatar") {
        const playerName = cleanText(url.searchParams.get("playerName"), "playerName", 200);
        const avatar = await bridge.getUserAvatar(playerName);
        return sendBinary(response, 200, avatar.body, avatar.mimeType);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/user-avatar") {
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
      if (request.method === "POST" && url.pathname === "/api/v1/opening") {
        const body = await readJson(request);
        const openingId = cleanText(body.openingId, "openingId", 200);
        const playerName = typeof body.playerName === "string" && body.playerName.trim()
          ? cleanText(body.playerName, "playerName", 200)
          : "玩家";
        const opening = await cardStore.getOpening(openingId, playerName);
        return sendJson(response, 201, await bridge.selectOpening(opening));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/input") {
        const body = await readJson(request);
        await bridge.submitInput(cleanText(body.content, "content"), body.operationId === undefined ? undefined : cleanText(body.operationId, "operationId", 200));
        return sendJson(response, 202, { accepted: true });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/user-settings") {
        const body = await readJson(request);
        const playerName = cleanText(body.playerName, "playerName", 200);
        const description = cleanOptionalText(body.description, "description");
        return sendJson(response, 200, await bridge.updateUserSettings({ playerName, description }));
      }
      if (request.method === "DELETE" && url.pathname === "/api/v1/user-profile") {
        const playerName = cleanText(url.searchParams.get("playerName"), "playerName", 200);
        return sendJson(response, 200, await bridge.deleteUserProfile(playerName));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/card-switch") {
        const body = await readJson(request);
        return sendJson(response, 202, await bridge.switchCard(cleanSessionId(body.cardId), body.forceNew === true));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/system-settings") {
        const body = await readJson(request);
        const fontSize = Number(body.fontSize);
        if (!Number.isInteger(fontSize) || fontSize < 14 || fontSize > 24) {
          const error = new Error("fontSize must be an integer from 14 to 24.");
          error.status = 400;
          throw error;
        }
        return sendJson(response, 200, await bridge.updateSystemSettings({ fontSize }));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/module-display-settings") {
        const body = await readJson(request);
        const order = cleanModuleIds(body.order, "order");
        const hidden = cleanModuleIds(body.hidden, "hidden");
        return sendJson(response, 200, await bridge.updateModuleDisplaySettings({ order, hidden }));
      }
      if (request.method === "POST" && url.pathname === "/api/v1/resume") {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.resumeSession(cleanSessionId(body.sessionId)));
      }
      const messageMatch = url.pathname.match(/^\/api\/v1\/messages\/(\d+)$/);
      const historyMatch = url.pathname.match(/^\/api\/v1\/messages\/(\d+)\/history$/);
      if (request.method === "GET" && historyMatch) {
        const options = {};
        for (const key of ["revision", "limit", "beforeRevision"]) if (url.searchParams.has(key)) options[key] = cleanSequence(url.searchParams.get(key));
        return sendJson(response, 200, await bridge.getMessageHistory(cleanSequence(historyMatch[1]), options));
      }
      if (request.method === "PUT" && messageMatch) {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.updateMessage(
          cleanSequence(messageMatch[1]),
          cleanText(body.content, "content"),
          body.expectedRevision === undefined ? undefined : cleanSequence(body.expectedRevision),
          body.operationId === undefined ? undefined : cleanText(body.operationId, "operationId", 200),
        ));
      }
      if (request.method === "DELETE" && messageMatch) {
        return sendJson(response, 200, await bridge.deleteMessage(cleanSequence(messageMatch[1])));
      }
      const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "DELETE" && sessionMatch) {
        return sendJson(response, 200, await bridge.deleteSession(cleanSessionId(sessionMatch[1])));
      }
      if (staticHost && await staticHost(request, response, url)) return;
      return sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const result = publicError(error);
      if (result.status >= 500 && !(error instanceof RpWebError)) console.error(error);
      return sendJson(response, result.status, result.payload);
    }
  };
  return async (request, response) => {
    response.setHeader("x-request-id", randomUUID());
    response.setHeader("x-rp-api-version", "1.0");
    try {
      const url = new URL(request.url, "http://localhost");
      const hostHeader = request.headers.host || "localhost";
      const hostname = new URL(`http://${hostHeader}`).hostname;
      if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) throw new RpWebError("forbidden", "Host is not allowed.");
      const origin = request.headers.origin;
      if (origin && new URL(origin).host !== hostHeader) throw new RpWebError("forbidden", "Cross-origin requests are not allowed.");
      const operation = matchOperation(request.method, url.pathname);
      request.rpOperation = response.rpOperation = operation;
      if (operation && !supports(operation)) throw new RpWebError("unsupported_capability", "This service does not support the requested capability.", { details: { capability: operation.id } });
      let context = null;
      if (url.searchParams.has("readContext")) {
        try { context = normalizeReadContext(JSON.parse(url.searchParams.get("readContext"))); }
        catch (error) { if (error instanceof RpWebError) throw error; throw new RpWebError("invalid_request", "Invalid readContext."); }
        const current = identity();
        if (context.serverInstanceId !== serverInstanceId || context.cardId !== current.cardId || context.chatId !== current.chatId) throw new RpWebError("session_changed", "The connection or chat has changed.");
      }
      response.rpReadContext = () => ({ serverInstanceId, ...identity(), executionId: ["GET", "HEAD"].includes(request.method) || request.method === "PUT" && url.pathname.startsWith("/api/v1/narrative-attempts/") ? context?.executionId || null : null });
      if (url.pathname.includes("/bindings/")) {
        const cursorScope = JSON.stringify({ path: url.pathname, context: context || { serverInstanceId, ...identity(), executionId: null } });
        const sign = value => createHmac("sha256", cursorSecret).update(value).digest("base64url");
        response.rpCursor = cursor => { const payload = Buffer.from(JSON.stringify({ scope: cursorScope, cursor })).toString("base64url"); return `${payload}.${sign(payload)}`; };
        if (url.searchParams.has("cursor")) {
          const [payload, signature, extra] = url.searchParams.get("cursor").split(".");
          const expected = sign(payload || "");
          if (!signature || extra || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new RpWebError("invalid_request", "Pagination cursor is invalid.");
          const saved = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
          if (saved.scope !== cursorScope) throw new RpWebError("session_changed", "Pagination cursor belongs to another read context.");
          url.searchParams.set("cursor", saved.cursor);
          request.url = `${url.pathname}${url.search}`;
        }
      }
      const command = !["GET", "HEAD"].includes(request.method) && url.pathname.startsWith("/api/v1/");
      if (command && !context) throw new RpWebError("invalid_request", "Commands require an explicit readContext.");
      if (command && context?.executionId && !/^\/api\/v1\/narrative-attempts\/[^/]+(?:\/adopt)?$/.test(url.pathname)) throw new RpWebError("preview_read_only", "Return to the adopted narrative before changing state.");
      if (typeof services.withRequest === "function") return await services.withRequest(context, () => handler(request, response));
      return await handler(request, response);
    } catch (error) {
      const result = publicError(error);
      return sendJson(response, result.status, result.payload);
    }
  };
}

export async function startWebBridge({ cardDirectory, bridge, host = "127.0.0.1", port = 0 }) {
  const cardStore = createCardStore(cardDirectory, bridge.renderCardText);
  await cardStore.validate();
  const frontend = normalizeFrontendManifest(JSON.parse(await readFile(resolve(cardDirectory, "web/frontend.json"), "utf8")));
  const staticHost = createStaticHost({ root: resolve(cardDirectory, "web", "public"), mounts: { "/frontends/": resolve(cardDirectory, "web/frontends"), "/vendor/rp-web-client/": resolve(cardDirectory, "runtime/packages/rp-web-client"), "/vendor/rp-web-contract/": resolve(cardDirectory, "runtime/packages/rp-web-contract") } });
  const server = createServer(createApplication({ cardStore, bridge, staticHost, identity: bridge.connectionIdentity, frontend }));
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    close: async () => {
      if (!server.listening) return;
      await new Promise((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(error) : resolveClose());
        server.closeAllConnections();
      });
    },
  };
}
