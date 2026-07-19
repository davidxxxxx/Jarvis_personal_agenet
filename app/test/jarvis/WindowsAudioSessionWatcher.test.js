const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const WindowsAudioSessionWatcher = require("../../src/helpers/windowsAudioSessionWatcher");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => setImmediate(() => child.emit("exit", 0, null)) };
  child.kill = () => child.emit("exit", 0, null);
  return child;
}

test("watcher normalizes active PIDs, merges processes by app, and omits private process metadata", async () => {
  const child = fakeChild();
  const spawns = [];
  const events = [];
  const watcher = new WindowsAudioSessionWatcher({
    platform: "win32",
    processId: 99,
    resolveBinary: () => "G:\\Jarvis\\windows-system-audio-helper.exe",
    capabilityProvider: async () => ({
      available: true,
      supportsApplicationCapture: true,
      supportsSessionWatch: true,
      windowsBuild: 22631,
      minimumWindowsBuild: 20348,
    }),
    spawnImpl(command, args, options) {
      spawns.push({ command, args, options });
      return child;
    },
    processList: async () => [
      { pid: 101, name: "chrome.exe", cmd: "C:\\private\\chrome.exe --profile secret" },
      { pid: 102, name: "chrome.exe", cmd: "C:\\private\\chrome.exe --type renderer" },
      { pid: 103, name: "KOOK.exe", cmd: "C:\\private\\kook.exe" },
    ],
    onSession: (event) => events.push(event),
  });

  const started = watcher.start();
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit("data", Buffer.from('{"type":"ready","windowsBuild":22631}\n'));
  await started;
  child.stdout.emit(
    "data",
    Buffer.from(
      '{"type":"session","state":"active","pid":101,"peak":0.2}\n' +
        '{"type":"session","state":"active","pid":102,"peak":0.4}\n' +
        '{"type":"session","state":"active","pid":103,"peak":0.3}\n'
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(spawns[0].args, ["watch-sessions", "--exclude-pid", "99"]);
  assert.deepEqual(
    events.map((event) => ({
      state: event.state,
      pid: event.pid,
      applicationKey: event.applicationKey,
      applicationDisplayName: event.applicationDisplayName,
      peak: event.peak,
    })),
    [
      {
        state: "active",
        pid: 101,
        applicationKey: "chrome",
        applicationDisplayName: "Chrome",
        peak: 0.2,
      },
      {
        state: "active",
        pid: 102,
        applicationKey: "chrome",
        applicationDisplayName: "Chrome",
        peak: 0.4,
      },
      {
        state: "active",
        pid: 103,
        applicationKey: "kook",
        applicationDisplayName: "KOOK",
        peak: 0.3,
      },
    ]
  );
  assert.equal(JSON.stringify(events).includes("private"), false);
  assert.equal(JSON.stringify(events).includes("cmd"), false);
  await watcher.stop();
});

test("watcher fails closed on unsupported builds and does not enter a restart loop", async () => {
  let spawnCount = 0;
  const watcher = new WindowsAudioSessionWatcher({
    platform: "win32",
    resolveBinary: () => "G:\\Jarvis\\windows-system-audio-helper.exe",
    spawnImpl() {
      spawnCount += 1;
      return fakeChild();
    },
    capabilityProvider: async () => ({
      available: true,
      supportsApplicationCapture: false,
      supportsSessionWatch: false,
      windowsBuild: 19045,
      minimumWindowsBuild: 20348,
    }),
  });

  await assert.rejects(() => watcher.start(), /Windows build 20348/);
  await assert.rejects(() => watcher.start(), /Windows build 20348/);
  assert.equal(spawnCount, 0);
});
