const { assertId, assertSourceType } = require("../shared/contracts");

function resolveMeetingCaptureMode(options = {}, upstream = {}) {
  if (options.micOnly === true) {
    return {
      micOnly: true,
      systemAudioMode: "unsupported",
      systemAudioStrategy: "unsupported",
    };
  }

  return {
    micOnly: false,
    systemAudioMode: upstream.systemAudioMode || upstream.mode || "unsupported",
    systemAudioStrategy: upstream.systemAudioStrategy || upstream.strategy || "unsupported",
  };
}

async function resolveMeetingCaptureModeWithPlan(options = {}, getUpstreamPlan) {
  if (options.micOnly === true) {
    return resolveMeetingCaptureMode(options);
  }
  if (typeof getUpstreamPlan !== "function") {
    throw new TypeError("getUpstreamPlan must be a function");
  }
  return resolveMeetingCaptureMode(options, await getUpstreamPlan());
}

function routeMicOnlyPcm({
  sessionId,
  pcmBuffer,
  appendMicPcm,
  feedSpeaker,
  writeDiarization,
  dispatchTranscription,
}) {
  if (appendMicPcm(sessionId, pcmBuffer) === false) return false;
  feedSpeaker(pcmBuffer);
  writeDiarization(pcmBuffer);
  dispatchTranscription(pcmBuffer, "mic");
  return true;
}

function routeJarvisPcm({ sessionId, sourceType, pcmBuffer, appendPcm, afterPersist }) {
  const source = assertSourceType(sourceType);
  if (!Buffer.isBuffer(pcmBuffer)) throw new TypeError("pcmBuffer must be a Buffer");
  if (typeof appendPcm !== "function") throw new TypeError("appendPcm must be a function");
  if (typeof afterPersist !== "function") throw new TypeError("afterPersist must be a function");

  const id = sessionId == null ? null : assertId(sessionId, "sessionId");
  if (id && appendPcm(id, source, pcmBuffer) === false) return false;
  return afterPersist(pcmBuffer, source) !== false;
}

function dispatchRealtimePcm({
  buffer,
  source,
  streaming,
  preserveExactInput = false,
  transformMicBuffer = (input) => input,
}) {
  if (!streaming || typeof streaming.sendAudio !== "function") {
    throw new TypeError("streaming.sendAudio must be a function");
  }
  const outbound = source === "mic" && !preserveExactInput ? transformMicBuffer(buffer) : buffer;
  return {
    outbound,
    sent: streaming.sendAudio(outbound),
  };
}

async function settleMeetingPrepareBeforeStart({
  options = {},
  activePrepare,
  cancelIncompatible,
}) {
  if (!activePrepare) return "none";
  if (options.micOnly === true && activePrepare.micOnly !== true) {
    cancelIncompatible(activePrepare);
    return "cancelled";
  }
  await activePrepare.promise;
  return "awaited";
}

module.exports = {
  resolveMeetingCaptureMode,
  resolveMeetingCaptureModeWithPlan,
  routeMicOnlyPcm,
  routeJarvisPcm,
  dispatchRealtimePcm,
  settleMeetingPrepareBeforeStart,
};
