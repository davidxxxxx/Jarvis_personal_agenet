const path = require("node:path");
const { verifyAiModelPack } = require("../src/jarvis/main/AiModelPackManifest");

const APP_ROOT = path.resolve(__dirname, "..");
const PREBUILT_ROOT = path.join(APP_ROOT, "resources", "ai-model-pack", "prebuilt");

async function verifyPrebuiltAiModelPack({ root = PREBUILT_ROOT } = {}) {
  return verifyAiModelPack({ root });
}

async function main() {
  const verified = await verifyPrebuiltAiModelPack();
  process.stdout.write(
    `Jarvis AI Model Pack verified: ${verified.manifest.packVersion} (${verified.manifest.files.length} files)\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `Jarvis Windows release requires a verified offline AI model component: ${error.code || error.message}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = { PREBUILT_ROOT, verifyPrebuiltAiModelPack };
