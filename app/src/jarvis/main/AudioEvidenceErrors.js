const TRANSIENT_IO_CODES = new Set([
  "EBUSY",
  "EPERM",
  "EACCES",
  "EMFILE",
  "ENFILE",
]);

function isTransientIoError(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
      continue;
    }
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (TRANSIENT_IO_CODES.has(candidate.code) || candidate.classification === "transient_io") {
      return true;
    }
    if (candidate.cause) pending.push(candidate.cause);
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return false;
}

function isFfmpegInputTransient(stderr) {
  return /(?:resource temporarily unavailable|device or resource busy|permission denied|too many open files|input\/output error)/i.test(
    String(stderr).slice(-4_096)
  );
}

function isFfmpegInputMissing(stderr) {
  return /(?:no such file or directory|file not found)/i.test(String(stderr).slice(-4_096));
}

function ffmpegProcessError(cause) {
  const error = new Error("ffmpeg_process_error", { cause });
  if (typeof cause?.code === "string") error.code = cause.code;
  if (Number.isInteger(cause?.exitCode)) error.exitCode = cause.exitCode;
  error.classification = isTransientIoError(cause) ? "transient_io" : "process_error";
  return error;
}

function ffmpegExitError(exitCode, stderr) {
  const error = new Error("ffmpeg_decode_failed");
  error.exitCode = exitCode;
  if (isFfmpegInputTransient(stderr)) {
    error.code = "FFMPEG_INPUT_TRANSIENT";
    error.classification = "transient_io";
  } else if (isFfmpegInputMissing(stderr)) {
    error.code = "ENOENT";
    error.classification = "missing_input";
  } else {
    error.classification = "decode_invalid";
  }
  return error;
}

module.exports = {
  ffmpegExitError,
  ffmpegProcessError,
  isTransientIoError,
};
