const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const {
  createOfflineSmokeEnvironment,
  evaluatePageViaCdp,
  exerciseSessionThroughCdp,
  probeElectron,
  runPackagedWindowsSmoke,
  waitForExitWithin,
} = require("../../scripts/packaged-windows-smoke");

const appRoot = path.resolve(__dirname, "../..");
const testRootBase = path.resolve(appRoot, "..", "..", ".runtime-cache", "packaged-smoke-tests");

function makeTestRoot(name) {
  fs.mkdirSync(testRootBase, { recursive: true });
  const root = path.join(testRootBase, `${name}-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.signalCode = "SIGTERM";
      child.emit("exit", null, "SIGTERM");
    }
    return true;
  };
  return child;
}

test("packaged smoke launches offline twice with one isolated G: profile and graceful exits", async (t) => {
  const runtimeRoot = makeTestRoot("success");
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const executablePath = path.join(runtimeRoot, "Jarvis Memory.exe");
  fs.writeFileSync(executablePath, "fixture");

  const launches = [];
  const children = [];
  const sessionChecks = [];
  const profileEntriesAtLaunch = [];
  const gitCommit = "7356b3bbff883bbfb5fad49bb69bd2fa381deb7c";
  const result = await runPackagedWindowsSmoke({
    executablePath,
    runtimeRoot,
    platform: "win32",
    env: {
      PATH: process.env.PATH,
      MINIMAX_API_KEY: "sk-cp-private",
      OPENAI_API_KEY: "sk-private",
      USERPROFILE: String.raw`C:\Users\private`,
      TEMP: String.raw`C:\private-temp`,
      JARVIS_DATA_ROOT: String.raw`C:\unsafe-data`,
      JARVIS_DATA_DIR: String.raw`C:\unsafe-data-dir`,
      JARVIS_RECORDINGS_DIR: String.raw`C:\unsafe-recordings`,
      JARVIS_STORAGE_ROOT: String.raw`C:\unsafe-storage`,
    },
    gitCommit,
    allocatePort: async (index) => 48_000 + index,
    spawnImpl(command, args, options) {
      const child = fakeChild(9_000 + launches.length);
      children.push(child);
      launches.push({ command, args, options });
      const profileArg = args.find((entry) => entry.startsWith("--user-data-dir="));
      const profilePath = profileArg.slice("--user-data-dir=".length);
      profileEntriesAtLaunch.push(fs.readdirSync(profilePath).sort());
      const databasePath = path.join(profilePath, "jarvis", "jarvis.db");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(databasePath, "sqlite fixture");
      return child;
    },
    probeImpl: async ({ port }) => ({
      browserWebSocketUrl: `ws://127.0.0.1:${port}/devtools/browser/safe`,
      pageWebSocketUrl: `ws://127.0.0.1:${port}/devtools/page/safe`,
      pageCount: 2,
    }),
    exerciseSessionImpl: async (input) => {
      sessionChecks.push(input);
      return {
        smokeId: input.sessionId,
        matchCount: 1,
        storageRootVerified: true,
      };
    },
    closeBrowserImpl: async (_url, { launchIndex }) => {
      const child = children[launchIndex - 1];
      child.exitCode = 0;
      child.emit("exit", 0, null);
    },
  });

  assert.deepEqual(result, {
    ok: true,
    launches: 2,
    restarted: true,
    offline: true,
    gracefulExit: true,
    profileReused: true,
    historyPersistence: {
      smokeId: sessionChecks[0].sessionId,
      firstCount: 1,
      restartCount: 1,
    },
    runRoot: path.dirname(result.diagnosticPath),
    diagnosticPath: result.diagnosticPath,
    artifactName: "Jarvis Memory.exe",
    artifactSha256: createHash("sha256").update("fixture").digest("hex"),
    gitCommit,
    assertions: {
      storageRootUnderRunProfile: true,
      nativeDatabaseInitialized: true,
      rendererSessionCompleted: true,
      sessionPersistedAcrossRestart: true,
      persistedSessionMatchCount: 1,
      gracefulExitCount: 2,
      offlineLaunchCount: 2,
    },
  });
  assert.match(result.runRoot, /^G:\\/iu);
  assert.match(result.diagnosticPath, /^G:\\/iu);
  assert.deepEqual(profileEntriesAtLaunch[0], []);
  assert.deepEqual(profileEntriesAtLaunch[1], ["jarvis"]);
  assert.equal(launches.length, 2);
  assert.deepEqual(
    sessionChecks.map(({ launchIndex, pageWebSocketUrl, sessionId, allowedStorageRoot }) => ({
      launchIndex,
      pageWebSocketUrl,
      sessionId,
      allowedStorageRoot,
    })),
    [
      {
        launchIndex: 1,
        pageWebSocketUrl: "ws://127.0.0.1:48001/devtools/page/safe",
        sessionId: sessionChecks[0].sessionId,
        allowedStorageRoot: sessionChecks[0].allowedStorageRoot,
      },
      {
        launchIndex: 2,
        pageWebSocketUrl: "ws://127.0.0.1:48002/devtools/page/safe",
        sessionId: sessionChecks[0].sessionId,
        allowedStorageRoot: sessionChecks[0].allowedStorageRoot,
      },
    ]
  );
  assert.match(sessionChecks[0].sessionId, /^smoke_[a-f0-9]{32}$/u);
  assert.match(sessionChecks[0].allowedStorageRoot, /^G:\\/iu);
  const firstProfileArg = launches[0].args.find((entry) => entry.startsWith("--user-data-dir="));
  const secondProfileArg = launches[1].args.find((entry) => entry.startsWith("--user-data-dir="));
  assert.equal(firstProfileArg, secondProfileArg);
  assert.match(firstProfileArg, /^--user-data-dir=G:\\/iu);
  for (const [index, launch] of launches.entries()) {
    assert.equal(launch.command, executablePath);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.windowsHide, false);
    assert.equal(launch.args.includes(`--remote-debugging-port=${48_001 + index}`), true);
    assert.equal(launch.args.includes("--proxy-server=http://127.0.0.1:9"), true);
    assert.equal(
      launch.args.some((entry) => entry.startsWith("--host-resolver-rules=")),
      true
    );
    assert.equal("MINIMAX_API_KEY" in launch.options.env, false);
    assert.equal("OPENAI_API_KEY" in launch.options.env, false);
    assert.equal(launch.options.env.JARVIS_RECORDINGS_DIR, "");
    assert.match(launch.options.env.JARVIS_DATA_ROOT, /^G:\\/iu);
    assert.match(launch.options.env.JARVIS_DATA_DIR, /^G:\\/iu);
    assert.equal("JARVIS_STORAGE_ROOT" in launch.options.env, false);
    for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"]) {
      assert.match(launch.options.env[name], /^G:\\/iu, name);
    }
  }
});

