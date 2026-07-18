const path = require("node:path");
const {
  DATA_ROOT_IN_USE_CODE,
  DirectoryLeaseProvider,
} = require("./DirectoryLease");

const RUNTIME_LEASE_FILENAME = ".jarvis-runtime.lock";
const SAFE_DATA_ROOT_IN_USE_MESSAGE =
  "Jarvis is already using this data directory. Close the other Jarvis window and try again.";

function safeDataRootInUseError() {
  const error = new Error(SAFE_DATA_ROOT_IN_USE_MESSAGE);
  error.code = DATA_ROOT_IN_USE_CODE;
  return error;
}

async function acquireDataRootRuntimeLease({
  dataRoot,
  leaseProvider = new DirectoryLeaseProvider(),
} = {}) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) {
    throw new TypeError("dataRoot must be absolute");
  }
  if (!leaseProvider || typeof leaseProvider.acquireExclusiveFile !== "function") {
    throw new TypeError("leaseProvider must acquire an exclusive file");
  }
  try {
    return await leaseProvider.acquireExclusiveFile(
      path.join(path.resolve(dataRoot), RUNTIME_LEASE_FILENAME)
    );
  } catch {
    throw safeDataRootInUseError();
  }
}

module.exports = {
  DATA_ROOT_IN_USE_CODE,
  RUNTIME_LEASE_FILENAME,
  SAFE_DATA_ROOT_IN_USE_MESSAGE,
  acquireDataRootRuntimeLease,
};
