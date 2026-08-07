const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const updaterPath = path.resolve(__dirname, "../../src/updater.js");

test("missing optional updater dependencies cannot block application startup", async () => {
  const originalLoad = Module._load;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalError = console.error;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron-updater") {
      const error = new Error("Cannot find module 'universalify'");
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.NODE_ENV = "production";
  console.error = () => {};
  delete require.cache[updaterPath];

  try {
    const UpdateManager = require(updaterPath);
    const manager = new UpdateManager();
    const result = await manager.checkForUpdates();

    assert.deepEqual(result, {
      updateAvailable: false,
      message: "Automatic updates are unavailable in this build",
    });
    manager.checkForUpdatesOnStartup();
    manager.cleanup();
  } finally {
    delete require.cache[updaterPath];
    Module._load = originalLoad;
    console.error = originalError;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("Jarvis updater owns its feed and treats an empty release channel as not available", async () => {
  const originalLoad = Module._load;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalError = console.error;
  const originalLog = console.log;
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const updater = new EventEmitter();
  const nativeUpdater = new EventEmitter();
  let feed = null;
  let scheduledStartupCheck = null;
  const errors = [];

  updater.setFeedURL = (value) => {
    feed = value;
  };
  updater.checkForUpdates = () => {
    const error = new Error("No published versions on GitHub");
    error.code = "ERR_UPDATER_NO_PUBLISHED_VERSIONS";
    updater.emit("error", error);
    return Promise.reject(error);
  };
  updater.removeListener = EventEmitter.prototype.removeListener.bind(updater);

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron-updater") return { autoUpdater: updater };
    if (request === "electron") return { autoUpdater: nativeUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  process.env.NODE_ENV = "production";
  console.error = (...args) => errors.push(args);
  console.log = () => {};
  global.setTimeout = (callback) => {
    scheduledStartupCheck = callback;
    return 1;
  };
  global.setInterval = () => 2;
  global.clearInterval = () => {};
  delete require.cache[updaterPath];

  try {
    const UpdateManager = require(updaterPath);
    const manager = new UpdateManager();

    assert.deepEqual(feed, {
      provider: "github",
      owner: "davidxxxxx",
      repo: "Jarvis_personal_agenet",
      private: false,
    });

    manager.checkForUpdatesOnStartup();
    assert.equal(typeof scheduledStartupCheck, "function");
    scheduledStartupCheck();
    await new Promise((resolve) => originalSetTimeout(resolve, 0));

    assert.equal(errors.length, 0);
    assert.deepEqual(await manager.checkForUpdates(), {
      updateAvailable: false,
      message: "No Jarvis updates have been published yet",
    });
    assert.equal(errors.length, 0);
    manager.cleanup();
  } finally {
    delete require.cache[updaterPath];
    Module._load = originalLoad;
    console.error = originalError;
    console.log = originalLog;
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});
