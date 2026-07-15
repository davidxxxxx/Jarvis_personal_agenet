"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SPEAKER_IDENTITY_RESOLUTION_POLICY,
} = require("../../src/jarvis/main/SpeakerIdentityResolutionPolicy");

function gate() {
  return require("./support/SpeakerIdentityEvaluationGate");
}

function makeWav(durationMs = 200) {
  const dataBytes = Math.floor((16_000 * durationMs) / 1_000) * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

function anonymousManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    modelId: SPEAKER_IDENTITY_RESOLUTION_POLICY.modelId,
    profiles: [
      { personId: "self", kind: "self", audio: ["profiles/self-01.wav"] },
      { personId: "known-a", kind: "known", audio: ["profiles/known-a-01.wav"] },
    ],
    cases: [
      {
        id: "case-a",
        audio: "cases/case-a.wav",
        speakers: [
          { speakerId: "self", kind: "self" },
          { speakerId: "known-a", kind: "known" },
          { speakerId: "unknown-a", kind: "unknown" },
        ],
        segments: [
          { speakerId: "self", startMs: 0, endMs: 50 },
          { speakerId: "known-a", startMs: 50, endMs: 100 },
          { speakerId: "unknown-a", startMs: 100, endMs: 150 },
        ],
      },
    ],
    ...overrides,
  };
}

function fixtureDirectory(t, { consent = { consented: true }, manifest } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "profiles"));
  fs.mkdirSync(path.join(root, "cases"));
  if (consent !== null) {
    fs.writeFileSync(
      path.join(root, "consent.json"),
      typeof consent === "string" ? consent : JSON.stringify(consent)
    );
  }
  fs.writeFileSync(path.join(root, "profiles", "self-01.wav"), makeWav());
  fs.writeFileSync(path.join(root, "profiles", "known-a-01.wav"), makeWav());
  fs.writeFileSync(path.join(root, "cases", "case-a.wav"), makeWav());

  const manifestPath = path.join(root, "tracked-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest ?? anonymousManifest()));
  return { root, manifestPath };
}

function readyOptions(t, overrides = {}) {
  const fixture = fixtureDirectory(t, overrides.fixture);
  return {
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
    manifestPath: fixture.manifestPath,
    envValue: fixture.root,
    isTracked: () => false,
    runtime: {
      async assertAvailable() {
        return {
          diarizerHash: "a".repeat(64),
          embeddingHash: "b".repeat(64),
        };
      },
    },
    ...overrides,
    fixture,
  };
}

test("unset and missing private directories are the only skip states with exact no-download hints", async (t) => {
  const { loadPrivateSpeakerEvaluation } = gate();
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-speaker-repo-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const recommended = path.resolve(repoRoot, ".private", "speaker-eval");

  assert.deepEqual(
    await loadPrivateSpeakerEvaluation({
      repoRoot,
      manifestPath: "unused",
      envValue: "",
    }),
    {
      status: "skip",
      hint:
        `Speaker evaluation skipped: JARVIS_SPEAKER_EVAL_DIR is unset. ` +
        `Recommended path: ${recommended}. Set it with: ` +
        `$env:JARVIS_SPEAKER_EVAL_DIR="${recommended}". No data is downloaded.`,
    }
  );

  const missing = path.join(repoRoot, "absent-private-fixtures");
  assert.deepEqual(
    await loadPrivateSpeakerEvaluation({
      repoRoot,
      manifestPath: "unused",
      envValue: missing,
    }),
    {
      status: "skip",
      hint:
        `Speaker evaluation skipped: directory does not exist: ${path.resolve(missing)}. ` +
        `Set JARVIS_SPEAKER_EVAL_DIR to a consented fixture directory. ` +
        `No data is downloaded.`,
    }
  );
});