test("Electron probe returns the renderer page WebSocket URL", async () => {
  const responses = new Map([
    ["/json/version", { webSocketDebuggerUrl: "ws://127.0.0.1:48101/devtools/browser/browser-id" }],
    [
      "/json/list",
      [
        {
          type: "page",
          url: "file:///safe/index.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:48101/devtools/page/page-id",
        },
        {
          type: "service_worker",
          webSocketDebuggerUrl: "ws://127.0.0.1:48101/devtools/page/ignored",
        },
      ],
    ],
  ]);

  const result = await probeElectron({
    port: 48_101,
    httpJsonImpl: async (_port, requestPath) => responses.get(requestPath),
  });

  assert.deepEqual(result, {
    browserWebSocketUrl: "ws://127.0.0.1:48101/devtools/browser/browser-id",
    pageWebSocketUrl: "ws://127.0.0.1:48101/devtools/page/page-id",
    pageCount: 1,
  });
});

test("page CDP evaluation awaits and returns a renderer value", async () => {
  const requests = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      setImmediate(() => this.emit("open"));
    }

    send(message) {
      const request = JSON.parse(message);
      requests.push(request);
      setImmediate(() =>
        this.emit(
          "message",
          JSON.stringify({
            id: request.id,
            result: { result: { type: "object", value: { ok: true, matchCount: 1 } } },
          })
        )
      );
    }

    close() {}
  }

  const result = await evaluatePageViaCdp(
    "ws://127.0.0.1:48102/devtools/page/page-id",
    "Promise.resolve({ ok: true, matchCount: 1 })",
    { WebSocketImpl: FakeWebSocket, timeoutMs: 1_000 }
  );

  assert.deepEqual(result, { ok: true, matchCount: 1 });
  assert.deepEqual(requests, [
    {
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: "Promise.resolve({ ok: true, matchCount: 1 })",
        awaitPromise: true,
        returnByValue: true,
      },
    },
  ]);
});

