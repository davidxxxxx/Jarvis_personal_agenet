const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  createArchiveInvocation,
  modelArtifactNames,
  parseCliArgs,
  renderNsisInclude,
} = require("../../scripts/build-windows-model-bundle");

test("model bundle keeps the model outside NSIS while preserving one setup entry", () => {
  const names = modelArtifactNames("jarvis-ai-model-pack-2026.07.4");

  assert.deepEqual(names, {
    archiveName: "Jarvis AI Model Pack 2026.07.4.7z",
    checksumName: "Jarvis AI Model Pack 2026.07.4.7z.sha512",
    descriptorName: "Jarvis AI Model Pack 2026.07.4.release.json",
  });
});

test("7-Zip invocation archives the top-level model directory without shell interpolation", () => {
  const invocation = createArchiveInvocation({
    sevenZipPath: String.raw`G:\tools\7za.exe`,
    modelRoot: String.raw`G:\Jarvis\resources\ai-model-pack\prebuilt`,
    archivePath: String.raw`G:\Jarvis\release-components\models.7z`,
    listFilePath: String.raw`G:\Jarvis\tmp\model-bundle\manifest-files.txt`,
    tempRoot: String.raw`G:\Jarvis\tmp\model-bundle`,
    env: { PATH: "trusted" },
  });

  assert.equal(invocation.command, path.resolve(String.raw`G:\tools\7za.exe`));
  assert.deepEqual(invocation.args, [
    "a",
    "-t7z",
    "-mx=5",
    "-mmt=on",
    "-bd",
    "-y",
    "-scsUTF-8",
    path.resolve(String.raw`G:\Jarvis\release-components\models.7z`),
    `@${path.resolve(String.raw`G:\Jarvis\tmp\model-bundle\manifest-files.txt`)}`,
  ]);
  assert.equal(
    invocation.options.cwd,
    path.resolve(String.raw`G:\Jarvis\resources\ai-model-pack\prebuilt`)
  );
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.TEMP, path.resolve(String.raw`G:\Jarvis\tmp\model-bundle`));
  assert.equal(invocation.options.env.TMP, path.resolve(String.raw`G:\Jarvis\tmp\model-bundle`));
});

test("generated NSIS include pins the external archive digest and rejects injection", () => {
  const rendered = renderNsisInclude({
    archiveName: "Jarvis AI Model Pack 2026.07.4.7z",
    sha512: "a".repeat(128),
  });

  assert.match(rendered, /JARVIS_MODEL_ARCHIVE_NAME "Jarvis AI Model Pack 2026\.07\.4\.7z"/u);
  assert.match(rendered, new RegExp(`JARVIS_MODEL_ARCHIVE_SHA512 "${"A".repeat(128)}"`, "u"));
  assert.throws(
    () => renderNsisInclude({ archiveName: 'models.7z"\n!include evil', sha512: "a".repeat(128) }),
    /archive name/u
  );
  assert.throws(
    () => renderNsisInclude({ archiveName: "models.7z", sha512: "not-a-digest" }),
    /SHA-512/u
  );
});

test("model bundle CLI publishes only to one explicit distribution root", () => {
  const distRoot = path.resolve(String.raw`G:\Jarvis\releases\0.2.0-rc.1`);

  assert.deepEqual(parseCliArgs(["--publish-only", "--dist-root", distRoot]), {
    publishOnly: true,
    publishToDist: false,
    distRoot,
  });
  assert.deepEqual(parseCliArgs(["--publish-to-dist", `--dist-root=${distRoot}`]), {
    publishOnly: false,
    publishToDist: true,
    distRoot,
  });
  assert.throws(() => parseCliArgs(["--dist-root", distRoot]), /requires publication/i);
  assert.throws(
    () => parseCliArgs(["--publish-only", "--dist-root", "relative-output"]),
    /must be absolute/i
  );
  if (process.platform === "win32") {
    assert.throws(() => parseCliArgs(["--publish-only", "--dist-root", "G:\\"]), /volume root/i);
  }
  assert.throws(
    () => parseCliArgs(["--publish-only", "--dist-root", distRoot, "--unexpected"]),
    /unsupported model bundle argument/i
  );
});
