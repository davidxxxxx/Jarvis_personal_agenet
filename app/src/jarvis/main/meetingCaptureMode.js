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

module.exports = {
  resolveMeetingCaptureMode,
  resolveMeetingCaptureModeWithPlan,
  routeMicOnlyPcm,
};
