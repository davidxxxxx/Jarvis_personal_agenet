const CHANNELS = Object.freeze({
  createSession: "jarvis:session:create",
  setSessionStatus: "jarvis:session:set-status",
  getSession: "jarvis:session:get",
  listSessions: "jarvis:session:list",
  upsertSegments: "jarvis:segments:upsert",
  listSegments: "jarvis:segments:list",
  renamePerson: "jarvis:person:rename",
  listPeople: "jarvis:person:list",
  listAudioChunks: "jarvis:audio:list",
  control: "jarvis:control",
  stateChanged: "jarvis:state-changed",
});

const SESSION_STATUSES = new Set([
  "recording",
  "paused",
  "finalizing",
  "completed",
  "recovered",
  "failed",
]);

function assertId(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
  return value;
}

function assertSessionStatus(value) {
  if (!SESSION_STATUSES.has(value)) throw new TypeError("invalid session status");
  return value;
}

module.exports = { CHANNELS, SESSION_STATUSES, assertId, assertSessionStatus };
