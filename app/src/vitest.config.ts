import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const srcRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: srcRoot,
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    passWithNoTests: false,
  },
});
