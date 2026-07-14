const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const { DirectoryLeaseProvider } = require("../../src/jarvis/main/DirectoryLease");

function windowsHelperCount(parentProcessId = null) {
  if (process.platform !== "win32") return 0;
  const raw = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      String.raw`@(
        Get-CimInstance Win32_Process |
          Where-Object {
            $_.ProcessId -ne $PID -and
            (${parentProcessId === null ? "$true" : `$_.ParentProcessId -eq ${parentProcessId}`}) -and
            $_.CommandLine -match '-File.+directory-lease-helper\.ps1'
          }
      ).Count`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000 }
  );
  return Number(String(raw).trim());
}

async function waitForHelperCount(expected, parentProcessId = null) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (windowsHelperCount(parentProcessId) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(windowsHelperCount(parentProcessId), expected);
}

test("holds a production directory object until explicit release", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-directory-lease-"));
  let lease = null;
  t.after(async () => {
    await lease?.release().catch(() => {});
    await fsp.rm(base, { recursive: true, force: true });
  });
  const leasedPath = path.join(base, "quoted ' ; directory");
  const movedPath = path.join(base, "moved");
  await fsp.mkdir(leasedPath);
  const provider = new DirectoryLeaseProvider();

  lease = await provider.acquire(leasedPath);
  assert.match(lease.identity, /^(win32:[0-9a-f]+:[0-9a-f]+|posix:\d+:\d+)$/);
  if (process.platform === "win32") {
    await assert.rejects(fsp.rename(leasedPath, movedPath), (error) =>
      ["EPERM", "EACCES", "EBUSY"].includes(error?.code)
    );
  }
  lease.assertActive();
  await lease.release();
  assert.throws(() => lease.assertActive(), /directory lease is not active/);
  lease = null;
  await fsp.rename(leasedPath, movedPath);
});

test("creates and leases a Windows directory in one atomic operation", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows atomic directory creation test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-directory-create-lease-"));
  const created = path.join(base, "created");
  const moved = path.join(base, "moved");
  const baseline = windowsHelperCount();
  let lease = null;
  t.after(async () => {
    await lease?.release().catch(() => {});
    await waitForHelperCount(baseline).catch(() => {});
    await fsp.rm(base, { recursive: true, force: true });
  });
  const provider = new DirectoryLeaseProvider();

  lease = await provider.createAndAcquire(created);
  assert.equal((await fsp.lstat(created)).isDirectory(), true);
  await assert.rejects(fsp.rename(created, moved), (error) =>
    ["EPERM", "EACCES", "EBUSY"].includes(error?.code)
  );
  await lease.release();
  lease = null;
  await fsp.rename(created, moved);
  await waitForHelperCount(baseline);
});

test("platform-injected POSIX lease serializes real dev and ino identity", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-posix-directory-lease-"));
  let lease = null;
  t.after(async () => {
    await lease?.release().catch(() => {});
    await fsp.rm(base, { recursive: true, force: true });
  });
  const stat = await fsp.lstat(base);
  lease = await new DirectoryLeaseProvider({ platform: "linux" }).acquire(base);

  assert.equal(lease.identity, `posix:${String(stat.dev)}:${String(stat.ino)}`);
  await lease.assertCurrent();
  await lease.release();
  lease = null;
});

test("fails closed when the Windows helper cannot establish an authoritative handle", async () => {
  const provider = new DirectoryLeaseProvider({
    platform: "win32",
    spawnImpl() {
      throw new Error("helper unavailable");
    },
  });

  await assert.rejects(provider.acquire("C:\\private"), /directory lease acquisition failed/);
});

