const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHANNELS,
  normalizeSuggestionDecisionInput,
  normalizeMemoryConflictResolutionInput,
  normalizeKnowledgeTodoCompletionInput,
  normalizeKnowledgeTodoDecisionInput,
  normalizeActionCenterReadInput,
} = require("../../src/jarvis/shared/contracts");

test("knowledge channels are narrow and versioned", () => {
  assert.equal(CHANNELS.getActionCenterWatermark, "jarvis:memory:v2-action-watermark");
  assert.equal(CHANNELS.getActionCenterDelta, "jarvis:memory:v2-action-delta");
  assert.equal(CHANNELS.markActionCenterRead, "jarvis:memory:v2-action-read");
  assert.equal(CHANNELS.getKnowledgeOverview, "jarvis:memory:v2-overview");
  assert.equal(CHANNELS.decideKnowledgeSuggestion, "jarvis:memory:v2-suggestion-decision");
  assert.equal(CHANNELS.resolveKnowledgeConflict, "jarvis:memory:v2-conflict-resolve");
  assert.equal(CHANNELS.completeKnowledgeTodo, "jarvis:memory:v2-todo-complete");
  assert.equal(CHANNELS.decideKnowledgeTodo, "jarvis:memory:v2-todo-decision");
});

test("action read boundaries accept one exact durable sequence", () => {
  assert.deepEqual(normalizeActionCenterReadInput({ throughSequence: 42 }), {
    throughSequence: 42,
  });
  for (const input of [
    null,
    {},
    { throughSequence: -1 },
    { throughSequence: 1.5 },
    { throughSequence: 1, extra: true },
  ]) {
    assert.throws(() => normalizeActionCenterReadInput(input));
  }
});

test("suggestion decisions accept exact ids and a closed action", () => {
  assert.deepEqual(
    normalizeSuggestionDecisionInput({ suggestionId: "suggestion_1", action: "accept" }),
    { suggestionId: "suggestion_1", action: "accept" }
  );
  assert.deepEqual(
    normalizeSuggestionDecisionInput({ suggestionId: "suggestion_1", action: "dismiss" }),
    { suggestionId: "suggestion_1", action: "dismiss" }
  );
  for (const input of [
    null,
    [],
    { suggestionId: "suggestion_1" },
    { suggestionId: "suggestion_1", action: "convert" },
    { suggestionId: "../private", action: "accept" },
    { suggestionId: "suggestion_1", action: "accept", at: 1 },
  ]) {
    assert.throws(() => normalizeSuggestionDecisionInput(input));
  }
});

test("conflict resolution and todo completion reject renderer-owned state", () => {
  assert.deepEqual(
    normalizeMemoryConflictResolutionInput({
      conflictGroupId: "conflict_1",
      selectedMemoryItemId: "memory_1",
    }),
    { conflictGroupId: "conflict_1", selectedMemoryItemId: "memory_1" }
  );
  assert.deepEqual(normalizeKnowledgeTodoCompletionInput({ todoId: "todo_1" }), {
    todoId: "todo_1",
  });
  assert.throws(() =>
    normalizeMemoryConflictResolutionInput({
      conflictGroupId: "conflict_1",
      selectedMemoryItemId: "memory_1",
      actor: "user",
    })
  );
  assert.throws(() => normalizeKnowledgeTodoCompletionInput({ todoId: "todo_1", status: "open" }));
  for (const action of ["confirm", "dismiss", "reopen"]) {
    assert.deepEqual(normalizeKnowledgeTodoDecisionInput({ todoId: "todo_1", action }), {
      todoId: "todo_1",
      action,
    });
  }
  assert.throws(() =>
    normalizeKnowledgeTodoDecisionInput({ todoId: "todo_1", action: "complete" })
  );
});
