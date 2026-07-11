const assert = require("node:assert/strict");
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
