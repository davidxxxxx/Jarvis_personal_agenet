const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const WindowsLoopbackAudioManager = require("../../src/helpers/windowsLoopbackAudioManager");

const appRoot = path.resolve(__dirname, "..", "..");

test("native helper declares include-process capture and audio-session watch without title/path APIs", () => {
  const source = fs.readFileSync(
    path.join(appRoot, "resources", "windows-system-audio-helper.c"),
    "utf8"
  );
  assert.match(source, /PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE/);
  assert.match(source, /--include-pid/);
  assert.match(source, /watch-sessions/);
  assert.match(source, /IAudioSessionManager2_GetSessionEnumerator/);
  assert.match(source, /GetProcessId/);
  assert.doesNotMatch(source, /GetWindowText|windowTitle|processPath|commandLine/);
});
test("loopback manager builds disjoint mixed and application process-tree arguments", () => {
  const manager = new WindowsLoopbackAudioManager({
    platform: "win32",
    processId: 4321,
  });
  assert.deepEqual(manager._buildStartArgs({ mode: "mixed" }), [
    "start",
    "--exclude-pid",
    "4321",
    "--sample-rate",
    "24000",
  ]);
  assert.deepEqual(manager._buildStartArgs({ mode: "application", targetPid: 9876 }), [
    "start",
    "--include-pid",
    "9876",
    "--sample-rate",
    "24000",
  ]);
  assert.throws(
    () => manager._buildStartArgs({ mode: "application", targetPid: 0 }),
    /targetPid/
  );
});

test("capability projection distinguishes mixed capture from application capture", async () => {
  const manager = new WindowsLoopbackAudioManager({ platform: "win32" });
  manager.resolveBinary = () => "G:\\Jarvis\\helper.exe";
  manager._runJsonCommand = async () => ({
    ok: true,
    supportsSystemAudio: true,
    supportsApplicationCapture: true,
    supportsSessionWatch: true,
    minimumWindowsBuild: 20348,
    windowsBuild: 22631,
    source: "wasapi-process-loopback",
  });

  assert.deepEqual(await manager.getCapability({ force: true }), {
    available: true,
    supportsApplicationCapture: true,
    supportsSessionWatch: true,
    minimumWindowsBuild: 20348,
    windowsBuild: 22631,
    source: "wasapi-process-loopback",
    error: null,
  });
});
