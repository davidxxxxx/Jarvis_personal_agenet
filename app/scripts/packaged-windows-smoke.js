"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const WebSocket = require("ws");

const DIAGNOSTIC_FILE = "packaged-smoke.jsonl";
const BUILD_MANIFEST_FILE = "jarvis-build.json";
const BUILD_MANIFEST_VERSION = 1;
const MAX_BUILD_MANIFEST_BYTES = 16 * 1024;
const GIT_SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const OFFLINE_PROXY = "http://127.0.0.1:9";
const MAX_CAPTURE_BYTES = 256 * 1024;
const CREDENTIAL_ENV_NAMES = new Set([
  "MINIMAX_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "MISTRAL_API_KEY",
  "TINFOIL_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "CORTI_CLIENT_ID",
  "CORTI_CLIENT_SECRET",
  "CUSTOM_TRANSCRIPTION_API_KEY",
  "CUSTOM_CLEANUP_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "BEDROCK_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "VERTEX_API_KEY",
  "DICTATION_KEY",
  "CHAT_AGENT_KEY",
  "AGENT_KEY",
  "VOICE_AGENT_KEY",
  "MEETING_KEY",
]);
const SECRET_ENV_NAME =
  /(?:api[_-]?key|token|secret|password|credential|authorization|csc_|aws_|azure_|google_application|openai|anthropic|groq|minimax)/iu;
const JARVIS_STORAGE_OVERRIDE_ENV_NAME =
  /^JARVIS_.*(?:data|recordings|storage|root|directory|dir|path)/iu;
const NATIVE_BINDING_FAILURE =
  /(?:could not (?:locate|find) (?:the )?(?:module )?bindings?|cannot find module ['"]?bindings|better[_-]sqlite3|better_sqlite3\.node|node_module_version|compiled against a different node\.js version|err_dlopen_failed|specified module could not be found)/iu;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertPositiveTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw codedError("PACKAGED_SMOKE_INPUT_INVALID", `${name} is invalid`);
  }
  return value;
}

function assertRuntimeRoot(value, platform = process.platform) {
  if (platform !== "win32") {
    throw codedError("PACKAGED_SMOKE_UNSUPPORTED", "Packaged Windows smoke requires Windows");
  }
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || value.includes("\0")) {
    throw codedError("PACKAGED_SMOKE_INPUT_INVALID", "Packaged smoke storage is invalid");
  }
  const resolved = path.resolve(value);
  if (path.win32.parse(resolved).root.toLowerCase() === "c:\\") {
    throw codedError(
      "PACKAGED_SMOKE_UNSAFE_STORAGE",
      "Packaged smoke storage must not use the system drive"
    );
  }
  return resolved;
}

function createOfflineSmokeEnvironment({
  runtimeRoot,
  env = process.env,
  platform = process.platform,
} = {}) {
  const root = assertRuntimeRoot(runtimeRoot, platform);
  const sanitized = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (CREDENTIAL_ENV_NAMES.has(name.toUpperCase())) continue;
    if (SECRET_ENV_NAME.test(name)) continue;
    if (JARVIS_STORAGE_OVERRIDE_ENV_NAME.test(name)) continue;
    if (value !== undefined) sanitized[name] = value;
  }
  delete sanitized.ELECTRON_RUN_AS_NODE;

  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  const dataRoot = path.join(root, "user-data", "jarvis");
  return {
    ...sanitized,
    OPENWHISPR_CHANNEL: "production",
    NODE_ENV: "production",
    HTTP_PROXY: OFFLINE_PROXY,
    HTTPS_PROXY: OFFLINE_PROXY,
    ALL_PROXY: OFFLINE_PROXY,
    NO_PROXY: "localhost,127.0.0.1,::1",
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    USERPROFILE: home,
    HOME: home,
    TEMP: temp,
    TMP: temp,
    JARVIS_DATA_ROOT: dataRoot,
    JARVIS_DATA_DIR: dataRoot,
    JARVIS_RECORDINGS_DIR: "",
  };
}

function appendDiagnostic(fsImpl, diagnosticPath, entry) {
  fsImpl.appendFileSync(
    diagnosticPath,
    `${JSON.stringify({
      at: Date.now(),
      launch: entry.launch,
      stage: entry.stage,
      code: entry.code,
      exitCode: Number.isSafeInteger(entry.exitCode) ? entry.exitCode : null,
      artifactCommit: GIT_SHA1_PATTERN.test(entry.artifactCommit) ? entry.artifactCommit : null,
    })}\n`,
    "utf8"
  );
}

