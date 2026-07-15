function zeroSamplesBuffer(samplesBuffer) {
  try {
    if (!(samplesBuffer instanceof ArrayBuffer)) return false;
    new Uint8Array(samplesBuffer).fill(0);
    return true;
  } catch {
    // Detached or malformed buffers cannot retain accessible PCM in this process.
    return false;
  }
}

async function withSamplesBufferCleared(payload, operation) {
  if (typeof operation !== "function") throw new TypeError("PCM operation must be a function");
  try {
    return await operation();
  } finally {
    zeroSamplesBuffer(payload?.samplesBuffer);
  }
}

async function withRequiredAudioRuntime(payload, runtime, unloadedMessage, operation) {
  return withSamplesBufferCleared(payload, async () => {
    if (!runtime) throw new Error(unloadedMessage);
    return operation(runtime);
  });
}

module.exports = { withRequiredAudioRuntime, withSamplesBufferCleared, zeroSamplesBuffer };
