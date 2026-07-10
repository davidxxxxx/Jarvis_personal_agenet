const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const PACKAGE_PATH_KEYS = new Set(["files", "extraFiles", "extraResources", "asarUnpack"]);
const SECRET_BASENAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|pfx|p12|key)|id_rsa|credentials\.json)$/i;
const RUNTIME_BASENAME = /^(?:jarvis\.db(?:-(?:wal|shm))?|.*\.(?:db|sqlite|sqlite3|log|wav|part|pcm))$/i;
const RUNTIME_DIRECTORY = /^(?:logs?|recordings?|audio-captures?)$/i;
const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".text",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
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

function assertSafeArtifactPath(relativePath) {
  if (isUnsafePackagePath(relativePath)) {
    throw new Error(`unsafe packaged resource configured or found: ${relativePath}`);
  }
  if (forbiddenRuntimePath(relativePath)) {
    throw new Error(`forbidden runtime resource found: ${relativePath}`);
  }
}

function isTextResource(resourcePath) {
  return TEXT_EXTENSIONS.has(path.extname(resourcePath).toLowerCase());
}

function assertScannableTextSize(size, relativePath) {
  if (size > MAX_TEXT_BYTES) {
    throw new Error(`unscannable text resource exceeds safety limit: ${relativePath}`);
  }
}

function assertSafeTextContent(buffer, relativePath) {
  assertScannableTextSize(buffer.length, relativePath);
  if (buffer.includes(0)) {
    throw new Error(`unscannable binary content in text resource: ${relativePath}`);
  }
  const text = buffer.toString("utf8");
  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`credential content (${label}) found [redacted]: ${relativePath}`);
    }
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
    if (activePackagePath && isUnsafePackagePath(value)) found.push(value);
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
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(root, fullPath);
      assertSafeArtifactPath(relativePath);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".asar")) {
        for (const packagedPath of asar.listPackage(fullPath)) {
          assertSafeArtifactPath(packagedPath);
          const innerPath = packagedPath.replace(/^[\\/]+/, "");
          const info = asar.statFile(fullPath, innerPath);
          if (!info?.files && isTextResource(innerPath)) {
            assertScannableTextSize(info.size, `${relativePath}:${innerPath}`);
            assertSafeTextContent(
              asar.extractFile(fullPath, innerPath),
              `${relativePath}:${innerPath}`
            );
          }
        }
      } else if (entry.isFile() && isTextResource(relativePath)) {
        assertScannableTextSize(fs.statSync(fullPath).size, relativePath);
        assertSafeTextContent(fs.readFileSync(fullPath), relativePath);
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
  isUnsafePackagePath,
};