function createOutputCollector(streams) {
  let captured = "";
  const accept = (chunk) => {
    if (captured.length >= MAX_CAPTURE_BYTES) return;
    captured += Buffer.from(chunk)
      .toString("utf8")
      .slice(0, MAX_CAPTURE_BYTES - captured.length);
  };
  for (const stream of streams) stream?.on?.("data", accept);
  return () => captured;
}

function failureForOutput(output) {
  if (NATIVE_BINDING_FAILURE.test(output)) {
    return codedError(
      "PACKAGED_NATIVE_BINDING_LOAD_FAILED",
      "Packaged native binding failed to load"
    );
  }
  return codedError("PACKAGED_STARTUP_FAILED", "Packaged application failed to start");
}

function waitForChildExit(child) {
  let settled = false;
  let result = null;
  const promise = new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      result = value;
      resolve(value);
    };
    child.once("exit", (code, signal) => finish({ code, signal, spawnError: false }));
    child.once("error", () => finish({ code: null, signal: null, spawnError: true }));
  });
  return {
    promise,
    isSettled: () => settled,
    result: () => result,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForReady({ childExit, port, launchIndex, timeoutMs, probeImpl }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (childExit.isSettled()) return null;
    try {
      const ready = await probeImpl({ port, launchIndex });
      if (
        ready &&
        typeof ready.browserWebSocketUrl === "string" &&
        ready.browserWebSocketUrl.startsWith("ws://127.0.0.1:") &&
        typeof ready.pageWebSocketUrl === "string" &&
        ready.pageWebSocketUrl.startsWith("ws://127.0.0.1:") &&
        Number.isSafeInteger(ready.pageCount) &&
        ready.pageCount > 0
      ) {
        return ready;
      }
    } catch {
      // Startup races and connection refusals are expected until Electron opens the debug endpoint.
    }
    if (childExit.isSettled()) return null;
    await delay(200);
  }
  return null;
}

function waitForExitWithin(
  childExit,
  timeoutMs,
  { setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}
) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      resolve(value);
    };
    const timer = setTimeoutImpl(() => finish(null), timeoutMs);
    childExit.promise.then(finish);
  });
}

function httpJson(port, requestPath, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        timeout: timeoutMs,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error("remote debugging endpoint is unavailable"));
          return;
        }
        const chunks = [];
        let length = 0;
        response.on("data", (chunk) => {
          length += chunk.length;
          if (length <= 128 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (length > 128 * 1024) {
            reject(new Error("remote debugging response is too large"));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("remote debugging response is invalid"));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("remote debugging request timed out")));
    request.on("error", reject);
  });
}

async function probeElectron({ port, httpJsonImpl = httpJson }) {
  const [version, targets] = await Promise.all([
    httpJsonImpl(port, "/json/version"),
    httpJsonImpl(port, "/json/list"),
  ]);
  const pages = Array.isArray(targets) ? targets.filter((target) => target?.type === "page") : [];
  const debuggablePages = pages.filter(
    (target) =>
      typeof target.webSocketDebuggerUrl === "string" &&
      target.webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")
  );
  const rendererPage =
    debuggablePages.find(
      (target) => typeof target.url === "string" && /[?&]panel=true(?:&|$)/u.test(target.url)
    ) ??
    debuggablePages.find(
      (target) => typeof target.url === "string" && /[?&]agent=true(?:&|$)/u.test(target.url)
    );
  return {
    browserWebSocketUrl: version?.webSocketDebuggerUrl,
    pageWebSocketUrl: rendererPage?.webSocketDebuggerUrl,
    pageCount: pages.length,
  };
}

