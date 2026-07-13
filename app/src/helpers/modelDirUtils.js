const { app } = require("electron");
const os = require("os");
const path = require("path");
const { processWriteGate } = require("../jarvis/main/UnifiedRootWriteGate");

function getCacheRoot() {
  if (process.env.JARVIS_DATA_ROOT && path.isAbsolute(process.env.JARVIS_DATA_ROOT)) {
    processWriteGate.assertProducerAllowed("model-path");
    return path.join(process.env.JARVIS_DATA_ROOT, "models");
  }
  const homeDir = app?.getPath?.("home") || os.homedir();
  return path.join(homeDir, ".cache", "openwhispr");
}

function getModelsDirForService(service) {
  return path.join(getCacheRoot(), `${service}-models`);
}

module.exports = { getCacheRoot, getModelsDirForService };