test("renderer public API creates one completed smoke session then finds it after restart", async () => {
  const smokeId = "smoke_0123456789abcdef0123456789abcdef";
  const calls = [];
  const first = await exerciseSessionThroughCdp({
    pageWebSocketUrl: "ws://127.0.0.1:48103/devtools/page/first",
    launchIndex: 1,
    sessionId: smokeId,
    startedAt: 1_000,
    allowedStorageRoot: String.raw`G:\Jarvis\.runtime-cache\run\user-data`,
    evaluateImpl: async (url, expression) => {
      calls.push({ url, expression });
      return {
        ok: true,
        sessionId: smokeId,
        matchCount: 1,
        terminal: true,
        storageRootVerified: true,
      };
    },
  });
  const restarted = await exerciseSessionThroughCdp({
    pageWebSocketUrl: "ws://127.0.0.1:48104/devtools/page/second",
    launchIndex: 2,
    sessionId: smokeId,
    startedAt: 1_000,
    allowedStorageRoot: String.raw`G:\Jarvis\.runtime-cache\run\user-data`,
    evaluateImpl: async (url, expression) => {
      calls.push({ url, expression });
      return {
        ok: true,
        sessionId: smokeId,
        matchCount: 1,
        terminal: true,
        storageRootVerified: true,
      };
    },
  });

  assert.deepEqual(first, { smokeId, matchCount: 1, storageRootVerified: true });
  assert.deepEqual(restarted, { smokeId, matchCount: 1, storageRootVerified: true });
  assert.match(calls[0].expression, /window\.electronAPI\.jarvis/u);
  assert.match(calls[0].expression, /\.getStorageStatus\(/u);
  assert.match(calls[0].expression, /\.createSession\(/u);
  assert.match(calls[0].expression, /\.startCapture\(/u);
  assert.match(calls[0].expression, /\.finishCapture\(/u);
  assert.match(calls[0].expression, /\.listSessions\(/u);
  assert.match(calls[0].expression, /\.getSessionDetail\(/u);
  assert.doesNotMatch(calls[1].expression, /\.createSession\(/u);
  assert.match(calls[1].expression, /\.listSessions\(/u);
  assert.match(calls[1].expression, /\.getSessionDetail\(/u);
});

test("renderer storage assertion fails closed before accepting session evidence", async () => {
  await assert.rejects(
    exerciseSessionThroughCdp({
      pageWebSocketUrl: "ws://127.0.0.1:48105/devtools/page/unsafe",
      launchIndex: 1,
      sessionId: "smoke_0123456789abcdef0123456789abcdef",
      startedAt: 1_000,
      allowedStorageRoot: String.raw`G:\Jarvis\.runtime-cache\run\user-data`,
      evaluateImpl: async () => ({
        ok: true,
        sessionId: "smoke_0123456789abcdef0123456789abcdef",
        matchCount: 1,
        terminal: true,
        storageRootVerified: false,
      }),
    }),
    (error) => {
      assert.equal(error.code, "PACKAGED_SESSION_PERSISTENCE_FAILED");
      assert.equal(error.message, "Packaged session persistence check failed");
      return true;
    }
  );
});

test("offline smoke environment removes inherited secrets and redirects writable homes", () => {
  const runtimeRoot = String.raw`G:\Jarvis\.runtime-cache\packaged-smoke\run`;
  const environment = createOfflineSmokeEnvironment({
    runtimeRoot,
    env: {
      PATH: "trusted-path",
      MINIMAX_API_KEY: "sk-cp-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      GOOGLE_APPLICATION_CREDENTIALS: String.raw`C:\private.json`,
      CSC_LINK: "certificate",
      BEDROCK_ACCESS_KEY_ID: "bedrock-access",
      CORTI_CLIENT_ID: "corti-client",
      DICTATION_KEY: "dictation-hotkey-secret",
      BEDROCK_REGION: "us-east-1",
      CORTI_REGION: "eu",
      DICTATION_KEYBOARD_LAYOUT: "us",
      TEMP: String.raw`C:\temp`,
      JARVIS_DATA_ROOT: String.raw`C:\unsafe-data`,
      JARVIS_DATA_DIR: String.raw`C:\unsafe-data-dir`,
      JARVIS_RECORDINGS_DIR: String.raw`C:\unsafe-recordings`,
      JARVIS_STORAGE_ROOT: String.raw`C:\unsafe-storage`,
    },
    platform: "win32",
  });

  assert.equal(environment.PATH, "trusted-path");
  for (const name of [
    "MINIMAX_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CSC_LINK",
    "BEDROCK_ACCESS_KEY_ID",
    "CORTI_CLIENT_ID",
    "DICTATION_KEY",
  ]) {
    assert.equal(name in environment, false, name);
  }
  assert.equal(environment.BEDROCK_REGION, "us-east-1");
  assert.equal(environment.CORTI_REGION, "eu");
  assert.equal(environment.DICTATION_KEYBOARD_LAYOUT, "us");
  assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:9");
  assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:9");
  assert.equal(environment.ALL_PROXY, "http://127.0.0.1:9");
  assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1");
  assert.equal(environment.JARVIS_RECORDINGS_DIR, "");
  assert.match(environment.JARVIS_DATA_ROOT, /^G:\\/iu);
  assert.match(environment.JARVIS_DATA_DIR, /^G:\\/iu);
  assert.equal("JARVIS_STORAGE_ROOT" in environment, false);
  for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP"]) {
    assert.match(environment[name], /^G:\\/iu, name);
  }
});

test("packaged smoke fails closed when the Git commit cannot be identified", async (t) => {
  const runtimeRoot = makeTestRoot("missing-commit");
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const executablePath = path.join(runtimeRoot, "Jarvis Memory.exe");
  fs.writeFileSync(executablePath, "fixture");
  let spawnCalls = 0;

  await assert.rejects(
    runPackagedWindowsSmoke({
      executablePath,
      runtimeRoot,
      platform: "win32",
      gitCommit: null,
      spawnImpl() {
        spawnCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "PACKAGED_ARTIFACT_IDENTITY_UNAVAILABLE");
      assert.equal(error.message, "Packaged artifact identity is unavailable");
      return true;
    }
  );
  assert.equal(spawnCalls, 0);
});

test("release matrix limits packaged restart to a fresh profile session persistence gate", () => {
  const acceptance = fs.readFileSync(
    path.resolve(appRoot, "..", "docs", "testing", "jarvis-phase4-release-acceptance.md"),
    "utf8"
  );

  assert.match(
    acceptance,
    /PACKAGED_RESTART\s+\|\s+Fresh isolated-profile real session persistence, reopen, and no-duplicate smoke/u
  );
  assert.match(
    acceptance,
    /LEGACY_FIXTURE[\s\S]*full legacy and migration acceptance remains blocked on this gate/u
  );
  assert.doesNotMatch(acceptance, /copied-profile restart harness|disposable copied profile/iu);
  assert.doesNotMatch(
    acceptance,
    /Restart acceptance must[\s\S]*transcripts, summaries, people, topics, todos, memories/iu
  );
});

test("packaged native binding startup failures retain only safe diagnostics", async (t) => {
  const runtimeRoot = makeTestRoot("native-failure");
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const executablePath = path.join(runtimeRoot, "Jarvis Memory.exe");
  fs.writeFileSync(executablePath, "fixture");
  const secret = "sk-cp-private-native-secret";
  const privatePath = String.raw`C:\Users\private\better_sqlite3.node`;

  await assert.rejects(
    runPackagedWindowsSmoke({
      executablePath,
      runtimeRoot,
      platform: "win32",
      allocatePort: async () => 49_001,
      spawnImpl() {
        const child = fakeChild(9_101);
        setImmediate(() => {
          child.stderr.write(
            `Could not locate the bindings file ${privatePath} ${secret} NODE_MODULE_VERSION 137`
          );
          child.exitCode = 1;
          child.emit("exit", 1, null);
        });
        return child;
      },
      probeImpl: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("not ready");
      },
    }),
    (error) => {
      assert.equal(error.code, "PACKAGED_NATIVE_BINDING_LOAD_FAILED");
      assert.equal(error.message, "Packaged native binding failed to load");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(privatePath), false);
      assert.match(error.diagnosticFile, /^[A-Za-z0-9_.-]+$/u);
      return true;
    }
  );

  const runDirectories = fs.readdirSync(path.join(runtimeRoot, "runs"));
  assert.equal(runDirectories.length, 1);
  const diagnostics = fs.readFileSync(
    path.join(runtimeRoot, "runs", runDirectories[0], "packaged-smoke.jsonl"),
    "utf8"
  );
  assert.match(diagnostics, /PACKAGED_NATIVE_BINDING_LOAD_FAILED/u);
  assert.equal(diagnostics.includes(secret), false);
  assert.equal(diagnostics.includes(privatePath), false);
  assert.equal(diagnostics.includes("C:\\Users"), false);
});

test("packaged smoke rejects C: runtime storage before spawning", async () => {
  let spawnCalls = 0;
  await assert.rejects(
    runPackagedWindowsSmoke({
      executablePath: String.raw`G:\Jarvis\app\dist\win-unpacked\Jarvis Memory.exe`,
      runtimeRoot: String.raw`C:\Users\private\jarvis-smoke`,
      platform: "win32",
      fsImpl: {
        existsSync: () => true,
        statSync: () => ({ isFile: () => true }),
      },
      spawnImpl() {
        spawnCalls += 1;
      },
    }),
    (error) => {
      assert.equal(error.code, "PACKAGED_SMOKE_UNSAFE_STORAGE");
      assert.equal(error.message, "Packaged smoke storage must not use the system drive");
      return true;
    }
  );
  assert.equal(spawnCalls, 0);
});

test("package exposes an explicit unpacked Windows smoke command", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["smoke:win:unpacked"], "node scripts/packaged-windows-smoke.js");
});

test("successful child exit clears the graceful-exit timeout handle", async () => {
  let cleared = null;
  const timer = { id: "exit-timeout" };
  const result = await waitForExitWithin(
    { promise: Promise.resolve({ code: 0, signal: null, spawnError: false }) },
    20_000,
    {
      setTimeoutImpl: () => timer,
      clearTimeoutImpl: (value) => {
        cleared = value;
      },
    }
  );

  assert.deepEqual(result, { code: 0, signal: null, spawnError: false });
  assert.equal(cleared, timer);
});
