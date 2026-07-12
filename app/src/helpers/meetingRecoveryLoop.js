const DEFAULT_RETRY_DELAYS_MS = [50, 100, 250, 500, 1000, 2000, 5000];

function createBoundedRecoveryBuffer(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }

  let chunks = [];
  let byteLength = 0;

  const asByteView = (chunk) => {
    try {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
      if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    } catch {}
    return null;
  };

  return {
    push(chunk) {
      const bytes = asByteView(chunk);
      if (!bytes || bytes.byteLength === 0) return false;
      if (byteLength + bytes.byteLength > maxBytes) return false;
      const copy = Buffer.from(bytes);
      chunks.push(copy);
      byteLength += copy.byteLength;
      return true;
    },
    drain() {
      const drained = chunks;
      chunks = [];
      byteLength = 0;
      return drained;
    },
    clear() {
      chunks.length = 0;
      byteLength = 0;
    },
    get byteLength() {
      return byteLength;
    },
    get length() {
      return chunks.length;
    },
  };
}

function createMeetingRecoveryLoop({
  isCurrent,
  attempt,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
}) {
  let generation = 0;
  let runningPromise = null;
  let timer = null;
  let resolveDelay = null;

  const waitForDelay = (delayMs) =>
    new Promise((resolve) => {
      resolveDelay = resolve;
      timer = setTimeout(() => {
        timer = null;
        resolveDelay = null;
        resolve();
      }, delayMs);
    });

  const current = (expectedGeneration) =>
    expectedGeneration === generation && isCurrent();

  const start = () => {
    if (runningPromise) return runningPromise;
    const expectedGeneration = generation;
    const recovery = (async () => {
      for (let attemptIndex = 0; current(expectedGeneration); attemptIndex += 1) {
        const delayMs = retryDelaysMs[Math.min(attemptIndex, retryDelaysMs.length - 1)];
        await waitForDelay(delayMs);
        if (!current(expectedGeneration)) return false;
        const succeeded = await attempt({
          attemptIndex,
          isCurrent: () => current(expectedGeneration),
        });
        if (!current(expectedGeneration)) return false;
        if (succeeded) {
          return true;
        }
      }
      return false;
    })();
    const tracked = recovery.finally(() => {
      if (runningPromise === tracked) runningPromise = null;
    });
    runningPromise = tracked;
    return tracked;
  };

  const cancel = () => {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    resolveDelay?.();
    resolveDelay = null;
  };

  return { start, cancel };
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  createBoundedRecoveryBuffer,
  createMeetingRecoveryLoop,
};