function evaluatePageViaCdp(
  pageWebSocketUrl,
  expression,
  { WebSocketImpl = WebSocket, timeoutMs = 20_000 } = {}
) {
  if (
    typeof pageWebSocketUrl !== "string" ||
    !pageWebSocketUrl.startsWith("ws://127.0.0.1:") ||
    typeof expression !== "string" ||
    expression.length === 0
  ) {
    return Promise.reject(
      codedError("PACKAGED_RENDERER_API_FAILED", "Packaged renderer API check failed")
    );
  }
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // The renderer may close its CDP socket while the application is exiting.
      }
      if (error) reject(error);
      else resolve(value);
    };
    const fail = () =>
      finish(codedError("PACKAGED_RENDERER_API_FAILED", "Packaged renderer API check failed"));
    const timer = setTimeout(fail, timeoutMs);
    try {
      socket = new WebSocketImpl(pageWebSocketUrl);
    } catch {
      fail();
      return;
    }
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
          },
        })
      );
    });
    socket.on("message", (data) => {
      let response;
      try {
        response = JSON.parse(String(data));
      } catch {
        fail();
        return;
      }
      if (response?.id !== 1) return;
      if (
        response.error ||
        response.result?.exceptionDetails ||
        !Object.prototype.hasOwnProperty.call(response.result?.result ?? {}, "value")
      ) {
        fail();
        return;
      }
      finish(null, response.result.result.value);
    });
    socket.once("close", () => fail());
    socket.once("error", () => fail());
  });
}

function rendererSessionExpression({ launchIndex, sessionId, startedAt, allowedStorageRoot }) {
  const input = JSON.stringify({ sessionId, startedAt, allowedStorageRoot });
  const required =
    launchIndex === 1
      ? '["createSession", "startCapture", "finishCapture", "listSessions", "getSessionDetail", "getStorageStatus"]'
      : '["listSessions", "getSessionDetail", "getStorageStatus"]';
  const createAndFinish =
    launchIndex === 1
      ? `
    const before = await api.listSessions(query);
    if (!Array.isArray(before) || before.some((session) => session && session.id === sessionId)) {
      return { ok: false, sessionId, matchCount: 0, terminal: false };
    }
    const created = await api.createSession({
      id: sessionId,
      startedAt,
      micDeviceId: null,
      language: "zh",
      captureMode: "mic",
      retentionMode: "continuous"
    });
    if (!created || created.id !== sessionId || created.status !== "recording") {
      return { ok: false, sessionId, matchCount: 0, terminal: false };
    }
    const started = await api.startCapture({
      sessionId,
      startedAt,
      micDeviceId: null,
      captureMode: "mic",
      retentionMode: "continuous",
      sources: [{
        sourceType: "mic",
        deviceId: null,
        deviceLabel: null,
        strategy: "packaged_smoke"
      }]
    });
    if (!started || started.sessionId !== sessionId || started.status !== "recording") {
      return { ok: false, sessionId, matchCount: 0, terminal: false };
    }
    const finished = await api.finishCapture(sessionId, startedAt + 1);
    if (!finished || finished.sessionId !== sessionId || finished.status !== "completed") {
      return { ok: false, sessionId, matchCount: 0, terminal: false };
    }`
      : "";
  return `(async ({ sessionId, startedAt, allowedStorageRoot }) => {
    const required = ${required};
    const deadline = Date.now() + 10000;
    let api = null;
    while (Date.now() < deadline) {
      api = window.electronAPI && window.electronAPI.jarvis;
      if (api && required.every((name) => typeof api[name] === "function")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!api || !required.every((name) => typeof api[name] === "function")) {
      return { ok: false, sessionId, matchCount: 0, terminal: false, storageRootVerified: false };
    }
    const separator = String.fromCharCode(92);
    const normalizeRoot = (value) => {
      if (typeof value !== "string") return "";
      let normalized = value.split("/").join(separator).toLowerCase();
      while (normalized.endsWith(separator)) normalized = normalized.slice(0, -1);
      return normalized;
    };
    const storageStatus = await api.getStorageStatus();
    const currentRoot = normalizeRoot(storageStatus && storageStatus.currentRoot);
    const allowedRoot = normalizeRoot(allowedStorageRoot);
    const storageRootVerified =
      currentRoot === allowedRoot || currentRoot.startsWith(allowedRoot + separator);
    if (!allowedRoot || !storageRootVerified) {
      return { ok: false, sessionId, matchCount: 0, terminal: false, storageRootVerified: false };
    }
    const query = { from: startedAt, to: startedAt, limit: 1000 };
    ${createAndFinish}
    const sessions = await api.listSessions(query);
    const matches = Array.isArray(sessions)
      ? sessions.filter((session) => session && session.id === sessionId)
      : [];
    const detail = await api.getSessionDetail(sessionId);
    const terminal =
      matches.length === 1 &&
      matches[0].status === "completed" &&
      detail &&
      detail.session &&
      detail.session.id === sessionId &&
      detail.session.status === "completed";
    return {
      ok: terminal,
      sessionId,
      matchCount: matches.length,
      terminal,
      storageRootVerified
    };
  })(${input})`;
}

