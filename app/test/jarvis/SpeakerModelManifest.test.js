const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  SPEAKER_MODEL_KEYS,
  SPEAKER_MODEL_MANIFESTS,
  SpeakerModelInstaller,
  assertNonSystemDrive,
  getSpeakerModelManifest,
} = require("../../src/jarvis/main/SpeakerModelManifest");
const {
  SESSION_DIARIZATION_POLICY,
  SPEAKER_IDENTITY_MODEL_POLICY,
} = require("../../src/jarvis/main/SessionDiarizationPolicy");

const TEST_ROOT = path.resolve(__dirname, "../../../.runtime-cache/test-temp");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("identity model manifests pin the official Chinese ONNX artifacts and isolated spaces", () => {
  const primary = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.PRIMARY);
  const review = getSpeakerModelManifest(SPEAKER_MODEL_KEYS.REVIEW);

  assert.deepEqual(
    [primary.modelId, review.modelId],
    [
      "iic/speech_campplus_sv_zh-cn_16k-common",
      "iic/speech_eres2netv2_sv_zh-cn_16k-common",
    ]
  );
  assert.deepEqual([primary.embeddingDimension, review.embeddingDimension], [192, 192]);
  assert.equal(primary.embeddingSpace, "campplus-zh-cn-192-v1");
  assert.equal(review.embeddingSpace, "eres2netv2-zh-cn-192-v1");
  assert.notEqual(primary.embeddingSpace, review.embeddingSpace);
  assert.equal(primary.sha256, "f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11");
  assert.equal(review.sha256, "bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239");
  assert.equal(primary.byteLength, 28_281_138);
  assert.equal(review.byteLength, 71_441_526);
  assert.match(primary.downloadUrl, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\//);
  assert.match(review.downloadUrl, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\//);
  assert.equal(Object.isFrozen(SPEAKER_MODEL_MANIFESTS), true);
  assert.equal(Object.isFrozen(primary), true);
  assert.equal(SESSION_DIARIZATION_POLICY.embeddingDimension, 512);
  assert.equal(SPEAKER_IDENTITY_MODEL_POLICY.primary.embeddingDimension, 192);
  assert.equal(SPEAKER_IDENTITY_MODEL_POLICY.review.embeddingDimension, 192);
  assert.notEqual(
    SPEAKER_IDENTITY_MODEL_POLICY.primary.embeddingSpace,
    SPEAKER_IDENTITY_MODEL_POLICY.review.embeddingSpace
  );
  assert.equal(SPEAKER_IDENTITY_MODEL_POLICY.automaticAssociationEnabled, false);
  assert.equal(SPEAKER_IDENTITY_MODEL_POLICY.automaticAssociationMinimumPrecision, 0.95);
});

test("speaker model cache rejects the Windows system drive", () => {
  assert.throws(
    () => assertNonSystemDrive(String.raw`C:\JarvisData\models\speaker-models`, { systemDrive: "C:" }),
    (error) => error.code === "SPEAKER_MODEL_SYSTEM_DRIVE_FORBIDDEN"
  );
  assert.equal(
    assertNonSystemDrive(String.raw`G:\JarvisData\models\speaker-models`, { systemDrive: "C:" }),
    path.resolve(String.raw`G:\JarvisData\models\speaker-models`)
  );
});

test("speaker model install is atomic and restores the prior artifact after activation failure", async (t) => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const rootDirectory = fs.mkdtempSync(path.join(TEST_ROOT, "speaker-model-install-"));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const oldBytes = Buffer.from("known-good-old-model");
  const newBytes = Buffer.from("verified-new-model");
  const model = Object.freeze({
    key: "test_model",
    modelId: "test/model",
    fileName: "speaker.onnx",
    byteLength: newBytes.length,
    sha256: sha256(newBytes),
    downloadUrl: "https://example.invalid/speaker.onnx",
  });
  const target = path.join(rootDirectory, model.fileName);
  fs.writeFileSync(target, oldBytes);
  const installer = new SpeakerModelInstaller({
    rootDirectory,
    manifests: Object.freeze({ [model.key]: model }),
    allowSystemDrive: true,
    faultInjector(step) {
      if (step === "after_activate") throw new Error("simulated activation failure");
    },
  });

  await assert.rejects(
    installer.install(model.key, {
      force: true,
      async downloadTo({ destination }) {
        fs.writeFileSync(destination, newBytes);
      },
    }),
    /simulated activation failure/
  );

  assert.deepEqual(fs.readFileSync(target), oldBytes);
  assert.deepEqual(
    fs.readdirSync(rootDirectory).filter((entry) => entry.includes(".staging-") || entry.includes(".rollback-")),
    []
  );
});

test("speaker model install verifies length and SHA-256 before replacing an artifact", async (t) => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const rootDirectory = fs.mkdtempSync(path.join(TEST_ROOT, "speaker-model-verify-"));
  t.after(() => fs.rmSync(rootDirectory, { recursive: true, force: true }));
  const expected = Buffer.from("expected-model");
  const model = Object.freeze({
    key: "test_model",
    modelId: "test/model",
    fileName: "speaker.onnx",
    byteLength: expected.length,
    sha256: sha256(expected),
    downloadUrl: "https://example.invalid/speaker.onnx",
  });
  const installer = new SpeakerModelInstaller({
    rootDirectory,
    manifests: Object.freeze({ [model.key]: model }),
    allowSystemDrive: true,
  });

  await assert.rejects(
    installer.install(model.key, {
      async downloadTo({ destination }) {
        fs.writeFileSync(destination, Buffer.from("wrong-artifact"));
      },
    }),
    (error) => error.code === "SPEAKER_MODEL_ARTIFACT_INVALID"
  );
  assert.equal(fs.existsSync(path.join(rootDirectory, model.fileName)), false);

  const installed = await installer.install(model.key, {
    async downloadTo({ destination }) {
      fs.writeFileSync(destination, expected);
    },
  });
  assert.equal(installed.installed, true);
  assert.equal(installed.modelId, model.modelId);
  assert.deepEqual(fs.readFileSync(installed.path), expected);
});

test("diarization downloader has no home-directory fallback and installs both identity models", () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, "../../scripts/download-diarization-models.js"),
    "utf8"
  );
  assert.doesNotMatch(script, /os\.homedir|USERPROFILE|LOCALAPPDATA/i);
  assert.match(script, /resolveSpeakerModelDirectory/);
  assert.match(script, /SPEAKER_MODEL_KEYS\.PRIMARY/);
  assert.match(script, /SPEAKER_MODEL_KEYS\.REVIEW/);
  assert.match(script, /verifySpeakerModelArtifact/);
});
