const StorageGovernor = require("./StorageGovernor");

const MIN_FREE_BYTES = 5 * 1024 ** 3;

function requiredFreeBytes(totalBytes) {
  return StorageGovernor.thresholds(totalBytes).stopBytes;
}

function hasSafeDiskSpace({ freeBytes, totalBytes }) {
  return freeBytes > requiredFreeBytes(totalBytes);
}

module.exports = { MIN_FREE_BYTES, requiredFreeBytes, hasSafeDiskSpace };
