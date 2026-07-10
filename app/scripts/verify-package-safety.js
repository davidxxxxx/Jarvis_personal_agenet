const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const PACKAGE_PATH_KEYS = new Set(["files", "extraFiles", "extraResources", "asarUnpack"]);
const SECRET_BASENAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|pfx|p12|key)|id_rsa|credentials\.json)$/i;
const RUNTIME_BASENAME = /^(?:jarvis\.db(?:-(?:wal|shm))?|.*\.(?:db|sqlite|sqlite3|log|wav|part|pcm))$/i;
const RUNTIME_DIRECTORY = /^(?:logs?|recordings?|audio-captures?)$/i;
const STRONG_PROFILE_PARTS = new Set(["user-data", "userdata", "user data", "profile"]);
const PROFILE_STORAGE_PARTS = new Set([
  "cache",
  "code cache",
  "gpucache",
  "local storage",
  "session storage",
  "indexeddb",
  "network",
  "cookies",
  "history",
  "crashpad",
]);
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".aac",
  ".asar",
  ".avi",
  ".bin",
  ".blob",
  ".blockmap",
  ".br",
  ".bz2",
  ".dat",
  ".dll",
  ".dmp",
  ".dylib",
  ".exe",
  ".flac",
  ".gif",
  ".gz",
  ".icns",
  ".ico",
  ".jpeg",
  ".jpg",
  ".lib",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".node",
  ".ogg",
  ".onnx",
  ".opus",
  ".otf",
  ".pak",
  ".pdb",
  ".pdf",
  ".png",
  ".raw",
  ".so",
  ".snapshot",
  ".tar",
  ".ttf",
  ".wasm",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const CREDENTIAL_PATTERNS = [
  { label: "openai", pattern: /\bsk-(?:cp-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/ },
  { label: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  {
    label: "aws",
    pattern:
      /(?:AWS_ACCESS_KEY_ID|aws_access_key_id|accessKeyId)["'\s:=]{1,24}(?:AKIA|ASIA)[A-Z0-9]{16}\b/i,
  },
  { label: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    label: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{20,}\r?\n){2,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
];

function isUnsafePackagePath(value) {
  if (typeof value !== "string" || value.startsWith("!")) return false;
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .some((part) => SECRET_BASENAME.test(part));
}

function forbiddenRuntimePath(value) {
  const parts = value.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.some((part) => RUNTIME_DIRECTORY.test(part)) ||
    (parts.length > 0 && RUNTIME_BASENAME.test(parts.at(-1)));
}

function splitPathParts(value) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

function forbiddenProfilePath(value) {
  const parts = splitPathParts(value);
  const dependencyIndex = parts.indexOf("node_modules");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (
      STRONG_PROFILE_PARTS.has(part) ||
      /^profile \d+$/.test(part) ||
      part === "guest profile" ||
      part === "system profile"
    ) {
      return true;
    }
    if (part === "default" && parts[index + 1] === "preferences") return true;
    if (part === "preferences" && ["default", "profile"].includes(parts[index - 1])) return true;
    if (PROFILE_STORAGE_PARTS.has(part) && (dependencyIndex < 0 || index < dependencyIndex)) {
      return true;
    }
  }
  return false;
}

function assertSafeArtifactPath(relativePath) {
  if (isUnsafePackagePath(relativePath)) {
    throw new Error(`unsafe packaged resource configured or found: ${relativePath}`);
  }
  if (forbiddenRuntimePath(relativePath)) {
    throw new Error(`forbidden runtime resource found: ${relativePath}`);
  }
  if (forbiddenProfilePath(relativePath)) {
    throw new Error(`runtime profile resource found: ${relativePath}`);
  }
}

function assertScannableTextSize(size, relativePath) {
  if (size > MAX_TEXT_BYTES) {
    throw new Error(`unscannable text resource exceeds safety limit: ${relativePath}`);
  }
}

function assertSafeTextContent(buffer, relativePath) {
  assertScannableTextSize(buffer.length, relativePath);
  if (isProbablyBinary(buffer)) {
    throw new Error(`unscannable binary content in text resource: ${relativePath}`);
  }
  const text = buffer.toString("utf8");
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`credential content (${label}) found [redacted]: ${relativePath}`);
    }
  }
}

function isProbablyBinary(buffer) {
  if (buffer.includes(0)) return true;
  const sampleLength = Math.min(buffer.length, 8 * 1024);
  if (sampleLength === 0) return false;
  let controls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) controls += 1;
  }
  return controls / sampleLength > 0.01;
}

function isKnownBinaryResource(resourcePath) {
  return BINARY_EXTENSIONS.has(path.extname(resourcePath).toLowerCase());
}

function scanContentBuffer(buffer, relativePath) {
  if (isKnownBinaryResource(relativePath)) return;
  assertSafeTextContent(buffer, relativePath);
}

function scanLooseFile(fullPath, relativePath) {
  if (isKnownBinaryResource(relativePath)) return;
  const stat = fs.lstatSync(fullPath);
  if (!stat.isFile()) throw new Error(`unsupported loose entry found: ${relativePath}`);
  assertScannableTextSize(stat.size, relativePath);
  scanContentBuffer(fs.readFileSync(fullPath), relativePath);
}

function assertContainedPath(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`unsupported ASAR indirection found: ${label}`);
  }
}

