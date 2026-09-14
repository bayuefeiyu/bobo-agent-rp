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

function cleanId(value, fieldName = "id") {
  const id = cleanText(value, fieldName, 200);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(id)) {
    const error = new Error(`${fieldName} is invalid.`);
    error.status = 400;
    throw error;
  }
  return id;
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
      if (request.method === "GET" && url.pathname === "/api/data-impact") {
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
      if (request.method === "GET" && url.pathname === "/api/image-generation") {
        return sendJson(response, 200, await bridge.getImageGeneration());
      }
      if (request.method === "PUT" && url.pathname === "/api/image-generation/preferences") {
        return sendJson(response, 200, await bridge.saveImagePreferences(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/image-generation/run") {
        return sendJson(response, 202, await bridge.startImageGeneration(await readJson(request)));
      }
      const imageRecoveryMatch = url.pathname.match(/^\/api\/image-generation\/requests\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/recover$/);
      if (request.method === "POST" && imageRecoveryMatch) {
        return sendJson(response, 202, await bridge.recoverImageGeneration(cleanId(imageRecoveryMatch[1], "requestId")));
      }
      if (request.method === "POST" && url.pathname === "/api/image-generation/connections") {
        return sendJson(response, 200, await bridge.saveComfyConnection(await readJson(request)));
      }
      const comfyTestMatch = url.pathname.match(/^\/api\/image-generation\/connections\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/test$/);
      if (request.method === "POST" && comfyTestMatch) {
        return sendJson(response, 200, await bridge.testComfyConnection(cleanId(comfyTestMatch[1], "connectionId")));
      }
      const profileOverrideMatch = url.pathname.match(/^\/api\/image-generation\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/override$/);
      if (request.method === "PUT" && profileOverrideMatch) {
        return sendJson(response, 200, await bridge.saveComfyProfileOverride(cleanId(profileOverrideMatch[1], "profileId"), await readJson(request)));
      }
      const profileOpenMatch = url.pathname.match(/^\/api\/image-generation\/profiles\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/open$/);
      if (request.method === "POST" && profileOpenMatch) {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.openComfyProfileDocument(cleanId(profileOpenMatch[1], "profileId"), body.target));
      }
      const renderImageMatch = url.pathname.match(/^\/api\/image-generation\/renders\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/images\/(\d+)$/);
      if (request.method === "GET" && renderImageMatch) {
        const image = await bridge.getComfyRenderImage(cleanId(renderImageMatch[1], "renderId"), Number(renderImageMatch[2]), url.searchParams.get("preview"));
        return sendCachedBinary(response, 200, image.body, image.mimeType);
      }
      const renderRegenerateMatch = url.pathname.match(/^\/api\/image-generation\/renders\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regenerate$/);
      if (request.method === "POST" && renderRegenerateMatch) {
        const body = await readJson(request);
        return sendJson(response, 202, await bridge.regenerateComfyRender(cleanId(renderRegenerateMatch[1], "renderId"), cleanText(body.contentPrompt, "contentPrompt", 20000), body.scope === "all" ? "all" : "current", cleanId(body.operationId, "operationId")));
      }
      const moduleDocumentMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/open$/);
      if (request.method === "POST" && moduleDocumentMatch) {
        const body = await readJson(request);
        return sendJson(response, 200, await bridge.openFeatureModuleDocument(
          cleanId(moduleDocumentMatch[1], "moduleId"),
          body.target,
        ));
      }
      const moduleRecordsMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/records$/);
      if (request.method === "GET" && moduleRecordsMatch) {
        const filters = {};
        for (const [key, value] of url.searchParams) if (key.startsWith("filter.")) filters[cleanId(key.slice(7), "filterId")] = value;
        return sendJson(response, 200, await bridge.queryModuleFrontendRegion(
          cleanId(moduleRecordsMatch[1], "moduleId"),
          cleanId(moduleRecordsMatch[2], "regionId"),
          { cursor: url.searchParams.get("cursor"), search: url.searchParams.get("search") || "", filters },
        ));
      }
      const moduleHistoryMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/records\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)\/history$/);
      if (request.method === "GET" && moduleHistoryMatch) {
        return sendJson(response, 200, await bridge.getModuleFrontendHistory(
          cleanId(moduleHistoryMatch[1], "moduleId"), cleanId(moduleHistoryMatch[2], "regionId"), cleanId(moduleHistoryMatch[3], "recordId"), url.searchParams.get("cursor"),
        ));
      }
      const moduleStoryMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/stories\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)$/);
      if (request.method === "GET" && moduleStoryMatch) {
        return sendJson(response, 200, await bridge.getModuleFrontendStory(cleanId(moduleStoryMatch[1], "moduleId"), cleanId(moduleStoryMatch[2], "regionId"), cleanId(moduleStoryMatch[3], "recordId")));
      }
      const moduleStorySourceMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/stories\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)\/open-source$/);
      if (request.method === "POST" && moduleStorySourceMatch) {
        return sendJson(response, 200, await bridge.openModuleAuthoritySource(cleanId(moduleStorySourceMatch[1], "moduleId"), cleanId(moduleStorySourceMatch[2], "regionId"), cleanId(moduleStorySourceMatch[3], "recordId")));
      }
      const moduleSettingsMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/settings$/);
      if (request.method === "GET" && moduleSettingsMatch) {
        return sendJson(response, 200, await bridge.getModuleFrontendSettings(cleanId(moduleSettingsMatch[1], "moduleId"), cleanId(moduleSettingsMatch[2], "regionId")));
      }
      if (request.method === "PUT" && moduleSettingsMatch) {
        return sendJson(response, 200, await bridge.updateModuleFrontendSettings(cleanId(moduleSettingsMatch[1], "moduleId"), cleanId(moduleSettingsMatch[2], "regionId"), await readJson(request)));
      }
      const moduleIntegrityMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/integrity$/);
      if (request.method === "GET" && moduleIntegrityMatch) {
        return sendJson(response, 200, await bridge.inspectModuleFrontendIntegrity(
          cleanId(moduleIntegrityMatch[1], "moduleId"), cleanId(moduleIntegrityMatch[2], "regionId"),
        ));
      }
      const moduleWorkflowMatch = url.pathname.match(/^\/api\/modules\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/regions\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/workflows\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/run$/);
      if (request.method === "POST" && moduleWorkflowMatch) {
        return sendJson(response, 202, await bridge.runModuleFrontendWorkflow(
          cleanId(moduleWorkflowMatch[1], "moduleId"), cleanId(moduleWorkflowMatch[2], "regionId"), cleanId(moduleWorkflowMatch[3], "workflowId"), await readJson(request),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/models") {
        return sendJson(response, 200, await bridge.listModels());
      }
      if (request.method === "POST" && url.pathname === "/api/models") {
        return sendJson(response, 200, await bridge.saveModel(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/models/discover") {
        return sendJson(response, 200, await bridge.discoverModels(await readJson(request)));
      }
      if (request.method === "POST" && url.pathname === "/api/models/test") {
        return sendJson(response, 200, await bridge.testModel(await readJson(request)));
      }
      const modelMatch = url.pathname.match(/^\/api\/models\/([a-zA-Z0-9][a-zA-Z0-9._:-]*)$/);
      if (request.method === "DELETE" && modelMatch) {
        return sendJson(response, 200, await bridge.deleteModel(cleanId(modelMatch[1], "modelId")));
      }
      if (request.method === "GET" && url.pathname === "/api/agents") {
        return sendJson(response, 200, await bridge.listAgents());
      }
      const agentMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/);
      if (request.method === "PUT" && agentMatch) {
        const body = await readJson(request);
        body.id = cleanId(agentMatch[1], "agentId");
        return sendJson(response, 200, await bridge.saveAgent(body, url.searchParams.get("scope") === "global" ? "global" : "card"));
      }
      const restoreAgentMatch = url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/restore$/);
      if (request.method === "POST" && restoreAgentMatch) {
        return sendJson(response, 200, await bridge.restoreAgent(cleanId(restoreAgentMatch[1], "agentId")));
      }
      if (request.method === "GET" && url.pathname === "/api/workflows") {
        return sendJson(response, 200, await bridge.listWorkflows());
      }
      if (request.method === "GET" && url.pathname === "/api/workflow-runs") {
        return sendJson(response, 200, await bridge.listWorkflowRuns());
      }
      const processRecordMatch = url.pathname.match(/^\/api\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/process-record\/open$/);
      if (request.method === "POST" && processRecordMatch) {
        return sendJson(response, 200, await bridge.openWorkflowNodeProcessRecord(
          cleanId(processRecordMatch[1], "runId"),
          cleanId(processRecordMatch[2], "nodeId"),
        ));
      }
      if (request.method === "GET" && url.pathname === "/api/workflow-policy") {
        return sendJson(response, 200, await bridge.getWorkflowPolicy());
      }
      if (request.method === "PUT" && url.pathname === "/api/workflow-policy") {
        return sendJson(response, 200, await bridge.saveWorkflowPolicy(await readJson(request)));
      }
      const activateWorkflowMatch = url.pathname.match(/^\/api\/workflows\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/activate$/);
      if (request.method === "POST" && activateWorkflowMatch) {
        return sendJson(response, 202, await bridge.activateWorkflow(cleanId(activateWorkflowMatch[1], "workflowId"), await readJson(request)));
      }
      const workflowBindingMatch = url.pathname.match(/^\/api\/workflows\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/binding$/);
      if (request.method === "PUT" && workflowBindingMatch) {
        return sendJson(response, 200, await bridge.updateWorkflowNodeBinding(
          cleanId(workflowBindingMatch[1], "workflowId"),
          cleanId(workflowBindingMatch[2], "nodeId"),
          await readJson(request),
        ));
      }
      const workflowTriggerMatch = url.pathname.match(/^\/api\/workflows\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/trigger$/);
      if (request.method === "PUT" && workflowTriggerMatch) {
        return sendJson(response, 200, await bridge.updateWorkflowTrigger(cleanId(workflowTriggerMatch[1], "workflowId"), await readJson(request)));
      }
      const retryRunMatch = url.pathname.match(/^\/api\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/retry$/);
      if (request.method === "POST" && retryRunMatch) {
        return sendJson(response, 202, await bridge.retryWorkflowNode(
          cleanId(retryRunMatch[1], "runId"),
          cleanId(retryRunMatch[2], "nodeId"),
          await readJson(request),
        ));
      }
      const recoverRunMatch = url.pathname.match(/^\/api\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/nodes\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/recover$/);
      if (request.method === "POST" && recoverRunMatch) {
        return sendJson(response, 202, await bridge.recoverWorkflowNode(
          cleanId(recoverRunMatch[1], "runId"),
          cleanId(recoverRunMatch[2], "nodeId"),
        ));
      }
      const cancelRunMatch = url.pathname.match(/^\/api\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/cancel$/);
      if (request.method === "POST" && cancelRunMatch) {
        return sendJson(response, 200, await bridge.cancelWorkflowRun(cleanId(cancelRunMatch[1], "runId")));
      }
      const skipRunMatch = url.pathname.match(/^\/api\/workflow-runs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)\/skip$/);
      if (request.method === "POST" && skipRunMatch) {
        return sendJson(response, 200, await bridge.skipWorkflowRun(cleanId(skipRunMatch[1], "runId")));
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
      if (request.method === "DELETE" && url.pathname === "/api/user-profile") {
        const playerName = cleanText(url.searchParams.get("playerName"), "playerName", 200);
        return sendJson(response, 200, await bridge.deleteUserProfile(playerName));
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
