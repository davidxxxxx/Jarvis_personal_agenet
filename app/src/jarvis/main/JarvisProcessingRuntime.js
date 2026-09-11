// Compatibility entry point. Runtime lifecycle, composition and preview have separate owners.
const { JarvisProcessingRuntime } = require("./runtime/ProcessingRuntime");
const {
  createJarvisProcessingRuntime,
  shouldEnableOverlapSeparation,
} = require("./runtime/createProcessingRuntime");
const { createCommittedAudioPreviewExecutor } = require("./runtime/CommittedAudioPreview");

module.exports = {
  JarvisProcessingRuntime,
  createJarvisProcessingRuntime,
  createCommittedAudioPreviewExecutor,
  shouldEnableOverlapSeparation,
};