test("rejects Windows helper metadata for a regular file", async () => {
  const child = new EventEmitter();
  child.pid = 4241;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.end = () => {
    child.exitCode = 0;
    child.emit("close", 0, null);
  };
  const provider = new DirectoryLeaseProvider({
    platform: "win32",
    spawnImpl() {
      queueMicrotask(() =>
        child.stdout.write(
          '{"volumeSerial":"1234abcd","fileId":"0123456789abcdef","attributes":0}\n'
        )
      );
      return child;
    },
    async terminateChildTree() {
      child.exitCode = 1;
      child.signalCode = "SIGKILL";
      child.emit("close", 1, "SIGKILL");
    },
  });

  await assert.rejects(
    provider.acquire("C:\\private\\regular.bin"),
    /directory lease acquisition failed/
  );
  assert.equal(child.exitCode, 1);
});

test("acquisition timeout reaps the Windows helper and leaves no matching process", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows helper lifecycle test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-directory-timeout-"));
  t.after(async () => fsp.rm(base, { recursive: true, force: true }));
  const baseline = windowsHelperCount();
  const provider = new DirectoryLeaseProvider({ timeoutMs: 1 });

  await assert.rejects(provider.acquire(base), /directory lease acquisition failed/);
  await waitForHelperCount(baseline);
});

test("release waits for a delayed clean helper exit and removes readiness listeners", async (t) => {
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  let exitTimer = null;
  t.after(async () => {
    if (exitTimer !== null) clearTimeout(exitTimer);
    if (child.exitCode === null) {
      child.exitCode = 0;
      child.emit("close", 0, null);
    }
  });
  child.stdin.end = () => {
    exitTimer = setTimeout(() => {
      child.exitCode = 0;
      child.emit("close", 0, null);
    }, 30);
  };
  const provider = new DirectoryLeaseProvider({
    platform: "win32",
    timeoutMs: 250,
    spawnImpl() {
      queueMicrotask(() =>
        child.stdout.write(
          '{"volumeSerial":"1234abcd","fileId":"0123456789abcdef","attributes":16}\n'
        )
      );
      return child;
    },
  });
  let lease = null;
  t.after(async () => lease?.release().catch(() => {}));

  lease = await provider.acquire("C:\\private");
  assert.equal(child.stdout.listenerCount("data"), 0);
  const startedAt = Date.now();
  await lease.release();
  assert.ok(Date.now() - startedAt >= 20);
  lease = null;
});

test("release timeout terminates the complete helper tree and awaits its exit", async (t) => {
  const child = new EventEmitter();
  child.pid = 4243;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdin.end = () => {};
  let terminated = false;
  const provider = new DirectoryLeaseProvider({
    platform: "win32",
    timeoutMs: 20,
    spawnImpl() {
      queueMicrotask(() =>
        child.stdout.write(
          '{"volumeSerial":"1234abcd","fileId":"0123456789abcdef","attributes":16}\n'
        )
      );
      return child;
    },
    async terminateChildTree(target) {
      terminated = true;
      target.exitCode = 1;
      target.signalCode = "SIGKILL";
      target.emit("close", 1, "SIGKILL");
    },
  });
  let lease = null;
  t.after(async () => lease?.release().catch(() => {}));

  lease = await provider.acquire("C:\\private");
  await assert.rejects(lease.release(), /directory lease release timed out/);
  assert.equal(terminated, true);
  assert.equal(child.exitCode, 1);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.listenerCount("close"), 0);
  lease = null;
});

test("terminating a lease-owning parent releases its Windows helper", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows helper lifecycle test");
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "jarvis-directory-parent-"));
  const fixture = path.join(__dirname, "fixtures", "directoryLeaseParent.js");
  const parent = fork(fixture, [base], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let parentClosed = false;
  t.after(async () => {
    if (!parentClosed) parent.kill();
    await waitForHelperCount(0, parent.pid).catch(() => {});
    await fsp.rm(base, { recursive: true, force: true });
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("lease parent did not become ready")), 5_000);
    parent.once("error", reject);
    parent.once("message", (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
  assert.match(ready.identity, /^win32:/);
  assert.equal(windowsHelperCount(parent.pid), 1);
  const closed = new Promise((resolve) => parent.once("close", resolve));
  parent.kill();
  await closed;
  parentClosed = true;
  await waitForHelperCount(0, parent.pid);
});
