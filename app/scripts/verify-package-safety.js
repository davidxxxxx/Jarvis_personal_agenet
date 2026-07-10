const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const PACKAGE_PATH_KEYS = new Set(["files", "extraFiles", "extraResources", "asarUnpack"]);
const SECRET_BASENAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|pfx|p12|key)|id_rsa|credentials\.json)$/i;

function isUnsafePackagePath(value) {
  if (typeof value !== "string" || value.startsWith("!")) return false;
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .some((part) => SECRET_BASENAME.test(part));
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

function assertSafeArtifactPath(relativePath) {
  if (isUnsafePackagePath(relativePath)) {
    throw new Error(`unsafe packaged resource found: ${relativePath}`);
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
        }
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
  isUnsafePackagePath,
};