async function exerciseSessionThroughCdp({
  pageWebSocketUrl,
  launchIndex,
  sessionId,
  startedAt,
  allowedStorageRoot,
  evaluateImpl = evaluatePageViaCdp,
}) {
  if (
    (launchIndex !== 1 && launchIndex !== 2) ||
    typeof sessionId !== "string" ||
    !/^smoke_[a-f0-9]{32}$/u.test(sessionId) ||
    !Number.isSafeInteger(startedAt) ||
    typeof allowedStorageRoot !== "string" ||
    !path.isAbsolute(allowedStorageRoot)
  ) {
    throw codedError(
      "PACKAGED_SESSION_PERSISTENCE_FAILED",
      "Packaged session persistence check failed"
    );
  }
  let result;
  try {
    result = await evaluateImpl(
      pageWebSocketUrl,
      rendererSessionExpression({ launchIndex, sessionId, startedAt, allowedStorageRoot })
    );
  } catch {
    throw codedError(
      "PACKAGED_SESSION_PERSISTENCE_FAILED",
      "Packaged session persistence check failed"
    );
  }
  if (
    !result ||
    result.ok !== true ||
    result.sessionId !== sessionId ||
    result.matchCount !== 1 ||
    result.terminal !== true ||
    result.storageRootVerified !== true
  ) {
    throw codedError(
      "PACKAGED_SESSION_PERSISTENCE_FAILED",
      "Packaged session persistence check failed"
    );
  }
  return { smokeId: sessionId, matchCount: 1, storageRootVerified: true };
}

function closeBrowserViaCdp(browserWebSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(browserWebSocketUrl);
    let sent = false;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("browser close timed out")), 5_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // The browser may have already closed the socket while exiting.
      }
      if (error) reject(error);
      else resolve();
    };
    socket.once("open", () => {
      sent = true;
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
    socket.on("message", (data) => {
      try {
        if (JSON.parse(String(data))?.id === 1) finish();
      } catch {
        finish(new Error("browser close response is invalid"));
      }
    });
    socket.once("close", () => (sent ? finish() : finish(new Error("browser close failed"))));
    socket.once("error", () => finish(new Error("browser close failed")));
  });
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error || !Number.isSafeInteger(port)) {
          reject(error ?? new Error("loopback port allocation failed"));
        } else {
          resolve(port);
        }
      });
    });
  });
}

function assertPackagedDatabase(fsImpl, profilePath) {
  const databasePath = path.join(profilePath, "jarvis", "jarvis.db");
  let stat;
  try {
    stat = fsImpl.statSync(databasePath);
  } catch {
    throw codedError(
      "PACKAGED_PROFILE_NOT_INITIALIZED",
      "Packaged application did not initialize its profile"
    );
  }
  if (!stat.isFile() || stat.size <= 0) {
    throw codedError(
      "PACKAGED_PROFILE_NOT_INITIALIZED",
      "Packaged application did not initialize its profile"
    );
  }
}

function sha256File(fsImpl, filePath) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = fsImpl.openSync(filePath, "r");
  try {
    let bytesRead;
    do {
      bytesRead = fsImpl.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fsImpl.closeSync(handle);
  }
  return hash.digest("hex");
}

