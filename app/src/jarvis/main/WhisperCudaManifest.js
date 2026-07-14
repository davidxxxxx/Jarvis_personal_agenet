const WHISPER_CUDA_MANIFEST = Object.freeze({
  repository: "OpenWhispr/whisper.cpp",
  tag: "0.0.7",
  asset: "whisper-server-win32-x64-cuda.zip",
  size: 754_998_658,
  sha256: "cdac6f0afb951b4213943297943a9865ae822a8669d623d1d6eb46a0dc0a38c6",
});

const APPROVED_WHISPER_CUDA_MANIFESTS = Object.freeze([WHISPER_CUDA_MANIFEST]);

function getWhisperCudaDownloadUrl(manifest = WHISPER_CUDA_MANIFEST) {
  const repository = String(manifest.repository || "");
  const tag = String(manifest.tag || "");
  const asset = String(manifest.asset || "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError("Invalid CUDA manifest repository");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(tag) || !/^[A-Za-z0-9_.-]+$/.test(asset)) {
    throw new TypeError("Invalid CUDA manifest release path");
  }
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

module.exports = {
  WHISPER_CUDA_MANIFEST,
  APPROVED_WHISPER_CUDA_MANIFESTS,
  getWhisperCudaDownloadUrl,
};
