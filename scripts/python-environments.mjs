import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir as defaultHomeDir } from "node:os";
import { win32, posix } from "node:path";

export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_CANDIDATES = 256;

const PYTHON_PROBE = [
  "import importlib.util as u,sys",
  "print('PYOK', sys.version.split()[0], int(u.find_spec('yaml') is not None))",
].join("; ");

const CONDA_ROOT_NAMES = [
  "anaconda3",
  "Anaconda3",
  "miniconda3",
  "Miniconda3",
  "miniforge3",
  "Miniforge3",
  "mambaforge",
  "Mambaforge",
];

const WINDOWS_PYTHON_VERSIONS = ["Python313", "Python312", "Python311", "Python310", "Python39"];

const hostFileSystem = {
  existsSync,
  readdirSync,
  readFileSync,
};

function pathApiFor(platform) {
  return platform === "win32" ? win32 : posix;
}

function asText(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function cleanPath(value) {
  return asText(value).trim().replace(/^['"]|['"]$/g, "");
}

function pathKey(value, platform) {
  const cleaned = cleanPath(value);
  if (!cleaned) return "";
  const normalized = cleaned.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function candidateKey(candidate, platform) {
  return `${pathKey(candidate.exe, platform)}\u0000${(candidate.args || []).join("\u0000")}`;
}

function safeExists(fileSystem, file) {
  try {
    return Boolean(fileSystem.existsSync(file));
  } catch {
    return false;
  }
}

function safeReadDir(fileSystem, dir) {
  try {
    return fileSystem.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadText(fileSystem, file) {
  try {
    return asText(fileSystem.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

function addUniquePath(list, seen, value, platform) {
  const cleaned = cleanPath(value);
  const key = pathKey(cleaned, platform);
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(cleaned);
}

function addCandidate(list, seen, candidate, platform) {
  const exe = cleanPath(candidate?.exe);
  if (!exe) return;
  const normalized = {
    exe,
    args: Array.isArray(candidate.args) ? [...candidate.args] : [],
    source: candidate.source || "discovery",
  };
  const key = candidateKey(normalized, platform);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(normalized);
}

function homeFor({ env, homeDir, platform }) {
  const configured = cleanPath(homeDir);
  if (configured) return configured;
  if (platform === "win32") {
    return cleanPath(env.USERPROFILE || `${env.HOMEDRIVE || ""}${env.HOMEPATH || ""}`);
  }
  return cleanPath(env.HOME) || defaultHomeDir();
}

function userRoots({ env, platform, homeDir, pathApi }) {
  const home = homeFor({ env, platform, homeDir });
  const roots = [];
  const seen = new Set();
  const add = (value) => addUniquePath(roots, seen, value, platform);

  if (platform === "win32") {
    const userProfile = cleanPath(env.USERPROFILE) || home;
    const localAppData = cleanPath(env.LOCALAPPDATA);
    const programData = cleanPath(env.ProgramData);
    for (const name of CONDA_ROOT_NAMES) {
      add(pathApi.join(userProfile, name));
      if (localAppData) add(pathApi.join(localAppData, name));
      if (programData) add(pathApi.join(programData, name));
      if (localAppData) add(pathApi.join(localAppData, "Programs", name));
    }
    if (localAppData) {
      add(pathApi.join(localAppData, "Continuum", "anaconda3"));
      add(pathApi.join(localAppData, "Continuum", "miniconda3"));
    }
  } else {
    for (const name of CONDA_ROOT_NAMES) add(pathApi.join(home, name));
    for (const root of [
      "/opt/anaconda3",
      "/opt/miniconda3",
      "/opt/miniforge3",
      "/opt/mambaforge",
      "/usr/local/anaconda3",
      "/usr/local/miniconda3",
    ]) add(root);
    if (platform === "darwin") {
      add(pathApi.join(home, "opt", "anaconda3"));
      add(pathApi.join(home, "opt", "miniconda3"));
      add("/opt/homebrew/Caskroom/miniconda/base");
      add("/opt/homebrew/Caskroom/miniforge/base");
    }
  }
  return roots;
}

function condaExecutablesForRoot(root, platform, pathApi) {
  if (platform === "win32") {
    return [
      pathApi.join(root, "Scripts", "conda.exe"),
      pathApi.join(root, "condabin", "conda.bat"),
      pathApi.join(root, "condabin", "conda.exe"),
    ];
  }
  return [pathApi.join(root, "bin", "conda")];
}

function rootFromCondaExecutable(exe, platform, pathApi) {
  const value = cleanPath(exe);
  if (!value || !value.includes("/") && !value.includes("\\")) return null;
  const firstParent = pathApi.dirname(value);
  const root = pathApi.dirname(firstParent);
  if (!root || root === firstParent) return null;
  const lower = value.toLowerCase();
  if (!lower.endsWith("conda.exe") && !lower.endsWith("conda.bat") && !lower.endsWith("/conda") && !lower.endsWith("\\conda")) return null;
  return pathApi.normalize(root);
}

function addPythonForPrefix(list, seen, prefix, source, platform, pathApi) {
  const cleaned = cleanPath(prefix);
  if (!cleaned) return;
  const python = platform === "win32"
    ? pathApi.join(cleaned, "python.exe")
    : pathApi.join(cleaned, "bin", "python");
  addCandidate(list, seen, { exe: python, source }, platform);
}

function addPythonForEnvList(list, seen, prefixes, source, platform, pathApi) {
  for (const prefix of prefixes || []) addPythonForPrefix(list, seen, prefix, source, platform, pathApi);
}

function addCondaRootCandidates(list, seen, rootSeen, roots, source, fileSystem, platform, pathApi) {
  for (const root of roots || []) {
    const cleaned = cleanPath(root);
    const key = pathKey(cleaned, platform);
    if (!key || rootSeen.has(key)) continue;
    rootSeen.add(key);
    addPythonForPrefix(list, seen, cleaned, source, platform, pathApi);
    const envsDir = pathApi.join(cleaned, "envs");
    if (!safeExists(fileSystem, envsDir)) continue;
    for (const entry of safeReadDir(fileSystem, envsDir)) {
      const name = typeof entry === "string" ? entry : entry?.name;
      const isDirectory = typeof entry === "string" || entry?.isDirectory?.();
      if (isDirectory && name) addPythonForPrefix(list, seen, pathApi.join(envsDir, name), `${source} envs`, platform, pathApi);
    }
  }
}

function readCondaEnvironmentFile(fileSystem, file) {
  return safeReadText(fileSystem, file)
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

function addCommonPythonCandidates(list, seen, { env, platform, homeDir, fileSystem, pathApi }) {
  if (platform === "win32") {
    const localAppData = cleanPath(env.LOCALAPPDATA);
    const userProfile = cleanPath(env.USERPROFILE) || homeFor({ env, homeDir, platform });
    const pythonRoots = [];
    if (localAppData) pythonRoots.push(pathApi.join(localAppData, "Programs", "Python"));
    pythonRoots.push(pathApi.join(userProfile, "AppData", "Local", "Programs", "Python"));
    for (const root of pythonRoots) {
      if (!safeExists(fileSystem, root)) continue;
      for (const entry of safeReadDir(fileSystem, root)) {
        const name = typeof entry === "string" ? entry : entry?.name;
        const isDirectory = typeof entry === "string" || entry?.isDirectory?.();
        if (isDirectory && /^Python3/i.test(name || "")) {
          addCandidate(list, seen, { exe: pathApi.join(root, name, "python.exe"), source: "common Python install" }, platform);
        }
      }
    }
    for (const version of WINDOWS_PYTHON_VERSIONS) addCandidate(list, seen, {
      exe: pathApi.join("C:\\", version, "python.exe"),
      source: "common Python install",
    }, platform);
  } else {
    for (const exe of ["/usr/bin/python3", "/usr/local/bin/python3"]) {
      addCandidate(list, seen, { exe, source: "common Python install" }, platform);
    }
  }
}

/**
 * Build a deterministic, deduplicated list of Python interpreter candidates.
 * This function does not execute Python or conda; callers may provide facts
 * discovered by a separate command probe through condaRoots, condaEnvDirs,
 * and condaEnvironments.
 */
export function buildPythonCandidates({
  env = process.env,
  platform = process.platform,
  homeDir,
  fileSystem = hostFileSystem,
  condaRoots = [],
  condaEnvDirs = [],
  condaEnvironments = [],
} = {}) {
  const pathApi = pathApiFor(platform);
  const candidates = [];
  const seen = new Set();
  const rootSeen = new Set();
  const add = (candidate) => addCandidate(candidates, seen, candidate, platform);

  const verifyPython = cleanPath(env.VERIFY_PYTHON);
  const boboPython = cleanPath(env.BOBO_PYTHON);
  if (verifyPython) add({ exe: verifyPython, source: "VERIFY_PYTHON" });
  if (boboPython) add({ exe: boboPython, source: "BOBO_PYTHON" });

  const activePrefix = cleanPath(env.CONDA_PREFIX);
  if (activePrefix) addPythonForPrefix(candidates, seen, activePrefix, "CONDA_PREFIX", platform, pathApi);

  const roots = [];
  const rootListSeen = new Set();
  const addRoot = (root) => addUniquePath(roots, rootListSeen, root, platform);
  for (const root of condaRoots) addRoot(root);
  for (const root of userRoots({ env, platform, homeDir, pathApi })) addRoot(root);
  addCondaRootCandidates(candidates, seen, rootSeen, roots, "Conda", fileSystem, platform, pathApi);

  const environmentPrefixes = [];
  const environmentSeen = new Set();
  const addEnvironment = (prefix) => addUniquePath(environmentPrefixes, environmentSeen, prefix, platform);
  for (const prefix of condaEnvironments) addEnvironment(prefix);
  for (const envDir of condaEnvDirs) {
    const cleaned = cleanPath(envDir);
    if (!cleaned || !safeExists(fileSystem, cleaned)) continue;
    for (const entry of safeReadDir(fileSystem, cleaned)) {
      const name = typeof entry === "string" ? entry : entry?.name;
      const isDirectory = typeof entry === "string" || entry?.isDirectory?.();
      if (isDirectory && name) addEnvironment(pathApi.join(cleaned, name));
    }
  }
  const home = homeFor({ env, homeDir, platform });
  if (home) {
    for (const prefix of readCondaEnvironmentFile(fileSystem, pathApi.join(home, ".conda", "environments.txt"))) {
      addEnvironment(prefix);
    }
  }
  addPythonForEnvList(candidates, seen, environmentPrefixes, "Conda environment", platform, pathApi);

  add({ exe: "python3", source: "PATH" });
  add({ exe: "python", source: "PATH" });
  if (platform === "win32") add({ exe: "py", args: ["-3"], source: "PATH (py -3)" });
  addCommonPythonCandidates(candidates, seen, { env, platform, homeDir, fileSystem, pathApi });

  return {
    candidates,
    explicitVerify: verifyPython ? { exe: verifyPython, args: [], source: "VERIFY_PYTHON" } : null,
  };
}

// Descriptive aliases keep the pure discovery and selection helpers convenient
// for callers that do not need the process probing performed by detectPython.
export const discoverPythonCandidates = buildPythonCandidates;

function normalizeCommandResult(result) {
  if (!result) return { status: null, stdout: "", stderr: "", timedOut: false, error: "no result" };
  const error = result.error;
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout: asText(result.stdout),
    stderr: asText(result.stderr),
    timedOut: Boolean(result.timedOut || error?.code === "ETIMEDOUT"),
    error: error ? error.code || error.message || String(error) : null,
  };
}

export function runPythonEnvironmentCommand(exe, args = [], { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
  try {
    const result = spawnSync(exe, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    return normalizeCommandResult(result);
  } catch (error) {
    return normalizeCommandResult({ error });
  }
}

function condaCommandCandidates({ env, roots, platform, pathApi, fileSystem }) {
  const candidates = [];
  const seen = new Set();
  const add = (exe, source, { allowMissing = false } = {}) => {
    const cleaned = cleanPath(exe);
    if (!cleaned) return;
    const key = pathKey(cleaned, platform);
    if (seen.has(key)) return;
    if (!allowMissing && (cleaned.includes("/") || cleaned.includes("\\"))) {
      if (!safeExists(fileSystem, cleaned)) return;
    }
    seen.add(key);
    candidates.push({ exe: cleaned, source });
  };
  if (env.CONDA_EXE) add(env.CONDA_EXE, "CONDA_EXE", { allowMissing: true });
  for (const root of roots) {
    for (const exe of condaExecutablesForRoot(root, platform, pathApi)) add(exe, "common Conda install");
  }
  add("conda", "PATH");
  return candidates;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    const text = asText(output).trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function condaFacts({ env, platform, homeDir, fileSystem, commandRunner, timeoutMs }) {
  const pathApi = pathApiFor(platform);
  const roots = userRoots({ env, platform, homeDir, pathApi });
  const derivedRoot = rootFromCondaExecutable(env.CONDA_EXE, platform, pathApi);
  if (derivedRoot) roots.push(derivedRoot);
  const commands = condaCommandCandidates({ env, roots, platform, pathApi, fileSystem });
  const discoveredRoots = [...roots];
  const envDirs = [];
  const environments = [];
  const rootSeen = new Set(roots.map((root) => pathKey(root, platform)));
  const envDirSeen = new Set();
  const environmentSeen = new Set();
  const addRoot = (root) => {
    const cleaned = cleanPath(root);
    const key = pathKey(cleaned, platform);
    if (!key || rootSeen.has(key)) return;
    rootSeen.add(key);
    discoveredRoots.push(cleaned);
  };
  const addEnvDir = (dir) => {
    const cleaned = cleanPath(dir);
    const key = pathKey(cleaned, platform);
    if (!key || envDirSeen.has(key)) return;
    envDirSeen.add(key);
    envDirs.push(cleaned);
  };
  const addEnvironment = (prefix) => {
    const cleaned = cleanPath(prefix);
    const key = pathKey(cleaned, platform);
    if (!key || environmentSeen.has(key)) return;
    environmentSeen.add(key);
    environments.push(cleaned);
  };

  for (const command of commands) {
    const infoResult = normalizeCommandResult(commandRunner(command.exe, ["info", "--json"], { timeoutMs }));
    const info = infoResult.status === 0 ? parseJsonOutput(infoResult.stdout) : null;
    if (info) {
      addRoot(info.root_prefix);
      addRoot(info.active_prefix);
      for (const dir of info.envs_dirs || []) addEnvDir(dir);
      for (const envPath of info.envs || []) addEnvironment(envPath);
    }
    const envResult = normalizeCommandResult(commandRunner(command.exe, ["env", "list", "--json"], { timeoutMs }));
    const envList = envResult.status === 0 ? parseJsonOutput(envResult.stdout) : null;
    if (envList) for (const envPath of envList.envs || []) addEnvironment(envPath);
  }
  return { roots: discoveredRoots, envDirs, environments };
}

export function probePythonCandidate(candidate, {
  commandRunner = runPythonEnvironmentCommand,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
} = {}) {
  const result = normalizeCommandResult(commandRunner(
    candidate.exe,
    [...(candidate.args || []), "-X", "utf8", "-c", PYTHON_PROBE],
    { timeoutMs },
  ));
  if (result.status !== 0 || result.timedOut) return null;
  const matches = result.stdout.match(/(?:^|\r?\n)PYOK\s+(\S+)\s+([01])(?:\r?\n|$)/g);
  const match = matches?.length ? matches[matches.length - 1].match(/PYOK\s+(\S+)\s+([01])/): null;
  if (!match) return null;
  return {
    exe: candidate.exe,
    args: candidate.args || [],
    source: candidate.source,
    version: match[1],
    hasYaml: match[2] === "1",
  };
}

/** Select the first usable interpreter, preferring the first one with PyYAML. */
export function selectPythonCandidate(probedCandidates) {
  const usable = (probedCandidates || []).filter(Boolean);
  return usable.find((candidate) => candidate.hasYaml) || usable[0] || null;
}

export const choosePythonCandidate = selectPythonCandidate;

export function detectPython({
  env = process.env,
  platform = process.platform,
  homeDir,
  fileSystem = hostFileSystem,
  commandRunner = runPythonEnvironmentCommand,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
} = {}) {
  const pathApi = pathApiFor(platform);
  const initialRoots = userRoots({ env, platform, homeDir, pathApi });
  const derivedRoot = rootFromCondaExecutable(env.CONDA_EXE, platform, pathApi);
  if (derivedRoot) initialRoots.push(derivedRoot);

  // An explicit interpreter is an instruction, rather than a preference. Probe
  // it before consulting PATH or Conda so a typo cannot silently select another
  // interpreter.
  if (cleanPath(env.VERIFY_PYTHON)) {
    const explicitCandidate = {
      exe: cleanPath(env.VERIFY_PYTHON),
      args: [],
      source: "VERIFY_PYTHON",
    };
    const explicit = probePythonCandidate(explicitCandidate, { commandRunner, timeoutMs });
    if (!explicit) {
      return {
        python: null,
        candidates: [explicitCandidate],
        explicitInvalid: true,
        error: `VERIFY_PYTHON 指向的解释器不可用：${explicitCandidate.exe}`,
      };
    }
    return { python: explicit, candidates: [explicitCandidate], explicitInvalid: false, error: null };
  }

  const facts = condaFacts({ env, platform, homeDir, fileSystem, commandRunner, timeoutMs });
  const built = buildPythonCandidates({
    env,
    platform,
    homeDir,
    fileSystem,
    condaRoots: [...initialRoots, ...facts.roots],
    condaEnvDirs: facts.envDirs,
    condaEnvironments: facts.environments,
  });
  const candidates = built.candidates.slice(0, Math.max(1, maxCandidates));

  const usable = [];
  for (const candidate of candidates) {
    const probed = probePythonCandidate(candidate, { commandRunner, timeoutMs });
    if (probed) usable.push(probed);
    if (probed?.hasYaml) break;
  }
  const python = selectPythonCandidate(usable);
  return {
    python,
    candidates,
    explicitInvalid: false,
    error: python ? null : "未找到可用的 Python 3 解释器。",
  };
}
