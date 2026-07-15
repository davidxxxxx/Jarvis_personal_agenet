const LIVE_SPEAKER_SCOPES = Object.freeze({
  JARVIS: "jarvis",
  LEGACY_MEETING: "legacy_meeting",
});

const VALID_SCOPES = new Set(Object.values(LIVE_SPEAKER_SCOPES));

function assertScope(scope) {
  if (!VALID_SCOPES.has(scope)) {
    throw new TypeError("live speaker scope must be jarvis or legacy_meeting");
  }
  return scope;
}

function assertIdentifier(identifier) {
  if (!identifier || typeof identifier !== "object") {
    throw new TypeError("live speaker identifier is required");
  }
  for (const operation of ["start", "feedAudio", "stop"]) {
    if (typeof identifier[operation] !== "function") {
      throw new TypeError(`live speaker identifier.${operation} must be a function`);
    }
  }
}

function assertStartOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("live speaker start options must be an object");
  }
}

function assertPcmBuffer(pcmBuffer) {
  if (!Buffer.isBuffer(pcmBuffer) && !ArrayBuffer.isView(pcmBuffer)) {
    throw new TypeError("live speaker PCM must be a Buffer or typed array");
  }
}

function createLiveSpeakerRouter({ identifier } = {}) {
  assertIdentifier(identifier);

  return Object.freeze({
    async start(scope, options) {
      assertScope(scope);
      assertStartOptions(options);
      if (scope === LIVE_SPEAKER_SCOPES.JARVIS) return false;
      return identifier.start(options);
    },

    async feed(scope, pcmBuffer) {
      assertScope(scope);
      assertPcmBuffer(pcmBuffer);
      if (scope === LIVE_SPEAKER_SCOPES.JARVIS) return null;
      return identifier.feedAudio(pcmBuffer);
    },

    async stop(scope) {
      assertScope(scope);
      if (scope === LIVE_SPEAKER_SCOPES.JARVIS) return null;
      return identifier.stop();
    },
  });
}

module.exports = {
  LIVE_SPEAKER_SCOPES,
  createLiveSpeakerRouter,
};
