const path = require("node:path");
const AudioChunkWriter = require("./AudioChunkWriter");

class MultiTrackAudioWriter {
  constructor({ sessionId, tracks, baseDir, now, onChunk, beforeChunk = () => {} }) {
    this.writers = new Map(
      Object.entries(tracks).map(([sourceType, track]) => [
        sourceType,
        new AudioChunkWriter({
          sessionId,
          trackId: track.id,
          sourceType,
          baseDir: path.join(baseDir, sourceType),
          startedAt: track.startedAt,
          now,
          beforeChunk,
          onChunk,
        }),
      ])
    );
  }

  append(sourceType, pcm) {
    const writer = this.writers.get(sourceType);
    if (!writer) throw new Error(`inactive audio source: ${sourceType}`);
    writer.append(pcm);
  }

  closeSource(sourceType, at) {
    this.writers.get(sourceType)?.close(at);
  }

  closeAll(at) {
    const errors = [];
    const failedSources = [];
    for (const [sourceType, writer] of this.writers) {
      try {
        writer.close(at);
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
    for (const writer of this.writers.values()) writer.abort();
  }
}

module.exports = MultiTrackAudioWriter;
