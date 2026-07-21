const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  MANIFEST_FILE,
  MODEL_PACK_SCHEMA_VERSION,
  MODEL_PACK_VERSION,
  verifyAiModelPack,
} = require("../src/jarvis/main/AiModelPackManifest");
const { assertNonSystemDrive } = require("../src/jarvis/main/SpeakerModelManifest");

const APP_ROOT = path.resolve(__dirname, "..");
const SIDECAR_SOURCE = path.join(
  APP_ROOT,
  "resources",
  "ai-model-pack",
  "runtime",
  "jarvis_diarization_sidecar.py"
);
const OVERLAP_SIDECAR_SOURCE = path.join(
  APP_ROOT,
  "resources",
  "ai-model-pack",
  "runtime",
  "jarvis_overlap_separator.py"
);
const NOTICES_SOURCE = path.join(APP_ROOT, "resources", "ai-model-pack", "THIRD_PARTY_NOTICES.txt");
const OMITTED_SOURCE_DIRECTORIES = new Set([".cache", ".git", ".pytest_cache", "__pycache__"]);
const HASH_CONCURRENCY = 8;

async function mapBounded(values, limit, operation) {
  const results = new Array(values.length);
  let next = 0;
  let firstError = null;
  async function worker() {
    while (firstError === null) {
      const index = next++;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        firstError ??= error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || index + 1 >= argv.length) {
      throw new TypeError(`invalid argument: ${key}`);
    }
    values.set(key.slice(2), argv[++index]);
  }
  const required = [
    "python-runtime",
    "pyannote-dir",
    "mossformer-dir",
    "clearer-voice-dir",
    "diarization-models-dir",
  ];
  for (const key of required) {
    if (!values.has(key)) throw new TypeError(`--${key} is required`);
  }
  return Object.freeze(Object.fromEntries(values));
}

function safeOutput(directory, systemDrive) {
  const output = assertNonSystemDrive(path.resolve(directory), { systemDrive });
  const parent = path.dirname(output);
  if (output === parent || path.parse(output).root === output) {
    throw new Error("model pack output cannot be a drive root");
  }
  return output;
}

async function copyDirectory(source, destination) {
  const stat = await fs.promises.stat(source);
  if (!stat.isDirectory()) throw new TypeError(`directory is required: ${source}`);
  const resolvedSource = path.resolve(source);
  await fs.promises.cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: true,
    filter: (sourcePath) => {
      const relative = path.relative(resolvedSource, path.resolve(sourcePath));
      if (relative === "") return true;
      return !relative.split(path.sep).some((part) => OMITTED_SOURCE_DIRECTORIES.has(part));
    },
  });
}

async function copyFile(source, destination) {
  const stat = await fs.promises.stat(source);
  if (!stat.isFile() || stat.size <= 0) throw new TypeError(`file is required: ${source}`);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.promises.open(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    buffer.fill(0);
    await handle.close();
  }
  return hash.digest("hex");
}

async function listFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`model pack cannot contain symlinks: ${absolute}`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name !== MANIFEST_FILE) files.push(absolute);
      else if (!entry.isFile()) throw new Error(`unsupported model pack entry: ${absolute}`);
    }
  }
  files.sort((left, right) => left.localeCompare(right, "en"));
  return files;
}

async function buildAiModelPack(input, { now = () => new Date(), systemDrive } = {}) {
  const output = safeOutput(input.outputDir, systemDrive);
  const transaction = crypto.randomUUID().replaceAll("-", "");
  const staging = path.join(
    path.dirname(output),
    `.${path.basename(output)}.staging-${transaction}`
  );
  const backup = path.join(
    path.dirname(output),
    `.${path.basename(output)}.rollback-${transaction}`
  );
  let backupCreated = false;
  try {
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    await fs.promises.mkdir(staging, { recursive: false });
    await copyDirectory(path.resolve(input.pythonRuntime), path.join(staging, "runtime"));
    await copyFile(SIDECAR_SOURCE, path.join(staging, "runtime", "jarvis_diarization_sidecar.py"));
    await copyFile(
      OVERLAP_SIDECAR_SOURCE,
      path.join(staging, "runtime", "jarvis_overlap_separator.py")
    );
    await copyDirectory(
      path.resolve(input.pyannoteDir),
      path.join(staging, "models", "pyannote-community-1")
    );
    await copyDirectory(
      path.resolve(input.diarizationModelsDir),
      path.join(staging, "models", "diarization-models")
    );
    await copyDirectory(
      path.resolve(input.mossformerDir),
      path.join(staging, "checkpoints", "MossFormer2_SS_16K")
    );
    await copyDirectory(
      path.resolve(input.clearerVoiceDir),
      path.join(staging, "vendor", "clearervoice-studio")
    );
    await copyFile(NOTICES_SOURCE, path.join(staging, "THIRD_PARTY_NOTICES.txt"));
    const absoluteFiles = await listFiles(staging);
    const files = await mapBounded(absoluteFiles, HASH_CONCURRENCY, async (absolute) => {
      const stat = await fs.promises.stat(absolute);
      return {
        path: path.relative(staging, absolute).replaceAll("\\", "/"),
        bytes: stat.size,
        sha256: await sha256File(absolute),
      };
    });
    const manifest = {
      schemaVersion: MODEL_PACK_SCHEMA_VERSION,
      packVersion: MODEL_PACK_VERSION,
      createdAt: now().toISOString(),
      files,
    };
    await fs.promises.writeFile(
      path.join(staging, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await verifyAiModelPack({ root: staging });
    try {
      const stat = await fs.promises.stat(output);
      if (!stat.isDirectory()) throw new Error("existing model pack output is not a directory");
      await fs.promises.rename(output, backup);
      backupCreated = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.promises.rename(staging, output);
    // The complete staging tree was verified immediately before this same-volume atomic
    // rename. Rehashing the unchanged 5+ GiB runtime a third time adds no integrity signal;
    // release verification and first-launch adoption both independently verify the output.
    if (backupCreated) {
      await fs.promises.rm(backup, { recursive: true, force: true });
      backupCreated = false;
    }
    return { output, manifest };
  } catch (error) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      await fs.promises.rm(output, { recursive: true, force: true }).catch(() => {});
      await fs.promises.rename(backup, output).catch(() => {});
      backupCreated = false;
    }
    throw error;
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backupCreated)
      await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildAiModelPack({
    outputDir: args["output-dir"] ?? path.join(APP_ROOT, "resources", "ai-model-pack", "prebuilt"),
    pythonRuntime: args["python-runtime"],
    pyannoteDir: args["pyannote-dir"],
    mossformerDir: args["mossformer-dir"],
    clearerVoiceDir: args["clearer-voice-dir"],
    diarizationModelsDir: args["diarization-models-dir"],
  });
  process.stdout.write(`Jarvis AI Model Pack ready: ${result.output}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildAiModelPack,
  listFiles,
  mapBounded,
  parseArgs,
  safeOutput,
};
