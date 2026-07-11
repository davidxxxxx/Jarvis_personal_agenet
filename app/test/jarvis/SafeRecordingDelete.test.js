const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createSafeRecordingDelete } = require("../../src/jarvis/main/SafeRecordingDelete");

const helperDir = path.resolve(__dirname, "../../src/jarvis/native/windows");

test("non-Windows batch deletion is explicitly unsupported", async () => {
  let spawned = false;
  const deleteFile = createSafeRecordingDelete({
    platform: "linux",
    spawnImpl: () => {
      spawned = true;
    },
  });

  assert.deepEqual(await deleteFile("/recordings", ["/recordings/a.wav"]), [
    { status: "unsupported", code: "platform_unsupported" },
  ]);
  assert.equal(spawned, false);
});

test("Windows helper uses trusted System32 PowerShell and JSON stdin without interpolation", async () => {
  const calls = [];
  const deleteFile = createSafeRecordingDelete({
    platform: "win32",
    helperDir,
    systemRoot: String.raw`C:\Windows`,
    spawnImpl: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stdin = {
        end(input) {
          calls.push({ command, args, options, input });
          queueMicrotask(() => {
            child.stdout.emit("data", '[{"status":"deleted","code":"deleted"}]');
            child.emit("close", 0);
          });
        },
      };
      child.kill = () => {};
      return child;
    },
  });
  const root = String.raw`C:\recordings & echo unsafe`;
  const target = String.raw`C:\recordings & echo unsafe\a.wav`;

  assert.deepEqual(await deleteFile(root, [target]), [
    { status: "deleted", code: "deleted" },
  ]);
  assert.equal(
    calls[0].command.toLowerCase(),
    String.raw`c:\windows\system32\windowspowershell\v1.0\powershell.exe`
  );
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.at(-1), path.join(helperDir, "delete-recording-safe.ps1"));
  assert.deepEqual(JSON.parse(calls[0].input), { root, paths: [target] });
});

test("Windows handle validation refuses an ancestor junction outside the recording root", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only handle semantics");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-delete-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-outside-"));
  const link = path.join(root, "session");
  const outsideFile = path.join(outside, "outside.wav");
  fs.writeFileSync(outsideFile, "outside");
  fs.symlinkSync(outside, link, "junction");

  try {
    const [result] = await createSafeRecordingDelete({ platform: "win32", helperDir })(
      root,
      [path.join(link, "outside.wav")]
    );
    assert.deepEqual(result, { status: "outside", code: "handle_outside_root" });
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "outside");
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Windows deletion remains bound to the opened file during a final-path swap", (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only handle semantics");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-race-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-race-outside-"));
  const session = path.join(root, "session");
  const moved = path.join(session, "capture-original.wav");
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session, "capture.wav"), "inside");
  fs.writeFileSync(path.join(outside, "capture.wav"), "outside");

  const { spawnSync } = require("node:child_process");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "fixtures", "safe-delete-race.ps1"),
      helperDir,
      root,
      path.join(session, "capture.wav"),
      session,
      moved,
      outside,
    ],
    { encoding: "utf8", shell: false, windowsHide: true }
  );

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      status: "deleted",
      code: "deleted",
    });
    assert.equal(fs.existsSync(moved), false);
    assert.equal(fs.readFileSync(path.join(session, "capture.wav"), "utf8"), "outside");
    assert.equal(fs.readFileSync(path.join(outside, "capture.wav"), "utf8"), "outside");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Windows safely deletes a final reparse point without deleting its target", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only handle semantics");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-safe-link-outside-"));
  const target = path.join(outside, "outside.wav");
  const link = path.join(root, "link.wav");
  fs.writeFileSync(target, "outside");
  try {
    fs.symlinkSync(target, link, "file");
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    return t.skip(`file symlink unavailable: ${error.code}`);
  }

  try {
    const [result] = await createSafeRecordingDelete({ platform: "win32", helperDir })(root, [link]);
    assert.deepEqual(result, { status: "deleted", code: "deleted" });
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(target, "utf8"), "outside");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a missing recordings root returns one safe-missing row per path", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only helper semantics");
  const root = path.join(os.tmpdir(), `jarvis-missing-root-${Date.now()}`);
  const rows = await createSafeRecordingDelete({ platform: "win32", helperDir })(root, [
    path.join(root, "one.wav"),
    path.join(root, "two.wav"),
  ]);
  assert.deepEqual(rows, [
    { status: "missing", code: "root_not_found" },
    { status: "missing", code: "root_not_found" },
  ]);
});
