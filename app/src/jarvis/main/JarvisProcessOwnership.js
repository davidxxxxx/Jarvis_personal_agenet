function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createJarvisOwnedPidsProvider({
  mainPid = process.pid,
  getAppMetrics = () => [],
  getWhisperPid = () => null,
} = {}) {
  if (!validPid(mainPid)) throw new TypeError("mainPid must be a positive safe integer");
  if (typeof getAppMetrics !== "function" || typeof getWhisperPid !== "function") {
    throw new TypeError("Jarvis process ownership providers must be functions");
  }

  return () => {
    let metrics = [];
    try {
      const result = getAppMetrics();
      if (Array.isArray(result)) metrics = result;
    } catch {}

    let whisperPid = null;
    try {
      whisperPid = getWhisperPid();
    } catch {}

    return [
      ...new Set([
        mainPid,
        ...metrics.map((metric) => metric?.pid).filter(validPid),
        ...(validPid(whisperPid) ? [whisperPid] : []),
      ]),
    ];
  };
}

module.exports = { createJarvisOwnedPidsProvider };