function resolveCleanGitHead(
  execFileSyncImpl = execFileSync,
  sourceRoot = path.resolve(__dirname, "..")
) {
  try {
    const options = {
      cwd: sourceRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    };
    const commit = String(
      execFileSyncImpl("git", ["rev-parse", "--verify", "HEAD^{commit}"], options)
    ).trim();
    const status = String(
      execFileSyncImpl("git", ["status", "--porcelain=v1", "--untracked-files=all"], options)
    ).trim();
    return GIT_SHA1_PATTERN.test(commit) && status.length === 0 ? commit : null;
  } catch {
    return null;
  }
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function readArtifactBuildManifest(fsImpl, executablePath) {
  const manifestPath = path.join(path.dirname(executablePath), "resources", BUILD_MANIFEST_FILE);
  let stat;
  let manifest;
  try {
    stat = fsImpl.statSync(manifestPath);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_BUILD_MANIFEST_BYTES) throw new Error();
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, "utf8"));
  } catch {
    throw codedError(
      "PACKAGED_ARTIFACT_IDENTITY_UNAVAILABLE",
      "Packaged artifact identity is unavailable"
    );
  }
  const verification = manifest?.verification;
  const builtAt = typeof manifest?.builtAtUtc === "string" ? new Date(manifest.builtAtUtc) : null;
  if (
    !hasExactKeys(manifest, [
      "manifestVersion",
      "verification",
      "appVersion",
      "gitCommit",
      "schemaVersion",
      "builtAtUtc",
    ]) ||
    manifest.manifestVersion !== BUILD_MANIFEST_VERSION ||
    !hasExactKeys(verification, ["state", "provenance", "commitFormat", "sourceTree"]) ||
    verification.state !== "built-unverified" ||
    verification.provenance !== "git-head" ||
    verification.commitFormat !== "sha1-40" ||
    verification.sourceTree !== "clean" ||
    typeof manifest.appVersion !== "string" ||
    manifest.appVersion.length < 1 ||
    manifest.appVersion.length > 64 ||
    /[\0\r\n]/u.test(manifest.appVersion) ||
    !GIT_SHA1_PATTERN.test(manifest.gitCommit) ||
    !Number.isSafeInteger(manifest.schemaVersion) ||
    manifest.schemaVersion < 1 ||
    builtAt === null ||
    Number.isNaN(builtAt.getTime()) ||
    builtAt.toISOString() !== manifest.builtAtUtc
  ) {
    throw codedError(
      "PACKAGED_ARTIFACT_IDENTITY_UNAVAILABLE",
      "Packaged artifact identity is unavailable"
    );
  }
  return manifest;
}

function prepareRunLayout({ fsImpl, runtimeRoot }) {
  fsImpl.mkdirSync(runtimeRoot, { recursive: true });
  const canonicalRoot = fsImpl.realpathSync(runtimeRoot);
  assertRuntimeRoot(canonicalRoot, "win32");

  const runId = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runRoot = path.join(canonicalRoot, "runs", runId);
  const profilePath = path.join(runRoot, "user-data");
  fsImpl.mkdirSync(profilePath, { recursive: true });
  for (const directory of [
    path.join(runRoot, "home", "AppData", "Roaming"),
    path.join(runRoot, "home", "AppData", "Local"),
    path.join(runRoot, "temp"),
  ]) {
    fsImpl.mkdirSync(directory, { recursive: true });
  }
  return {
    runRoot,
    profilePath,
    diagnosticPath: path.join(runRoot, DIAGNOSTIC_FILE),
  };
}

