const test = require("node:test");
const assert = require("node:assert/strict");
const { validateAnalysisPayload } = require("../../src/jarvis/main/JarvisAnalysisSchema");

function payload() {
  return {
    summary: "讨论了产品交付。",
    topics: [{ title: "产品交付", description: "范围和时间", evidenceSegmentIds: ["seg-1"] }],
    memories: [{ type: "decision", content: "周五交付", personRef: "self", topicRef: "产品交付", confidence: 0.9, evidenceSegmentIds: ["seg-1"] }],
    todos: [{ content: "完成验收", ownerRef: "self", dueDate: null, topicRef: "产品交付", evidenceSegmentIds: ["seg-1"] }],
    decisions: ["周五交付"],
    suggestions: [{ content: "补充验收清单", reason: "当前范围不完整" }],
  };
}

test("accepts a grounded strict analysis payload", () => {
  assert.deepEqual(validateAnalysisPayload(payload(), new Set(["seg-1"])), payload());
});

test("rejects unknown evidence, extra fields, and unsupported memory types", () => {
  const unknown = payload();
  unknown.todos[0].evidenceSegmentIds = ["seg-other"];
  assert.throws(() => validateAnalysisPayload(unknown, new Set(["seg-1"])), /unknown evidence/);

  const extra = payload();
  extra.untrusted = true;
  assert.throws(() => validateAnalysisPayload(extra, new Set(["seg-1"])), /unknown field/);

  const unsupported = payload();
  unsupported.memories[0].type = "suggestion";
  assert.throws(() => validateAnalysisPayload(unsupported, new Set(["seg-1"])), /memory type/);
});
