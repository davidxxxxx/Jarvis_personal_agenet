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
      for (const [sourceType, track] of this.tracks) {
        this._openSource(sourceType, track);
      }
    }
  }

  hasSource(sourceType) {
    return this.writers.has(sourceType);
  }

  append(sourceType, pcm) {
    const writer = this.writers.get(sourceType);
    if (!writer) throw new Error(`inactive audio source: ${sourceType}`);
    writer.append(pcm);
  }

  closeSource(sourceType, at) {
    const writer = this.writers.get(sourceType);
    if (!writer) return;
    try {
      writer.close(at);
    } finally {
      this.nextSequenceNumbers.set(sourceType, writer.sequenceNumber);
      this.writers.delete(sourceType);
    }
  }

  reopenSource(sourceType, track) {
    if (this.writers.has(sourceType)) throw new Error(`audio source is already active: ${sourceType}`);
    const definition = { ...(this.tracks.get(sourceType) || {}), ...track };
    this.tracks.set(sourceType, definition);
    this._openSource(sourceType, definition);
  }

  closeAll(at) {
    const errors = [];
    const failedSources = [];
    for (const sourceType of [...this.writers.keys()]) {
      try {
        this.closeSource(sourceType, at);
      } catch (error) {
        failedSources.push(sourceType);
        errors.push(new Error(`failed to close audio source: ${sourceType}`, { cause: error }));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `failed to close audio sources: ${failedSources.join(", ")}`);
    }
  }

  abortAll() {
    for (const [sourceType, writer] of this.writers) {
      writer.abort();
      this.nextSequenceNumbers.set(sourceType, writer.sequenceNumber);
    }
    this.writers.clear();
  }

  _openSource(sourceType, track) {
    const writer = new AudioChunkWriter({
      sessionId: this.sessionId,
      trackId: track.id,
      sourceType,
      baseDir: path.join(this.baseDir, sourceType),
      startedAt: track.startedAt,
      sequenceNumber: this.nextSequenceNumbers.get(sourceType) ?? 0,
      now: this.now,
      beforeChunk: this.beforeChunk,
      onChunk: this.onChunk,
    });
    this.writers.set(sourceType, writer);
  }
}

module.exports = MultiTrackAudioWriter;