function isKnownStrippedUnpackedEntry(innerPath) {
  const parts = splitPathParts(innerPath);
  const marker = ["node_modules", "onnxruntime-node", "bin", "napi-v6"];
  const markerIndex = parts.findIndex((part, index) =>
    marker.every((expected, offset) => parts[index + offset] === expected)
  );
  if (markerIndex < 0) return false;
  const platform = parts[markerIndex + marker.length];
  const architecture = parts[markerIndex + marker.length + 1];
  if (!["darwin", "linux", "win32"].includes(platform)) return false;
  if (!["arm64", "ia32", "x64"].includes(architecture)) return false;
  return platform !== process.platform || architecture !== process.arch;
}

function scanAsarFile(archivePath, archiveRelativePath, innerPath, info) {
  const label = `${archiveRelativePath}:${innerPath}`;
  if (Object.prototype.hasOwnProperty.call(info, "link")) {
    throw new Error(`unsupported ASAR link found: ${label}`);
  }
  if (info.unpacked) {
    const unpackedRoot = `${archivePath}.unpacked`;
    const externalPath = path.join(unpackedRoot, innerPath);
    assertContainedPath(unpackedRoot, externalPath, label);
    let stat;
    try {
      stat = fs.lstatSync(externalPath);
    } catch {
      if (isKnownStrippedUnpackedEntry(innerPath)) return;
      throw new Error(`unsupported ASAR unpacked indirection found: ${label}`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`unsupported ASAR unpacked indirection found: ${label}`);
    }
    scanLooseFile(externalPath, label);
    return;
  }
  if (!Number.isSafeInteger(info.size) || info.size < 0) {
    throw new Error(`unsupported ASAR entry metadata found: ${label}`);
  }
  if (isKnownBinaryResource(innerPath)) return;
  assertScannableTextSize(info.size, label);
  scanContentBuffer(asar.extractFile(archivePath, innerPath, false), label);
}

function scanAsarArchive(archivePath, archiveRelativePath) {
  for (const packagedPath of asar.listPackage(archivePath)) {
    assertSafeArtifactPath(packagedPath);
    const innerPath = packagedPath.replace(/^[\\/]+/, "");
    const info = asar.statFile(archivePath, innerPath, false);
    if (info?.files) continue;
    if (!info || typeof info !== "object") {
      throw new Error(`unsupported ASAR entry metadata found: ${archiveRelativePath}:${innerPath}`);
    }
    scanAsarFile(archivePath, archiveRelativePath, innerPath, info);
  }
}

function loadConfigChain(configPath, seen = new Set()) {
  const resolved = path.resolve(configPath);
  if (seen.has(resolved)) throw new Error("cyclic electron-builder config inheritance");
  seen.add(resolved);
  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const parents = config.extends
    ? Array.isArray(config.extends)
      ? config.extends
      : [config.extends]
    : [];
  return [
    ...parents.flatMap((parent) => {
      if (typeof parent !== "string") return [];
      const parentPath = path.isAbsolute(parent)
        ? parent
        : path.resolve(path.dirname(resolved), parent);
      return loadConfigChain(parentPath, seen);
    }),
    { config, configPath: resolved },
  ];
}

function findUnsafeConfigPaths(value, activePackagePath = false, found = []) {
  if (typeof value === "string") {
    if (
      activePackagePath &&
      !value.startsWith("!") &&
      (isUnsafePackagePath(value) || forbiddenRuntimePath(value) || forbiddenProfilePath(value))
    ) {
      found.push(value);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) findUnsafeConfigPaths(entry, activePackagePath, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, entry] of Object.entries(value)) {
    findUnsafeConfigPaths(entry, activePackagePath || PACKAGE_PATH_KEYS.has(key), found);
  }
  return found;
}

function assertSafeBuilderConfig(configPath) {
  const unsafe = loadConfigChain(configPath).flatMap(({ config }) =>
    findUnsafeConfigPaths(config)
  );
  if (unsafe.length > 0) {
    throw new Error(`unsafe packaged resource configured: ${unsafe.join(", ")}`);
  }
}

function assertSafeArtifactTree(root) {
  if (!fs.existsSync(root)) throw new Error(`package output does not exist: ${root}`);
  const resolvedRoot = path.resolve(root);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`unsupported package root: ${resolvedRoot}`);
  }
  const pending = [resolvedRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(resolvedRoot, fullPath);
      assertSafeArtifactPath(relativePath);
      const stat = fs.lstatSync(fullPath);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error(`unsupported loose entry found: ${relativePath}`);
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && stat.isFile() && entry.name.endsWith(".asar")) {
        scanAsarArchive(fullPath, relativePath);
      } else if (entry.isFile() && stat.isFile()) {
        scanLooseFile(fullPath, relativePath);
      } else {
        throw new Error(`unsupported loose entry found: ${relativePath}`);
      }
    }
  }
}

if (require.main === module) {
  const [configPath, artifactRoot] = process.argv.slice(2);
  if (!configPath) throw new Error("usage: verify-package-safety <config> [artifact-root]");
  assertSafeBuilderConfig(configPath);
  if (artifactRoot) assertSafeArtifactTree(artifactRoot);
}

module.exports = {
  assertSafeArtifactTree,
  assertSafeBuilderConfig,
  assertScannableTextSize,
  assertSafeTextContent,
  forbiddenRuntimePath,
  forbiddenProfilePath,
  isUnsafePackagePath,
};
