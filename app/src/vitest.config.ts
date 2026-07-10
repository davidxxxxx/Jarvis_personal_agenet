import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcRoot = dirname(fileURLToPath(import.meta.url));
const rendererSuiteExists = existsSync(join(srcRoot, "jarvis", "renderer", "__tests__"));

export default defineConfig({
  root: srcRoot,
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // Task 4 creates this directory with the first renderer tests, making no tests an error.
    passWithNoTests: !rendererSuiteExists,
  },
});
