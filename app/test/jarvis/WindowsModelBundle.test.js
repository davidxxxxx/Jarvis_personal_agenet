const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildWindowsModelBundle,
  createArchiveInvocation,
  modelArtifactNames,
  parseCliArgs,
  publishWindowsModelBundle,
  renderNsisInclude,
} = require("../../scripts/build-windows-model-bundle");

const fsp = fs.promises;
const TEST_ROOT = path.resolve(__dirname, "..", "..", ".tmp-tests", "windows-model-bundle");

function createTestDirectory(t) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const directory = fs.mkdtempSync(path.join(TEST_ROOT, "case-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function createBundleFixture(componentRoot, suffix = "2026.07.4") {
  await fsp.mkdir(componentRoot, { recursive: true });
  const names = modelArtifactNames(`jarvis-ai-model-pack-${suffix}`);
  const archivePath = path.join(componentRoot, names.archiveName);
  const checksumPath = path.join(componentRoot, names.checksumName);
  const descriptorPath = path.join(componentRoot, names.descriptorName);
  await Promise.all([
    fsp.writeFile(archivePath, "source archive", "utf8"),
    fsp.writeFile(checksumPath, "source checksum", "utf8"),
    fsp.writeFile(descriptorPath, "source descriptor", "utf8"),
  ]);
  return {
    ...names,
    archivePath,
    checksumPath,
    descriptorPath,
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

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

test("published model artifacts are detached snapshots instead of hardlinks", async (t) => {
  const directory = createTestDirectory(t);
  const componentRoot = path.join(directory, "components");
  const distRoot = path.join(directory, "dist");
  const bundle = await createBundleFixture(componentRoot);

  await publishWindowsModelBundle({ bundle, distRoot, systemDrive: "C:" });

  const publishedArchive = path.join(distRoot, bundle.archiveName);
  assert.equal(await fsp.readFile(publishedArchive, "utf8"), "source archive");
  assert.equal(
    sameFileIdentity(await fsp.stat(bundle.archivePath), await fsp.stat(publishedArchive)),
    false
  );
  await fsp.writeFile(bundle.archivePath, "component changed later", "utf8");
  assert.equal(await fsp.readFile(publishedArchive, "utf8"), "source archive");
});

test("republishing a legacy hardlink detaches the distribution artifact", async (t) => {
  const directory = createTestDirectory(t);
  const componentRoot = path.join(directory, "components");
  const distRoot = path.join(directory, "dist");
  const bundle = await createBundleFixture(componentRoot);
  await fsp.mkdir(distRoot, { recursive: true });
  const publishedArchive = path.join(distRoot, bundle.archiveName);
  await fsp.link(bundle.archivePath, publishedArchive);
  assert.equal(
    sameFileIdentity(await fsp.stat(bundle.archivePath), await fsp.stat(publishedArchive)),
    true
  );

  await publishWindowsModelBundle({ bundle, distRoot, systemDrive: "C:" });

  assert.equal(
    sameFileIdentity(await fsp.stat(bundle.archivePath), await fsp.stat(publishedArchive)),
    false
  );
  await fsp.writeFile(bundle.archivePath, "component changed after republish", "utf8");
  assert.equal(await fsp.readFile(publishedArchive, "utf8"), "source archive");
});

test("publication copy failure preserves every prior target and removes staging files", async (t) => {
  const directory = createTestDirectory(t);
  const componentRoot = path.join(directory, "components");
  const distRoot = path.join(directory, "dist");
  const bundle = await createBundleFixture(componentRoot);
  await fsp.mkdir(distRoot, { recursive: true });
  for (const [nameKey, content] of [
    ["archiveName", "old archive"],
    ["checksumName", "old checksum"],
    ["descriptorName", "old descriptor"],
  ]) {
    await fsp.writeFile(path.join(distRoot, bundle[nameKey]), content, "utf8");
  }
  const fsImpl = Object.create(fsp);
  fsImpl.copyFile = async (source, target, flags) => {
    if (path.resolve(source) === path.resolve(bundle.checksumPath)) {
      const error = new Error("injected publication copy failure");
      error.code = "EIO";
      throw error;
    }
    return fsp.copyFile(source, target, flags);
  };

  await assert.rejects(
    publishWindowsModelBundle({ bundle, distRoot, systemDrive: "C:", fsImpl }),
    /injected publication copy failure/u
  );

  assert.equal(await fsp.readFile(path.join(distRoot, bundle.archiveName), "utf8"), "old archive");
  assert.equal(
    await fsp.readFile(path.join(distRoot, bundle.checksumName), "utf8"),
    "old checksum"
  );
  assert.equal(
    await fsp.readFile(path.join(distRoot, bundle.descriptorName), "utf8"),
    "old descriptor"
  );
  assert.deepEqual(
    (await fsp.readdir(distRoot)).sort(),
    [bundle.archiveName, bundle.checksumName, bundle.descriptorName].sort()
  );
});

test("publication rejects a normalized source-target self overwrite without mutation", async (t) => {
  const directory = createTestDirectory(t);
  const componentRoot = path.join(directory, "components");
  const bundle = await createBundleFixture(componentRoot);

  await assert.rejects(
    publishWindowsModelBundle({ bundle, distRoot: componentRoot, systemDrive: "C:" }),
    /source and target must be different paths/u
  );

  assert.equal(await fsp.readFile(bundle.archivePath, "utf8"), "source archive");
  assert.equal(await fsp.readFile(bundle.checksumPath, "utf8"), "source checksum");
  assert.equal(await fsp.readFile(bundle.descriptorPath, "utf8"), "source descriptor");
  assert.deepEqual(
    (await fsp.readdir(componentRoot)).sort(),
    [bundle.archiveName, bundle.checksumName, bundle.descriptorName].sort()
  );
});

test("component checksum and descriptor replacement detach legacy publication hardlinks", async (t) => {
  const directory = createTestDirectory(t);
  const modelRoot = path.join(directory, "model");
  const componentRoot = path.join(directory, "components");
  const legacyDistRoot = path.join(directory, "legacy-dist");
  const tempRoot = path.join(directory, "temp");
  const nsisIncludePath = path.join(directory, "nsis", "model-pack.generated.nsh");
  await Promise.all([
    fsp.mkdir(modelRoot, { recursive: true }),
    fsp.mkdir(componentRoot, { recursive: true }),
    fsp.mkdir(legacyDistRoot, { recursive: true }),
  ]);
  const packVersion = "jarvis-ai-model-pack-2026.07.4";
  const manifestSha256 = "b".repeat(64);
  const sha512 = "a".repeat(128);
  const names = modelArtifactNames(packVersion);
  const archivePath = path.join(componentRoot, names.archiveName);
  const checksumPath = path.join(componentRoot, names.checksumName);
  const descriptorPath = path.join(componentRoot, names.descriptorName);
  const archive = Buffer.from("cached archive", "utf8");
  const descriptor = {
    schemaVersion: 2,
    packVersion,
    manifestSha256,
    archiveName: names.archiveName,
    bytes: archive.length,
    sha512,
  };
  const descriptorText = `${JSON.stringify(descriptor, null, 2)}\n`;
  await fsp.writeFile(archivePath, archive);
  await fsp.writeFile(checksumPath, "legacy checksum metadata", "utf8");
  await fsp.writeFile(descriptorPath, descriptorText, "utf8");
  const legacyChecksumPath = path.join(legacyDistRoot, names.checksumName);
  const legacyDescriptorPath = path.join(legacyDistRoot, names.descriptorName);
  await fsp.link(checksumPath, legacyChecksumPath);
  await fsp.link(descriptorPath, legacyDescriptorPath);

  const result = await buildWindowsModelBundle({
    modelRoot,
    componentRoot,
    tempRoot,
    nsisIncludePath,
    systemDrive: "C:",
    verifyModelPackImpl: async () => ({
      root: modelRoot,
      manifest: { packVersion, files: [] },
      manifestSha256,
    }),
    hashFileImpl: async (filePath, algorithm) => {
      assert.equal(path.resolve(filePath), path.resolve(archivePath));
      assert.equal(algorithm, "sha512");
      return sha512;
    },
    spawnSyncImpl: () => {
      throw new Error("reused component must not invoke 7-Zip");
    },
  });

  assert.equal(result.reused, true);
  assert.equal(await fsp.readFile(checksumPath, "utf8"), `${sha512}  ${names.archiveName}\n`);
  assert.equal(await fsp.readFile(legacyChecksumPath, "utf8"), "legacy checksum metadata");
  assert.equal(await fsp.readFile(descriptorPath, "utf8"), descriptorText);
  assert.equal(await fsp.readFile(legacyDescriptorPath, "utf8"), descriptorText);
  assert.equal(
    sameFileIdentity(await fsp.stat(checksumPath), await fsp.stat(legacyChecksumPath)),
    false
  );
  assert.equal(
    sameFileIdentity(await fsp.stat(descriptorPath), await fsp.stat(legacyDescriptorPath)),
    false
  );
});
