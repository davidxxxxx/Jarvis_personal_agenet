const MIN_FREE_BYTES = 5 * 1024 ** 3;

function requiredFreeBytes(totalBytes) {
  return Math.max(MIN_FREE_BYTES, Math.floor(totalBytes * 0.05));
}

function hasSafeDiskSpace({ freeBytes, totalBytes }) {
  return freeBytes >= requiredFreeBytes(totalBytes);
}

module.exports = { MIN_FREE_BYTES, requiredFreeBytes, hasSafeDiskSpace };
