"use strict";

const path = require("node:path");

function report(result, exitCode) {
  process.stdout.write(JSON.stringify(result));
  process.exitCode = exitCode;
}

try {
  const [modulePath, binaryPath, expectedAbi] = process.argv.slice(2);
  if (
    !path.isAbsolute(modulePath ?? "") ||
    !path.isAbsolute(binaryPath ?? "") ||
    !/^\d+$/.test(expectedAbi ?? "")
  ) {
    report({ ok: false, abi: String(process.versions.modules), kind: "input" }, 1);
  } else {
    const Database = require(modulePath);
    const database = new Database(":memory:", { nativeBinding: binaryPath });
    let value;
    try {
      value = database.prepare("SELECT 1 AS value").get().value;
    } finally {
      database.close();
    }
    const abi = String(process.versions.modules);
    const ok = abi === expectedAbi && value === 1;
    report({ ok, abi, value: ok ? 1 : null, kind: ok ? undefined : "verification" }, ok ? 0 : 1);
  }
} catch {
  report({ ok: false, abi: String(process.versions.modules), kind: "load" }, 1);
}
