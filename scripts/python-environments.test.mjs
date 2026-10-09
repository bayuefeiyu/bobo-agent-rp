import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPythonCandidates,
  detectPython,
  selectPythonCandidate,
} from "./python-environments.mjs";

function fakeFileSystem({ files = {}, directories = {} } = {}) {
  return {
    existsSync(path) {
      return Object.hasOwn(files, path) || Object.hasOwn(directories, path);
    },
    readdirSync(path) {
      return directories[path] || [];
    },
    readFileSync(path) {
      if (!Object.hasOwn(files, path)) throw new Error(`missing ${path}`);
      return files[path];
    },
  };
}

function pythonOutput(hasYaml) {
  return `PYOK 3.12.4 ${hasYaml ? "1" : "0"}\n`;
}

test("buildPythonCandidates includes active and offline Conda environments once", () => {
  const fileSystem = fakeFileSystem({
    files: {
      "C:\\Users\\Test\\.conda\\environments.txt": "C:\\offline\\rp\n# comment\nC:\\offline\\rp\n",
    },
    directories: {
      "C:\\Miniconda3\\envs": [{ name: "named", isDirectory: () => true }],
    },
  });
  const { candidates } = buildPythonCandidates({
    platform: "win32",
    homeDir: "C:\\Users\\Test",
    env: {
      USERPROFILE: "C:\\Users\\Test",
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      CONDA_PREFIX: "C:\\Miniconda3\\envs\\active",
    },
    fileSystem,
    condaRoots: ["C:\\Miniconda3"],
  });
  const executables = candidates.map((candidate) => candidate.exe.toLowerCase().replaceAll("\\", "/"));
  assert.ok(executables.includes("c:/miniconda3/envs/active/python.exe"));
  assert.ok(executables.includes("c:/miniconda3/envs/named/python.exe"));
  assert.ok(executables.includes("c:/offline/rp/python.exe"));
  assert.equal(new Set(executables).size, executables.length);
});

test("selectPythonCandidate prefers the first usable interpreter with PyYAML", () => {
  const selected = selectPythonCandidate([
    { exe: "first", hasYaml: false },
    { exe: "second", hasYaml: true },
    { exe: "third", hasYaml: true },
  ]);
  assert.equal(selected.exe, "second");
  assert.equal(selectPythonCandidate([{ exe: "only", hasYaml: false }]).exe, "only");
});

test("detectPython uses Conda metadata and chooses a later PyYAML environment", () => {
  const fileSystem = fakeFileSystem({
    files: { "/opt/miniconda3/bin/conda": "" },
    directories: { "/tmp/home/.conda/envs": [] },
  });
  const calls = [];
  const commandRunner = (exe, args) => {
    calls.push([exe, args]);
    if (args[0] === "info") {
      return { status: 0, stdout: JSON.stringify({
        root_prefix: "/opt/miniconda3",
        envs_dirs: ["/tmp/home/.conda/envs"],
      }) };
    }
    if (args[0] === "env") {
      return { status: 0, stdout: JSON.stringify({
        envs: ["/tmp/home/.conda/envs/no-yaml", "/tmp/home/.conda/envs/with-yaml"],
      }) };
    }
    if (args.at(-1) === "import importlib.util as u,sys; print('PYOK', sys.version.split()[0], int(u.find_spec('yaml') is not None))") {
      return {
        status: 0,
        stdout: pythonOutput(exe.includes("with-yaml")),
      };
    }
    return { status: 1, stdout: "" };
  };
  const result = detectPython({
    platform: "linux",
    homeDir: "/tmp/home",
    env: { HOME: "/tmp/home", CONDA_EXE: "/opt/miniconda3/bin/conda" },
    fileSystem,
    commandRunner,
  });
  assert.equal(result.python?.exe, "/tmp/home/.conda/envs/with-yaml/bin/python");
  assert.equal(result.python?.hasYaml, true);
  assert.ok(calls.some(([exe, args]) => exe === "/opt/miniconda3/bin/conda" && args[0] === "info"));
});

test("an invalid VERIFY_PYTHON does not fall back to PATH", () => {
  const calls = [];
  const result = detectPython({
    platform: "linux",
    env: { VERIFY_PYTHON: "/missing/python", HOME: "/tmp/home" },
    fileSystem: fakeFileSystem(),
    commandRunner(exe, args) {
      calls.push([exe, args]);
      return { status: 1, stdout: "" };
    },
  });
  assert.equal(result.python, null);
  assert.equal(result.explicitInvalid, true);
  assert.match(result.error, /VERIFY_PYTHON/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/missing/python");
});
