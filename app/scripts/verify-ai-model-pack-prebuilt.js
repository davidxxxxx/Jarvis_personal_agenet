const fs = require("node:fs");
const path = require("node:path");
const { verifyAiModelPack } = require("../src/jarvis/main/AiModelPackManifest");
const {
  assertSafeTextContent,
  assertScannableTextSize,
  isUnsafePackagePath,
} = require("./verify-package-safety");

const APP_ROOT = path.resolve(__dirname, "..");
const PREBUILT_ROOT = path.join(APP_ROOT, "resources", "ai-model-pack", "prebuilt");
const EXPLICIT_TEXT_EXTENSIONS = new Set([
  ".cfg",
  ".bat",
  ".cmake",
  ".conf",
  ".config",
  ".c",
  ".cc",
  ".cpp",
  ".cmd",
  ".css",
  ".csv",
  ".cu",
  ".cuh",
  ".f",
  ".f90",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".jinja",
  ".js",
  ".json",
  ".mako",
  ".md",
  ".mjs",
  ".mplstyle",
  ".pem",
  ".properties",
  ".proto",
  ".ps1",
  ".pxd",
  ".py",
  ".pyi",
  ".pyx",
  ".rst",
  ".sh",
  ".svg",
  ".toml",
  ".txt",
  ".tsv",
  ".typed",
  ".xml",
  ".yaml",
  ".yml",
]);
const EXPLICIT_TEXT_BASENAMES = new Set([
  ".gitattributes",
  ".gitignore",
  "copying",
  "entry_points.txt",
  "installer",
  "last_best_checkpoint",
  "license",
  "metadata",
  "notice",
  "py.typed",
  "readme",
  "record",
  "requested",
  "top_level.txt",
  "wheel",
]);
const MINIMAX_CREDENTIAL = /\bsk-cp-[A-Za-z0-9_-]{20,}\b/u;
const ANTHROPIC_CREDENTIAL = /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u;
const OPENAI_CREDENTIAL = /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})\b/u;
const PACKAGE_GENERIC_OPENAI_CANDIDATE =
  /\bsk-(?:cp-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/gu;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u;
const SAFETY_CONTENT_LABELS = new Set([
  "openai",
  "anthropic",
  "hugging-face",
  "aws",
  "google",
  "private-key",
]);

function modelPackSafetyError(label, relativePath) {
  const error = new Error(`model-pack-safety (${label}): ${relativePath}`);
  error.code = "AI_MODEL_PACK_UNSAFE";
  return error;
}

function posixRelative(root, candidate) {
  return path.relative(root, candidate).replaceAll(path.sep, "/");
}

function isManifestedPublicPem(relativePath, manifestFiles) {
  return (
    path.posix.extname(relativePath).toLowerCase() === ".pem" && manifestFiles.has(relativePath)
  );
}

function isExplicitTextPath(relativePath) {
  const basename = path.posix.basename(relativePath).toLowerCase();
  return (
    EXPLICIT_TEXT_EXTENSIONS.has(path.posix.extname(basename)) ||
    EXPLICIT_TEXT_BASENAMES.has(basename)
  );
}

function packageSafetyContentLabel(buffer, relativePath) {
  try {
    assertSafeTextContent(buffer, relativePath);
  } catch (error) {
    const match = /^credential content \(([^)]+)\) found \[redacted\]:/u.exec(
      String(error?.message ?? "")
    );
    if (match && SAFETY_CONTENT_LABELS.has(match[1])) return match[1];
    throw modelPackSafetyError("unscannable-text", relativePath);
  }
  return null;
}

function scanTextBuffer(buffer, relativePath) {
  const text = buffer.toString("utf8");
  let label = packageSafetyContentLabel(buffer, relativePath);
  if (label === "openai") {
    if (MINIMAX_CREDENTIAL.test(text)) throw modelPackSafetyError("minimax", relativePath);
    if (ANTHROPIC_CREDENTIAL.test(text)) throw modelPackSafetyError("anthropic", relativePath);
    if (OPENAI_CREDENTIAL.test(text)) throw modelPackSafetyError("openai", relativePath);
    const withoutGenericCandidates = text.replace(PACKAGE_GENERIC_OPENAI_CANDIDATE, "");
    label = packageSafetyContentLabel(Buffer.from(withoutGenericCandidates, "utf8"), relativePath);
  }
  if (label) throw modelPackSafetyError(label, relativePath);
  if (AWS_ACCESS_KEY.test(text)) throw modelPackSafetyError("aws", relativePath);
}

async function assertSafeModelPackSource({ root, manifest, fsImpl = fs.promises } = {}) {
  const safeRoot = path.resolve(root);
  const manifestFiles = new Set(
    Array.isArray(manifest?.files) ? manifest.files.map((entry) => entry.path) : []
  );

  for (const relativePath of manifestFiles) {
    if (isUnsafePackagePath(relativePath) && !isManifestedPublicPem(relativePath, manifestFiles)) {
      throw modelPackSafetyError("credential-file", relativePath);
    }
  }

  const pending = [safeRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await fsImpl.readdir(directory, { withFileTypes: true });
    } catch {
      const relativePath = posixRelative(safeRoot, directory) || ".";
      throw modelPackSafetyError("unreadable-directory", relativePath);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = posixRelative(safeRoot, absolutePath);
      let stat;
      try {
        stat = await fsImpl.lstat(absolutePath);
      } catch {
        throw modelPackSafetyError("unreadable-entry", relativePath);
      }
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw modelPackSafetyError("unsupported-entry", relativePath);
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || !stat.isFile()) {
        throw modelPackSafetyError("unsupported-entry", relativePath);
      }
      if (
        isUnsafePackagePath(relativePath) &&
        !isManifestedPublicPem(relativePath, manifestFiles)
      ) {
        const label = manifestFiles.has(relativePath)
          ? "credential-file"
          : "unmanifested-credential-file";
        throw modelPackSafetyError(label, relativePath);
      }
      if (!isExplicitTextPath(relativePath)) continue;
      try {
        assertScannableTextSize(stat.size, relativePath);
      } catch {
        throw modelPackSafetyError("oversized-text", relativePath);
      }
      let buffer;
      try {
        buffer = await fsImpl.readFile(absolutePath);
      } catch {
        throw modelPackSafetyError("unreadable-text", relativePath);
      }
      scanTextBuffer(buffer, relativePath);
    }
  }
}

async function verifyPrebuiltAiModelPack({
  root = PREBUILT_ROOT,
  fsImpl = fs.promises,
  verifyModelPackImpl = verifyAiModelPack,
} = {}) {
  const verified = await verifyModelPackImpl({ root, fsImpl });
  await assertSafeModelPackSource({ root: verified.root, manifest: verified.manifest, fsImpl });
  return verified;
}

async function main() {
  const verified = await verifyPrebuiltAiModelPack();
  process.stdout.write(
    `Jarvis AI Model Pack verified: ${verified.manifest.packVersion} (${verified.manifest.files.length} files)\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    const detail =
      error?.code === "AI_MODEL_PACK_UNSAFE" ? error.message : error.code || error.message;
    process.stderr.write(
      `Jarvis Windows release requires a verified offline AI model component: ${detail}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  PREBUILT_ROOT,
  assertSafeModelPackSource,
  isExplicitTextPath,
  verifyPrebuiltAiModelPack,
};