test("consent is required before manifest, WAV, or runtime access", async (t) => {
  const { loadPrivateSpeakerEvaluation } = gate();
  for (const [name, consent, code] of [
    ["missing", null, "SPEAKER_EVAL_CONSENT_MISSING"],
    ["false", { consented: false }, "SPEAKER_EVAL_CONSENT_REQUIRED"],
    ["malformed", "{", "SPEAKER_EVAL_CONSENT_INVALID"],
  ]) {
    await t.test(name, async (t2) => {
      const options = readyOptions(t2, { fixture: { consent } });
      const reads = [];
      const runtimeCalls = [];
      const fsImpl = {
        ...fs,
        readFileSync(file, ...args) {
          reads.push(path.basename(String(file)));
          return fs.readFileSync(file, ...args);
        },
      };
      await assert.rejects(
        loadPrivateSpeakerEvaluation({
          ...options,
          fsImpl,
          runtime: { assertAvailable: async () => runtimeCalls.push("called") },
        }),
        (error) => error.code === code && !error.message.includes(options.fixture.root)
      );
      assert.equal(
        reads.some((entry) => entry.endsWith(".wav")),
        false
      );
      assert.equal(reads.includes("tracked-manifest.json"), false);
      assert.deepEqual(runtimeCalls, []);
    });
  }

  await t.test("unreadable", async (t2) => {
    const options = readyOptions(t2);
    const consentPath = path.join(options.fixture.root, "consent.json");
    const fsImpl = {
      ...fs,
      readFileSync(file, ...args) {
        if (path.resolve(file) === path.resolve(consentPath)) {
          const error = new Error("denied");
          error.code = "EACCES";
          throw error;
        }
        return fs.readFileSync(file, ...args);
      },
    };
    await assert.rejects(
      loadPrivateSpeakerEvaluation({ ...options, fsImpl }),
      (error) => error.code === "SPEAKER_EVAL_CONSENT_UNREADABLE"
    );
  });
});

test("consent must be a regular untracked file", async (t) => {
  const { loadPrivateSpeakerEvaluation } = gate();
  const tracked = readyOptions(t);
  await assert.rejects(
    loadPrivateSpeakerEvaluation({ ...tracked, isTracked: () => true }),
    (error) => error.code === "SPEAKER_EVAL_CONSENT_TRACKED"
  );

  await t.test("symlink", async (t2) => {
    const options = readyOptions(t2);
    const consentPath = path.join(options.fixture.root, "consent.json");
    const fsImpl = {
      ...fs,
      lstatSync(file) {
        if (path.resolve(file) === path.resolve(consentPath)) {
          return { isSymbolicLink: () => true, isFile: () => false };
        }
        return fs.lstatSync(file);
      },
    };
    await assert.rejects(
      loadPrivateSpeakerEvaluation({ ...options, fsImpl }),
      (error) => error.code === "SPEAKER_EVAL_CONSENT_NOT_REGULAR"
    );
  });
});

test("anonymous manifest rejects malformed identities, paths, segments, support, and policy drift", () => {
  const { validateSpeakerEvaluationManifest } = gate();
  const policy = SPEAKER_IDENTITY_RESOLUTION_POLICY;
  const invalid = [
    ["SPEAKER_EVAL_MANIFEST_FIELDS", { ...anonymousManifest(), transcript: "forbidden" }],
    [
      "SPEAKER_EVAL_MANIFEST_DUPLICATE_ID",
      anonymousManifest({
        profiles: [anonymousManifest().profiles[0], anonymousManifest().profiles[0]],
      }),
    ],
    [
      "SPEAKER_EVAL_MANIFEST_AUDIO_PATH",
      anonymousManifest({
        profiles: [
          { personId: "self", kind: "self", audio: ["../self.wav"] },
          anonymousManifest().profiles[1],
        ],
      }),
    ],
    [
      "SPEAKER_EVAL_MANIFEST_AUDIO_PATH",
      anonymousManifest({
        cases: [{ ...anonymousManifest().cases[0], audio: path.resolve("case.wav") }],
      }),
    ],
    [
      "SPEAKER_EVAL_MANIFEST_UNKNOWN_SPEAKER",
      anonymousManifest({
        cases: [
          {
            ...anonymousManifest().cases[0],
            segments: [{ speakerId: "missing", startMs: 0, endMs: 10 }],
          },
        ],
      }),
    ],
    [
      "SPEAKER_EVAL_MANIFEST_SEGMENT_BOUNDS",
      anonymousManifest({
        cases: [
          {
            ...anonymousManifest().cases[0],
            segments: [{ speakerId: "self", startMs: 10, endMs: 10 }],
          },
        ],
      }),
    ],
    [
      "SPEAKER_EVAL_MANIFEST_SEGMENT_OVERLAP",
      anonymousManifest({
        cases: [
          {
            ...anonymousManifest().cases[0],
            segments: [
              { speakerId: "self", startMs: 0, endMs: 100 },
              { speakerId: "self", startMs: 50, endMs: 150 },
            ],
          },
        ],
      }),
    ],
    [
      "SPEAKER_EVAL_MANIFEST_SUPPORT",
      anonymousManifest({
        cases: [
          {
            ...anonymousManifest().cases[0],
            speakers: anonymousManifest().cases[0].speakers.slice(0, 2),
            segments: anonymousManifest().cases[0].segments.slice(0, 2),
          },
        ],
      }),
    ],
    ["SPEAKER_EVAL_MODEL_MISMATCH", anonymousManifest({ modelId: "different-model" })],
  ];

  for (const [code, manifest] of invalid) {
    assert.throws(
      () => validateSpeakerEvaluationManifest(manifest, { policy }),
      (error) => error.code === code,
      code
    );
  }
  assert.deepEqual(
    validateSpeakerEvaluationManifest(anonymousManifest(), { policy }),
    anonymousManifest()
  );
});

