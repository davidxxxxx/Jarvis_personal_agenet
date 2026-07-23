const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

test("package exposes the Task 1 Jarvis contract", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.equal(pkg.name, "jarvis-memory-assistant");
  assert.equal(pkg.productName, "Jarvis Memory");
  assert.equal(pkg.version, "0.2.0-alpha.7");
  assert.equal(pkg.description, "Local-first Windows conversation memory assistant");
  assert.equal(pkg.engines.node, ">=24");
  assert.equal(pkg.scripts["test:main"], 'node --test "test/jarvis/*.test.js"');
  assert.equal(pkg.scripts["test:renderer"], "vitest run --config src/vitest.config.ts");
  assert.equal(
    pkg.scripts["test:jarvis"],
    'node --test "test/jarvis/*.test.js" && npm run test:renderer'
  );
  assert.equal(
    pkg.scripts["build:win:unsigned"],
    "npm run prebuild:win && npm run build:renderer && node scripts/build-windows.js"
  );
  assert.match(pkg.scripts["prebuild:win"], /npm run verify:ai-model-pack$/u);
  assert.deepEqual(
    {
      "@testing-library/jest-dom": pkg.devDependencies["@testing-library/jest-dom"],
      "@testing-library/react": pkg.devDependencies["@testing-library/react"],
      jsdom: pkg.devDependencies.jsdom,
      vitest: pkg.devDependencies.vitest,
    },
    {
      "@testing-library/jest-dom": "^6.9.1",
      "@testing-library/react": "^16.3.0",
      jsdom: "^27.0.0",
      vitest: "^3.2.4",
    }
  );
});

test("Windows packaging exposes the Task 1 Jarvis contract", () => {
  const builder = JSON.parse(fs.readFileSync(path.join(root, "electron-builder.json"), "utf8"));
  const unsignedBuilder = JSON.parse(
    fs.readFileSync(path.join(root, "electron-builder.unsigned-win.json"), "utf8")
  );

  assert.equal(builder.appId, "com.local.jarvis-memory");
  assert.equal(builder.productName, "Jarvis Memory");
  assert.deepEqual(builder.protocols, {
    name: "Jarvis Memory Protocol",
    schemes: ["jarvis-memory"],
  });
  assert.deepEqual(builder.win.target, ["nsis"]);
  assert.equal(
    builder.npmRebuild,
    false,
    "the guarded build script rebuilds only better-sqlite3; electron-builder must not rebuild unrelated native modules"
  );
  assert.equal(
    builder.electronDist,
    "node_modules/electron/dist",
    "Windows packaging must reuse the exact npm-installed Electron runtime instead of downloading it again"
  );
  assert.equal(builder.publish, null);
  assert.equal(unsignedBuilder.win.azureSignOptions, null);
});

test("main process uses the Jarvis Windows app id", () => {
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");

  assert.match(main, /const BASE_WINDOWS_APP_ID = "com\.local\.jarvis-memory";/);
});

test("renderer config allows no tests only before the suite exists", async () => {
  const configPath = path.join(root, "src", "vitest.config.ts");
  const setupPath = path.join(root, "src", "vitest.setup.ts");
  const jarvisPath = path.join(root, "src", "jarvis");
  const rendererPath = path.join(jarvisPath, "renderer");
  const rendererTestsPath = path.join(rendererPath, "__tests__");

  assert.equal(fs.existsSync(configPath), true, "renderer Vitest config must exist");
  assert.equal(fs.existsSync(setupPath), true, "renderer Vitest setup must exist");

  const { loadConfigFromFile } = await import("vite");
  const loadConfig = async () => {
    const result = await loadConfigFromFile({ command: "serve", mode: "test" }, configPath);
    assert.ok(result, "renderer Vitest config must load");
    return result.config;
  };
  const suiteAlreadyExists = fs.existsSync(rendererTestsPath);
  const config = await loadConfig();
  assert.equal(config.root, path.join(root, "src"));
  assert.equal(config.test.environment, "jsdom");
  assert.deepEqual(config.test.setupFiles, ["./vitest.setup.ts"]);
  assert.equal(config.test.passWithNoTests, !suiteAlreadyExists);
  assert.match(fs.readFileSync(setupPath, "utf8"), /import "@testing-library\/jest-dom\/vitest";/);

  if (!suiteAlreadyExists) {
    const jarvisAlreadyExists = fs.existsSync(jarvisPath);
    const rendererAlreadyExists = fs.existsSync(rendererPath);
    fs.mkdirSync(rendererTestsPath, { recursive: true });
    try {
      const strictConfig = await loadConfig();
      assert.equal(strictConfig.test.passWithNoTests, false);
    } finally {
      fs.rmSync(rendererTestsPath, { recursive: true, force: true });
      if (!rendererAlreadyExists) fs.rmSync(rendererPath, { recursive: true, force: true });
      if (!jarvisAlreadyExists) fs.rmSync(jarvisPath, { recursive: true, force: true });
    }
  }
});
