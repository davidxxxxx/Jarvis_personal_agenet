const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const {
  MODEL_PACK_VERSION,
  REQUIRED_COMPONENTS,
  mapBounded,
  normalizeManifest,
  resolveAiModelPackRoot,
} = require("../../src/jarvis/main/AiModelPackManifest");

test("bounded model hashing preserves order, caps concurrency, and joins in-flight failures", async () => {
  let active = 0;
  let peak = 0;
  const ordered = await mapBounded([30, 5, 15, 1], 2, async (delay, index) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active -= 1;
    return index;
  });
  assert.deepEqual(ordered, [0, 1, 2, 3]);
  assert.equal(peak, 2);

  let inFlightFinished = false;
  await assert.rejects(
    mapBounded(["slow", "fail"], 2, async (value) => {
      if (value === "fail") throw new Error("fixture hash failure");
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlightFinished = true;
    }),
    /fixture hash failure/u
  );
  assert.equal(inFlightFinished, true);
});

function manifest() {
  return {
    schemaVersion: 1,
    packVersion: MODEL_PACK_VERSION,
    createdAt: "2026-07-21T00:00:00.000Z",
    files: REQUIRED_COMPONENTS.map((component, index) => ({
      path: component.requiredPath,
      bytes: index + 1,
      sha256: String(index + 1).padStart(64, "0"),
    })),
  };
}

test("AI model pack is rooted under Jarvis data and rejects the system drive", () => {
  assert.equal(
    resolveAiModelPackRoot({ dataRoot: "G:\\JarvisData", systemDrive: "C:" }),
    path.resolve("G:\\JarvisData", "models", "ai-model-pack")
  );
  assert.throws(
    () => resolveAiModelPackRoot({ dataRoot: "C:\\JarvisData", systemDrive: "C:" }),
    (error) => error.code === "SPEAKER_MODEL_SYSTEM_DRIVE_FORBIDDEN"
  );
});

test("AI model pack manifest requires every offline runtime and licensed model", () => {
  const normalized = normalizeManifest(manifest());
  assert.equal(normalized.packVersion, MODEL_PACK_VERSION);
  assert.equal(normalized.files.length, REQUIRED_COMPONENTS.length);
  const incomplete = manifest();
  incomplete.files.pop();
  assert.throws(
    () => normalizeManifest(incomplete),
    (error) => error.code === "AI_MODEL_PACK_INCOMPLETE"
  );
});

test("AI model pack permits real Python package paths but rejects traversal and drive escapes", () => {
  const realistic = manifest();
  realistic.files.push({
    path: "runtime/Lib/site-packages/torch-2.8.0+cu128.dist-info/METADATA",
    bytes: 10,
    sha256: "f".repeat(64),
  });
  realistic.files.push({
    path: "models/pyannote-community-1/.gitattributes",
    bytes: 10,
    sha256: "e".repeat(64),
  });
  realistic.files.push({
    path: "runtime/Lib/site-packages/example/py.typed",
    bytes: 0,
    sha256: "0".repeat(64),
  });
  assert.equal(normalizeManifest(realistic).files.length, REQUIRED_COMPONENTS.length + 3);

  const emptyRequired = manifest();
  emptyRequired.files[0].bytes = 0;
  assert.throws(
    () => normalizeManifest(emptyRequired),
    (error) => error.code === "AI_MODEL_PACK_INCOMPLETE"
  );
  for (const unsafePath of ["../secret", "runtime/../../secret", "C:/secret", "/secret"]) {
    const unsafe = manifest();
    unsafe.files.push({ path: unsafePath, bytes: 1, sha256: "d".repeat(64) });
    assert.throws(
      () => normalizeManifest(unsafe),
      (error) => error.code === "AI_MODEL_PACK_INVALID"
    );
  }
});
