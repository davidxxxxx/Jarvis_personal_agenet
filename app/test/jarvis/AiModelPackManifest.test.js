const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const test = require("node:test");
const path = require("node:path");
const {
  MODEL_PACK_VERSION,
  REQUIRED_COMPONENTS,
  mapBounded,
  normalizeManifest,
  resolveAiModelPackRoot,
} = require("../../src/jarvis/main/AiModelPackManifest");
const {
  assertSafeModelPackSource,
  verifyPrebuiltAiModelPack,
} = require("../../scripts/verify-ai-model-pack-prebuilt");

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

function withModelPackFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-model-pack-safety-"));
  const files = [];
  const write = (relativePath, contents) => {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    files.push({ path: relativePath });
  };
  return Promise.resolve()
    .then(() => run({ root, files, write }))
    .finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

function assertModelPackSafetyFailure(operation, { label, relativePath, secret }) {
  return assert.rejects(operation, (error) => {
    assert.equal(error.code, "AI_MODEL_PACK_UNSAFE");
    assert.equal(error.message, `model-pack-safety (${label}): ${relativePath}`);
    if (secret) assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
}

test("prebuilt model-pack verification rejects unmanifested credential filenames without disclosure", async () => {
  await withModelPackFixture(async ({ root, write }) => {
    const secret = "fixture-secret-that-must-never-be-reported";
    write("runtime/.env.local", `MINIMAX_API_KEY=${secret}\n`);
    await assertModelPackSafetyFailure(
      () =>
        verifyPrebuiltAiModelPack({
          root,
          verifyModelPackImpl: async () => ({
            root,
            manifest: { packVersion: MODEL_PACK_VERSION, files: [] },
          }),
        }),
      { label: "unmanifested-credential-file", relativePath: "runtime/.env.local", secret }
    );
  });
});

test("model-pack source scanning redacts cloud credentials in explicit text", async (t) => {
  const privateBody = Buffer.from("google-service-account-private-material".repeat(4)).toString(
    "base64"
  );
  const fixtures = [
    ["openai", `sk-proj-${"O".repeat(40)}`],
    ["minimax", `sk-cp-${"M".repeat(40)}`],
    ["anthropic", `sk-ant-api03-${"A".repeat(40)}`],
    ["hugging-face", `hf_${"H".repeat(34)}`],
    ["aws", `AKIA${"A1".repeat(8)}`],
    ["google", `AIza${"G".repeat(35)}`],
    ["private-key", `-----BEGIN PRIVATE KEY-----\n${privateBody}\n-----END PRIVATE KEY-----`],
  ];

  for (const [label, secret] of fixtures) {
    await t.test(label, async () => {
      await withModelPackFixture(async ({ root, files, write }) => {
        const relativePath = `runtime/${label}.txt`;
        write(relativePath, `credential = ${secret}\n`);
        await assertModelPackSafetyFailure(
          () => assertSafeModelPackSource({ root, manifest: { files } }),
          { label, relativePath, secret }
        );
      });
    });
  }
});

test("model-pack source scanning covers unmanifested text but skips known binary catalog files", async () => {
  await withModelPackFixture(async ({ root, files, write }) => {
    const secret = `sk-cp-${"S".repeat(40)}`;
    write("runtime/python.cat", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(secret)]));
    write(
      "runtime/Lib/site-packages/sklearn/estimator.css",
      ".sk-estimator-accordion--label-container { display: grid; }\n"
    );
    await assert.doesNotReject(() => assertSafeModelPackSource({ root, manifest: { files } }));

    const relativePath = "runtime/unlisted-notes.txt";
    write(relativePath, `token = ${secret}\n`);
    files.pop();
    await assertModelPackSafetyFailure(
      () => assertSafeModelPackSource({ root, manifest: { files } }),
      { label: "minimax", relativePath, secret }
    );
  });
});
