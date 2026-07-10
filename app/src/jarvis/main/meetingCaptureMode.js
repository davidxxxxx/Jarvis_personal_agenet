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
  appendMicPcm(sessionId, pcmBuffer);
  feedSpeaker(pcmBuffer);
  writeDiarization(pcmBuffer);
  dispatchTranscription(pcmBuffer, "mic");
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
  dispatchRealtimePcm,
  settleMeetingPrepareBeforeStart,
};