test("private audio resolution rejects traversal, missing files, and symlink escapes", async (t) => {
  const { resolvePrivateAudioFile } = gate();
  const options = readyOptions(t);
  assert.throws(
    () => resolvePrivateAudioFile(options.fixture.root, "../escape.wav"),
    (error) => error.code === "SPEAKER_EVAL_AUDIO_PATH"
  );
  assert.throws(
    () => resolvePrivateAudioFile(options.fixture.root, "cases/missing.wav"),
    (error) => error.code === "SPEAKER_EVAL_AUDIO_MISSING"
  );

  const link = path.join(options.fixture.root, "cases", "linked.wav");
  fs.writeFileSync(link, makeWav());
  const fsImpl = {
    ...fs,
    lstatSync(file) {
      if (path.resolve(file) === path.resolve(link)) {
        return { isSymbolicLink: () => true, isFile: () => false };
      }
      return fs.lstatSync(file);
    },
  };
  assert.throws(
    () => resolvePrivateAudioFile(options.fixture.root, "cases/linked.wav", fsImpl),
    (error) => error.code === "SPEAKER_EVAL_AUDIO_NOT_REGULAR"
  );
});

test("strict WAV validation rejects corrupt structure and case bounds beyond audio", async (t) => {
  const { validatePcmWav, loadPrivateSpeakerEvaluation } = gate();
  assert.throws(
    () => validatePcmWav(Buffer.from("not-wave")),
    (error) => error.code === "SPEAKER_EVAL_WAV_INVALID"
  );
  const stereo = makeWav();
  stereo.writeUInt16LE(2, 22);
  assert.throws(
    () => validatePcmWav(stereo),
    (error) => error.code === "SPEAKER_EVAL_WAV_FORMAT"
  );

  const options = readyOptions(t, {
    fixture: {
      manifest: anonymousManifest({
        cases: [
          {
            ...anonymousManifest().cases[0],
            segments: [
              { speakerId: "self", startMs: 0, endMs: 50 },
              { speakerId: "known-a", startMs: 50, endMs: 100 },
              { speakerId: "unknown-a", startMs: 100, endMs: 500 },
            ],
          },
        ],
      }),
    },
  });
  await assert.rejects(
    loadPrivateSpeakerEvaluation(options),
    (error) => error.code === "SPEAKER_EVAL_SEGMENT_EXCEEDS_AUDIO"
  );
});

test("configured valid fixtures fail missing runtime and otherwise become ready without downloads", async (t) => {
  const { loadPrivateSpeakerEvaluation } = gate();
  const unavailable = readyOptions(t);
  await assert.rejects(
    loadPrivateSpeakerEvaluation({
      ...unavailable,
      runtime: {
        async assertAvailable() {
          const error = new Error("runtime unavailable");
          error.code = "SPEAKER_EVAL_RUNTIME_MISSING";
          throw error;
        },
      },
    }),
    (error) => error.code === "SPEAKER_EVAL_RUNTIME_MISSING"
  );

  const available = readyOptions(t);
  const downloads = [];
  const loaded = await loadPrivateSpeakerEvaluation({
    ...available,
    downloadModels: () => downloads.push("forbidden"),
  });
  assert.equal(loaded.status, "ready");
  assert.equal(loaded.manifest.modelId, SPEAKER_IDENTITY_RESOLUTION_POLICY.modelId);
  assert.equal(loaded.audioFiles.size, 3);
  assert.match(loaded.runtime.diarizerHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(downloads, []);
});
