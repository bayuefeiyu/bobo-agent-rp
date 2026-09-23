import { randomBytes, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRuntimePackage } from "./validate-runtime-package.mjs";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sourceDirectory = dirname(fileURLToPath(import.meta.url));

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function present(path) { return lstat(path).then(() => true, error => error.code === "ENOENT" ? false : Promise.reject(error)); }
function isInside(root, path) { const rel = relative(root, path); return Boolean(rel && rel !== ".." && !rel.startsWith(`..${sep}`)); }

export async function scanCards(playRoot) {
  const cardsRoot = resolve(playRoot, "cards");
  const entries = await readdir(cardsRoot, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
  const cards = [];
  for (const item of entries) {
    if (!item.isDirectory() || !safeId.test(item.name)) continue;
    const cardRoot = join(cardsRoot, item.name);
    try {
      const manifest = await json(join(cardRoot, "manifest.json"));
      if (manifest.schema_version !== 2 || manifest.id !== item.name || typeof manifest.name !== "string" || !manifest.name.trim()) continue;
      const launchable = await present(join(cardRoot, "runtime-lock.json")) && await present(join(cardRoot, "runtime", "launch.json"));
      let cover = null;
      if (typeof manifest.cover === "string" && /\.(png|jpe?g|webp)$/i.test(manifest.cover)) {
        const candidate = resolve(cardRoot, manifest.cover);
        if (isInside(cardRoot, candidate) && await present(candidate) && (await lstat(candidate)).isFile()) cover = manifest.cover;
      }
      cards.push({ id: item.name, name: manifest.name.trim(), description: typeof manifest.description === "string" ? manifest.description.slice(0, 400) : "", cover: Boolean(cover), launchable });
    } catch { /* One damaged card must not hide the other cards. */ }
  }
  return cards.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans"));
}

async function recentCards(path) {
  try {
    const document = await json(path);
    if (document.schemaVersion !== 1 || !Array.isArray(document.cards)) return [];
    const unique = new Map();
    for (const item of document.cards) {
      if (!item || typeof item.id !== "string" || !safeId.test(item.id) || typeof item.lastOpenedAt !== "string" || Number.isNaN(Date.parse(item.lastOpenedAt)) || new Date(item.lastOpenedAt).toISOString() !== item.lastOpenedAt) continue;
      if (!unique.has(item.id) || item.lastOpenedAt > unique.get(item.id).lastOpenedAt) unique.set(item.id, { id: item.id, lastOpenedAt: item.lastOpenedAt });
    }
    return [...unique.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  } catch { return []; }
}

async function saveRecent(path, id) {
  const cards = (await recentCards(path)).filter(item => item.id !== id);
  cards.unshift({ id, lastOpenedAt: new Date().toISOString() });
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, cards }, null, 2)}\n`); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}

function piInvocation() {
  if (process.platform !== "win32") return { command: process.env.BOBO_PI_COMMAND || "pi", prefix: [] };
  const cli = resolve(process.env.BOBO_PI_CLI || join(process.env.APPDATA || "", "npm", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
  return { command: process.execPath, prefix: [cli] };
}

async function checkPiVersion(spawnPi, pi, cwd, testedVersion) {
  if (typeof testedVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(testedVersion)) throw new Error("Card Pi compatibility declaration is missing.");
  const child = spawnPi(pi.command, [...pi.prefix, "--version"], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const chunks = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  let timer;
  const result = await Promise.race([
    new Promise((resolveDone, rejectDone) => { child.once("error", rejectDone); child.once("exit", code => code === 0 ? resolveDone(Buffer.concat(chunks).toString("utf8").trim()) : rejectDone(new Error(`Pi version check exited with ${code}.`))); }),
    new Promise((_, rejectDone) => { timer = setTimeout(() => { child.kill(); rejectDone(new Error("Pi version check timed out.")); }, 10000); }),
  ]).finally(() => clearTimeout(timer));
  const actual = String(result).match(/\d+\.\d+\.\d+/)?.[0];
  if (actual !== testedVersion) throw new Error(`Card was tested with Pi ${testedVersion}; installed Pi reports ${actual || String(result)}.`);
}

function send(response, status, body, type = "application/json; charset=utf-8") {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(type.startsWith("application/json") ? JSON.stringify(body) : body);
}

export async function startLauncher({ playRoot, host = "127.0.0.1", port = 0, spawnPi = spawn, openBrowser = null }) {
  const root = resolve(playRoot);
  const cardsRoot = resolve(root, "cards");
  const recentPath = join(root, "launcher", "state", "recent-cards.json");
  const token = randomBytes(24).toString("base64url");
  let active = null;
  let starting = false;
  let baseUrl = "";

  async function cardDescription(id) {
    if (!safeId.test(id)) throw new Error("Card ID is invalid.");
    const card = (await scanCards(root)).find(value => value.id === id);
    if (!card || !card.launchable) throw new Error(`Card ${id} has no independent runtime package.`);
    const cardRoot = join(cardsRoot, id);
    const validation = await validateRuntimePackage(cardRoot);
    if (!validation.ok) throw new Error(`Card ${id} has invalid runtime dependencies: ${validation.errors.slice(0, 4).join("; ")}`);
    const launch = await json(join(cardRoot, "runtime", "launch.json"));
    const lock = await json(join(cardRoot, "runtime-lock.json"));
    if (launch.schemaVersion !== 1 || launch.cardId !== id || lock.schemaVersion !== 1 || lock.cardId !== id || !Array.isArray(launch.skills)) throw new Error("Card launch metadata is incompatible.");
    const pathFor = value => {
      if (typeof value !== "string") throw new Error("Card launch path is invalid.");
      const path = resolve(cardRoot, value);
      if (!isInside(cardRoot, path)) throw new Error("Card launch path escapes its package.");
      return path;
    };
    const entry = pathFor(launch.entry);
    const skills = launch.skills.map(pathFor);
    for (const path of [entry, ...skills]) if (!await present(path)) throw new Error(`Card launch dependency is missing: ${relative(cardRoot, path)}`);
    return { cardRoot, entry, skills, testedVersion: launch.engine?.testedVersion, testedNodeMajor: launch.engine?.testedNodeMajor };
  }

  async function stopActive() {
    if (!active) return;
    const current = active;
    if (current.url) {
      try {
        const snapshot = await fetch(new URL("/api/state", current.url), { signal: AbortSignal.timeout(3000) }).then(response => {
          if (!response.ok) throw new Error(`Card state returned HTTP ${response.status}.`);
          return response.json();
        });
        if (typeof snapshot.busy !== "boolean" || !Array.isArray(snapshot.blockingWorkflows) || !Number.isInteger(snapshot.activeWorkflowRuns) || snapshot.activeWorkflowRuns < 0) throw new Error("Card state is incomplete.");
        if (snapshot.busy || snapshot.blockingWorkflows?.length || snapshot.activeWorkflowRuns > 0) throw new Error("The current card has unfinished work. Wait for it to finish before switching.");
      } catch (error) {
        if (error.message?.includes("unfinished work")) throw error;
        throw new Error("Could not confirm the current card is idle; its Pi process was left running.");
      }
    }
    const waitForExit = timeoutMs => new Promise(resolveExit => {
      if (current.exited) return resolveExit(true);
      const onExit = () => { clearTimeout(timer); resolveExit(true); };
      const timer = setTimeout(() => { current.child.off("exit", onExit); resolveExit(current.exited); }, timeoutMs);
      current.child.once("exit", onExit);
    });
    const stopResponse = new Promise((resolveResponse, rejectResponse) => {
      let buffer = "";
      const cleanup = () => { clearTimeout(timer); current.child.stdout.off("data", onData); current.child.off("exit", onExit); };
      const onExit = () => { cleanup(); resolveResponse(); };
      const onData = chunk => {
        buffer += chunk.toString();
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const response = JSON.parse(line);
            if (response.id !== "stop-card" || response.type !== "response") continue;
            cleanup();
            if (response.success === false) rejectResponse(new Error(response.error || "The current card refused to stop."));
            else resolveResponse();
            return;
          } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        }
      };
      const timer = setTimeout(() => { cleanup(); rejectResponse(new Error("The current card did not confirm shutdown; it remains active.")); }, 3000);
      current.child.stdout.on("data", onData);
      current.child.once("exit", onExit);
    });
    current.child.stdin.write(`${JSON.stringify({ id: "stop-card", type: "prompt", message: "/rp-web-shutdown" })}\n`);
    await stopResponse;
    if (!await waitForExit(2000)) {
      current.child.stdin.end();
      if (!await waitForExit(1500)) {
        current.child.kill();
        if (!await waitForExit(3000)) throw new Error(`The current card did not stop; it remains active. ${current.stderr || current.stdout}`);
      }
    }
    active = null;
    await rm(current.readyPath, { force: true });
  }

  async function launchCard(id) {
    if (starting) throw new Error("A card is already starting.");
    if (active?.id === id && active.url) return { url: active.url, reused: true };
    starting = true;
    try {
      const card = await cardDescription(id);
      const nodeMajor = Number(process.versions.node.split(".")[0]);
      if (nodeMajor !== card.testedNodeMajor) throw new Error(`Card was tested with Node ${card.testedNodeMajor}; launcher uses Node ${nodeMajor}.`);
      const pi = piInvocation();
      await checkPiVersion(spawnPi, pi, root, card.testedVersion);
      await stopActive();
      const stateDirectory = join(root, "launcher", "state");
      await mkdir(stateDirectory, { recursive: true });
      const readyPath = join(stateDirectory, `ready-${randomUUID()}.json`);
      const args = [...pi.prefix, "--mode", "rpc", "--approve", "--no-extensions", "-e", card.entry, "--no-skills", ...card.skills.flatMap(path => ["--skill", path]), "--no-prompt-templates", "--no-context-files", "--session-dir", join(root, "pi-sessions", id)];
      const child = spawnPi(pi.command, args, { cwd: root, env: { ...process.env, BOBO_RP_CARD_ID: id, BOBO_RP_READY_FILE: readyPath, BOBO_RP_LAUNCHER_URL: baseUrl }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const current = { id, child, readyPath, url: null, stderr: "", stdout: "", exited: false };
      active = current;
      child.on("exit", () => { current.exited = true; if (active === current) active = null; });
      child.on("error", error => { current.stderr = error.message; current.exited = true; if (active === current) active = null; });
      child.stdin.on("error", error => { current.stderr = error.message; });
      child.stderr.on("data", chunk => { current.stderr = `${current.stderr}${chunk}`.slice(-2000); });
      child.stdout.on("data", chunk => { current.stdout = `${current.stdout}${chunk}`.slice(-4000); });
      child.stdin.write(`${JSON.stringify({ id: "open-card", type: "prompt", message: `/rp-web ${id}` })}\n`);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (current.exited) throw new Error(`Pi exited while opening ${id}: ${current.stderr || "no diagnostic output"}`);
        if (await present(readyPath)) {
          const ready = await json(readyPath);
          if (ready.cardId !== id || !/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(ready.url)) throw new Error("Card frontend returned an invalid ready address.");
          current.url = ready.url;
          await saveRecent(recentPath, id);
          if (openBrowser) openBrowser(ready.url);
          return { url: ready.url, reused: false };
        }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
      }
      throw new Error(`Timed out opening ${id}: ${current.stderr || current.stdout || "no ready signal"}`);
    } catch (error) {
      if (active && !active.url) { active.child.kill(); await rm(active.readyPath, { force: true }); active = null; }
      throw error;
    } finally { starting = false; }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", baseUrl);
      if (request.method === "GET" && url.pathname === "/") {
        const html = (await readFile(join(sourceDirectory, "index.html"), "utf8")).replace("__LAUNCHER_TOKEN__", token);
        return send(response, 200, html, "text/html; charset=utf-8");
      }
      if (request.method === "GET" && url.pathname === "/api/cards") return send(response, 200, { cards: await scanCards(root), recent: await recentCards(recentPath), active: active?.id || null });
      const coverMatch = url.pathname.match(/^\/api\/cards\/([A-Za-z0-9][A-Za-z0-9._-]*)\/cover$/);
      if (request.method === "GET" && coverMatch) {
        const id = coverMatch[1], cardRoot = join(cardsRoot, id), manifest = await json(join(cardRoot, "manifest.json"));
        if (manifest.id !== id || typeof manifest.cover !== "string") throw new Error("Cover is unavailable.");
        const cover = resolve(cardRoot, manifest.cover), extension = extname(cover).toLowerCase();
        if (!isInside(cardRoot, cover) || ![".png", ".jpg", ".jpeg", ".webp"].includes(extension) || !(await lstat(cover)).isFile()) throw new Error("Cover path is invalid.");
        return send(response, 200, await readFile(cover), { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extension]);
      }
      if (request.method === "POST" && url.pathname === "/api/launch") {
        if (request.headers["x-launcher-token"] !== token) return send(response, 403, { error: "Launcher token is invalid." });
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 4096) return send(response, 413, { error: "Request is too large." }); }
        const { cardId } = JSON.parse(body);
        return send(response, 200, await launchCard(cardId));
      }
      send(response, 404, { error: "Not found." });
    } catch (error) { send(response, 400, { error: error.message || String(error) }); }
  });
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(port, host, resolveListen); });
  baseUrl = `http://${host}:${server.address().port}/`;
  return { url: baseUrl, server, scanCards: () => scanCards(root), recentCards: () => recentCards(recentPath), launchCard, stopActive, close: async () => { await stopActive(); await new Promise(resolveClose => server.close(resolveClose)); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const playRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(sourceDirectory, "..");
  const launcher = await startLauncher({ playRoot });
  console.log(`Card selector: ${launcher.url}`);
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", launcher.url] : [launcher.url];
  execFile(command, args, error => { if (error) console.warn(`Open ${launcher.url} in a browser to choose a card.`); });
}
