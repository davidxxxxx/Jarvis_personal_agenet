const path = require("node:path");
const AudioChunkWriter = require("./AudioChunkWriter");

class MultiTrackAudioWriter {
  constructor({
    sessionId,
    tracks,
    baseDir,
    now,
    onChunk,
    beforeChunk = () => {},
    openSources = true,
  }) {
    this.sessionId = sessionId;
    this.baseDir = baseDir;
    this.now = now;
    this.onChunk = onChunk;
    this.beforeChunk = beforeChunk;
    this.writers = new Map();
    this.nextSequenceNumbers = new Map();
    this.tracks = new Map(Object.entries(tracks));
    if (openSources) {
      for (const [trackKey, track] of this.tracks) {
        this._openSource(trackKey, track);
      }
    }
  }

  hasSource(trackKey) {
    return this.writers.has(trackKey);
  }

  append(trackKey, pcm) {
    const writer = this.writers.get(trackKey);
    if (!writer) throw new Error(`inactive audio source: ${trackKey}`);
    writer.append(pcm);
  }

  closeSource(trackKey, at) {
    const writer = this.writers.get(trackKey);
    if (!writer) return;
    try {
      writer.close(at);
    } finally {
      this.nextSequenceNumbers.set(trackKey, writer.sequenceNumber);
      this.writers.delete(trackKey);
    }
  }

  reopenSource(trackKey, track) {
    if (this.writers.has(trackKey)) throw new Error(`audio source is already active: ${trackKey}`);
    const definition = { ...(this.tracks.get(trackKey) || {}), ...track };
    this.tracks.set(trackKey, definition);
    this._openSource(trackKey, definition);
  }

  closeAll(at) {
    const errors = [];
    const failedSources = [];
    for (const trackKey of [...this.writers.keys()]) {
      try {
        this.closeSource(trackKey, at);
      } catch (error) {
        failedSources.push(trackKey);
        errors.push(new Error(`failed to close audio source: ${trackKey}`, { cause: error }));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `failed to close audio sources: ${failedSources.join(", ")}`);
    }
  }

  abortAll() {
    for (const [trackKey, writer] of this.writers) {
      writer.abort();
      this.nextSequenceNumbers.set(trackKey, writer.sequenceNumber);
    }
    this.writers.clear();
  }

  _openSource(trackKey, track) {
    const sourceType = track.sourceType ?? (trackKey === "mic" ? "mic" : "system");
    if (sourceType !== "mic" && sourceType !== "system") {
      throw new TypeError(`invalid source type for ${trackKey}`);
    }
    const storageKey = track.storageKey ?? (trackKey === sourceType ? sourceType : track.id);
    if (typeof storageKey !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(storageKey)) {
      throw new TypeError(`invalid audio track storage key for ${trackKey}`);
    }
    const writer = new AudioChunkWriter({
      sessionId: this.sessionId,
      trackId: track.id,
      sourceType,
      baseDir: path.join(this.baseDir, storageKey),
      startedAt: track.startedAt,
      sequenceNumber: this.nextSequenceNumbers.get(trackKey) ?? 0,
      now: this.now,
      beforeChunk: this.beforeChunk,
      onChunk: this.onChunk,
    });
    this.writers.set(trackKey, writer);
  }
}

module.exports = MultiTrackAudioWriter;