async function runPackagedWindowsSmoke({
  executablePath = path.resolve(__dirname, "..", "dist", "win-unpacked", "Jarvis Memory.exe"),
  runtimeRoot,
  platform = process.platform,
  env = process.env,
  startupTimeoutMs = 45_000,
  exitTimeoutMs = 20_000,
  expectedCommit,
  fsImpl = fs,
  spawnImpl = spawn,
  allocatePort = allocateLoopbackPort,
  probeImpl = probeElectron,
  exerciseSessionImpl = exerciseSessionThroughCdp,
  closeBrowserImpl = closeBrowserViaCdp,
  resolveCleanGitHeadImpl = resolveCleanGitHead,
} = {}) {
  const safeRuntimeRoot = assertRuntimeRoot(runtimeRoot, platform);
  assertPositiveTimeout(startupTimeoutMs, "startupTimeoutMs");
  assertPositiveTimeout(exitTimeoutMs, "exitTimeoutMs");
  if (
    typeof executablePath !== "string" ||
    !path.isAbsolute(executablePath) ||
    path.extname(executablePath).toLowerCase() !== ".exe" ||
    !fsImpl.existsSync(executablePath) ||
    !fsImpl.statSync(executablePath).isFile()
  ) {
    throw codedError("PACKAGED_EXECUTABLE_NOT_FOUND", "Packaged Windows executable is unavailable");
  }
  const artifactBuild = readArtifactBuildManifest(fsImpl, executablePath);
  const artifactSha256 = sha256File(fsImpl, executablePath);
  const layout = prepareRunLayout({
    fsImpl,
    runtimeRoot: safeRuntimeRoot,
  });
  const recordDiagnostic = (entry) =>
    appendDiagnostic(fsImpl, layout.diagnosticPath, {
      ...entry,
      artifactCommit: artifactBuild.gitCommit,
    });
  recordDiagnostic({
    launch: 0,
    stage: "artifact_identity",
    code: "OK",
    exitCode: null,
  });
  const comparisonCommit =
    expectedCommit === undefined
      ? resolveCleanGitHeadImpl()
      : typeof expectedCommit === "string" && GIT_SHA1_PATTERN.test(expectedCommit)
        ? expectedCommit
        : null;
  if (comparisonCommit === null) {
    recordDiagnostic({
      launch: 0,
      stage: "artifact_expectation",
      code: "PACKAGED_EXPECTED_COMMIT_UNAVAILABLE",
      exitCode: null,
    });
    const error = codedError(
      "PACKAGED_EXPECTED_COMMIT_UNAVAILABLE",
      "Expected clean Git commit is unavailable"
    );
    error.artifactCommit = artifactBuild.gitCommit;
    error.diagnosticFile = DIAGNOSTIC_FILE;
    throw error;
  }
  if (artifactBuild.gitCommit !== comparisonCommit) {
    recordDiagnostic({
      launch: 0,
      stage: "artifact_expectation",
      code: "PACKAGED_ARTIFACT_COMMIT_MISMATCH",
      exitCode: null,
    });
    const error = codedError(
      "PACKAGED_ARTIFACT_COMMIT_MISMATCH",
      "Packaged artifact does not match the expected Git commit"
    );
    error.artifactCommit = artifactBuild.gitCommit;
    error.diagnosticFile = DIAGNOSTIC_FILE;
    throw error;
  }

  const childEnvironment = createOfflineSmokeEnvironment({
    runtimeRoot: layout.runRoot,
    env,
    platform,
  });
  const smokeSessionId = `smoke_${randomUUID().replaceAll("-", "")}`;
  const smokeStartedAt = Date.now();
  const sessionEvidence = [];

  const launchOnce = async (launchIndex) => {
    const port = await allocatePort(launchIndex);
    const args = [
      `--user-data-dir=${layout.profilePath}`,
      `--remote-debugging-port=${port}`,
      `--proxy-server=${OFFLINE_PROXY}`,
      "--proxy-bypass-list=localhost;127.0.0.1;[::1]",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
    ];
    let child;
    try {
      child = spawnImpl(executablePath, args, {
        cwd: path.dirname(executablePath),
        env: childEnvironment,
        shell: false,
        windowsHide: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      const error = codedError("PACKAGED_STARTUP_FAILED", "Packaged application failed to start");
      recordDiagnostic({
        launch: launchIndex,
        stage: "spawn",
        code: error.code,
      });
      throw error;
    }

    const output = createOutputCollector([child.stdout, child.stderr]);
    const childExit = waitForChildExit(child);
    let completed = false;
    try {
      const ready = await waitForReady({
        childExit,
        port,
        launchIndex,
        timeoutMs: startupTimeoutMs,
        probeImpl,
      });
      if (!ready) {
        const exit = childExit.result();
        const error = failureForOutput(output());
        recordDiagnostic({
          launch: launchIndex,
          stage: exit ? "early_exit" : "startup_timeout",
          code: error.code,
          exitCode: exit?.code,
        });
        throw error;
      }
      recordDiagnostic({
        launch: launchIndex,
        stage: "window_ready",
        code: "OK",
      });

      try {
        const evidence = await exerciseSessionImpl({
          pageWebSocketUrl: ready.pageWebSocketUrl,
          launchIndex,
          sessionId: smokeSessionId,
          startedAt: smokeStartedAt,
          allowedStorageRoot: layout.profilePath,
        });
        if (
          evidence?.smokeId !== smokeSessionId ||
          evidence?.matchCount !== 1 ||
          evidence?.storageRootVerified !== true
        ) {
          throw new Error("invalid session evidence");
        }
        sessionEvidence.push(evidence);
        recordDiagnostic({
          launch: launchIndex,
          stage: launchIndex === 1 ? "session_completed" : "session_restarted",
          code: "OK",
        });
      } catch {
        const error = codedError(
          "PACKAGED_SESSION_PERSISTENCE_FAILED",
          "Packaged session persistence check failed"
        );
        recordDiagnostic({
          launch: launchIndex,
          stage: launchIndex === 1 ? "session_create" : "session_restart",
          code: error.code,
        });
        throw error;
      }

      try {
        await closeBrowserImpl(ready.browserWebSocketUrl, {
          child,
          launchIndex,
        });
      } catch {
        const error = codedError(
          "PACKAGED_GRACEFUL_EXIT_FAILED",
          "Packaged application did not accept graceful exit"
        );
        recordDiagnostic({
          launch: launchIndex,
          stage: "close_request",
          code: error.code,
        });
        throw error;
      }

      const exit = await waitForExitWithin(childExit, exitTimeoutMs);
      if (!exit || exit.spawnError || exit.code !== 0 || exit.signal !== null) {
        const error =
          exit && exit.code !== 0
            ? failureForOutput(output())
            : codedError(
                "PACKAGED_GRACEFUL_EXIT_FAILED",
                "Packaged application did not exit gracefully"
              );
        recordDiagnostic({
          launch: launchIndex,
          stage: "exit",
          code: error.code,
          exitCode: exit?.code,
        });
        throw error;
      }
      completed = true;
      recordDiagnostic({
        launch: launchIndex,
        stage: "graceful_exit",
        code: "OK",
        exitCode: 0,
      });
    } finally {
      if (!completed && !childExit.isSettled()) {
        try {
          child.kill();
        } catch {
          // Best-effort cleanup is intentionally silent and never emits child diagnostics.
        }
      }
    }
  };

  try {
    await launchOnce(1);
    assertPackagedDatabase(fsImpl, layout.profilePath);
    await launchOnce(2);
    assertPackagedDatabase(fsImpl, layout.profilePath);
    return {
      ok: true,
      launches: 2,
      restarted: true,
      offline: true,
      gracefulExit: true,
      profileReused: true,
      historyPersistence: {
        smokeId: smokeSessionId,
        firstCount: sessionEvidence[0].matchCount,
        restartCount: sessionEvidence[1].matchCount,
      },
      runRoot: layout.runRoot,
      diagnosticPath: layout.diagnosticPath,
      artifactName: path.basename(executablePath),
      artifactSha256,
      artifactCommit: artifactBuild.gitCommit,
      expectedCommit: comparisonCommit,
      artifactBuild,
      assertions: {
        storageRootUnderRunProfile: sessionEvidence.every(
          (evidence) => evidence.storageRootVerified === true
        ),
        nativeDatabaseInitialized: true,
        rendererSessionCompleted: true,
        sessionPersistedAcrossRestart: true,
        persistedSessionMatchCount: sessionEvidence[1].matchCount,
        gracefulExitCount: 2,
        offlineLaunchCount: 2,
      },
    };
  } catch (error) {
    const publicError =
      typeof error?.code === "string" && error.code.startsWith("PACKAGED_")
        ? error
        : codedError("PACKAGED_SMOKE_FAILED", "Packaged Windows smoke failed");
    publicError.diagnosticFile = DIAGNOSTIC_FILE;
    publicError.artifactCommit = artifactBuild.gitCommit;
    throw publicError;
  }
}

function parseCliArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--(runtime-root|executable|expected-commit)=(.+)$/u.exec(argument);
    if (match) {
      values[match[1]] = match[2];
      continue;
    }
    if (new Set(["--runtime-root", "--executable", "--expected-commit"]).has(argument)) {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw codedError("PACKAGED_SMOKE_INPUT_INVALID", "Packaged smoke arguments are invalid");
      }
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw codedError("PACKAGED_SMOKE_INPUT_INVALID", "Packaged smoke arguments are invalid");
  }
  return {
    runtimeRoot: values["runtime-root"] ?? process.env.JARVIS_PACKAGED_SMOKE_ROOT,
    executablePath: values.executable,
    expectedCommit: values["expected-commit"],
  };
}

async function main() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.executablePath === undefined) delete options.executablePath;
    if (options.expectedCommit === undefined) delete options.expectedCommit;
    const result = await runPackagedWindowsSmoke(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        code:
          typeof error?.code === "string" && error.code.startsWith("PACKAGED_")
            ? error.code
            : "PACKAGED_SMOKE_FAILED",
        diagnosticFile:
          typeof error?.diagnosticFile === "string" ? error.diagnosticFile : undefined,
        artifactCommit: GIT_SHA1_PATTERN.test(error?.artifactCommit)
          ? error.artifactCommit
          : undefined,
      })}\n`
    );
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  allocateLoopbackPort,
  closeBrowserViaCdp,
  createOfflineSmokeEnvironment,
  evaluatePageViaCdp,
  exerciseSessionThroughCdp,
  parseCliArgs,
  probeElectron,
  readArtifactBuildManifest,
  resolveCleanGitHead,
  runPackagedWindowsSmoke,
  waitForExitWithin,
};
