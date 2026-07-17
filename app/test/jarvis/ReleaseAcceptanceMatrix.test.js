const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MATRIX_PATH = path.join(ROOT, "docs", "testing", "jarvis-phase4-release-acceptance.md");
const REQUIRED_GATES = new Set([
  "AUTO_REGRESSION",
  "STATIC_GATES",
  "VIRTUAL_CAPTURE_3H",
  "VIRTUAL_RESOURCE_3H",
  "WINDOWS_PACKAGE",
  "NATIVE_ABI",
  "PACKAGED_OFFLINE",
  "PACKAGED_RESTART",
  "LEGACY_FIXTURE",
  "REAL_MIC",
  "CUDA_WHISPER",
  "CAMPP_IDENTITY",
  "MINIMAX_LIVE",
]);
const PHYSICAL_OR_NETWORK_GATES = new Set([
  "REAL_MIC",
  "CUDA_WHISPER",
  "CAMPP_IDENTITY",
  "MINIMAX_LIVE",
]);
const ALLOWED_STATUSES = new Set(["PASS", "NOT RUN", "BLOCKED"]);

function matrixRows(markdown) {
  const start = "<!-- RELEASE_ACCEPTANCE_MATRIX_START -->";
  const end = "<!-- RELEASE_ACCEPTANCE_MATRIX_END -->";
  const section = markdown.slice(markdown.indexOf(start) + start.length, markdown.indexOf(end));
  return section
    .split(/\r?\n/u)
    .filter((line) => /^\|\s+[A-Z0-9_]+\s+\|/u.test(line))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim());
      assert.equal(cells.length, 5, `matrix row must have five cells: ${line}`);
      return {
        id: cells[0],
        gate: cells[1],
        status: cells[2].replaceAll("`", ""),
        evidence: cells[3],
        command: cells[4],
      };
    });
}

test("Phase 4 release matrix is complete, truthful, and G-drive scoped", () => {
  const markdown = fs.readFileSync(MATRIX_PATH, "utf8");
  assert.equal(markdown.includes("<!-- RELEASE_ACCEPTANCE_MATRIX_START -->"), true);
  assert.equal(markdown.includes("<!-- RELEASE_ACCEPTANCE_MATRIX_END -->"), true);
  assert.doesNotMatch(markdown, /(?:^|[^A-Za-z])[A-Fa-f]:\\/u);
  assert.match(markdown, /`PASS`.*actual execution/isu);
  assert.match(markdown, /`NOT RUN`.*not executed/isu);
  assert.match(markdown, /`BLOCKED`.*prerequisite/isu);

  const rows = matrixRows(markdown);
  assert.deepEqual(new Set(rows.map((row) => row.id)), REQUIRED_GATES);
  assert.equal(rows.length, REQUIRED_GATES.size);
  for (const row of rows) {
    assert.equal(ALLOWED_STATUSES.has(row.status), true, `${row.id} has invalid status`);
    assert.match(row.command, /G:\\/u, `${row.id} command must be explicitly G-drive scoped`);
    if (row.status === "PASS") {
      assert.match(row.evidence, /observed=/u, `${row.id} PASS requires observed time`);
      assert.match(row.evidence, /commit=/u, `${row.id} PASS requires a commit`);
      assert.match(row.evidence, /evidence=G:\\/u, `${row.id} PASS requires a G-drive artifact`);
    } else if (row.status === "NOT RUN") {
      assert.match(row.evidence, /^Not executed:/u, `${row.id} must say it was not executed`);
    } else {
      assert.match(row.evidence, /^blocker=/u, `${row.id} BLOCKED requires a prerequisite`);
    }
    if (PHYSICAL_OR_NETWORK_GATES.has(row.id) && row.status === "PASS") {
      assert.match(row.evidence, /artifact=G:\\/u, `${row.id} PASS requires the tested artifact`);
      assert.match(row.evidence, /consent=/u, `${row.id} PASS requires recorded consent`);
    }
  }
  for (const id of ["PACKAGED_OFFLINE", "PACKAGED_RESTART"]) {
    const row = rows.find((candidate) => candidate.id === id);
    assert.match(row.command, /npm run smoke:win:unpacked/u, `${id} must use the unpacked harness`);
    assert.match(
      row.command,
      /--runtime-root G:\\Jarvis\\\.runtime-cache\\packaged-smoke/u,
      `${id} harness must keep runtime artifacts on G:`
    );
  }
});

test("TESTING index links the canonical Phase 4 release matrix and machine gate", () => {
  const index = fs.readFileSync(path.join(ROOT, "docs", "TESTING.md"), "utf8");
  assert.match(index, /testing\/jarvis-phase4-release-acceptance\.md/u);
  assert.match(index, /ReleaseAcceptanceMatrix\.test\.js/u);
});
