const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CHANNELS,
  normalizeSuggestionDecisionInput,
  normalizeMemoryConflictResolutionInput,
  normalizeKnowledgeTodoCompletionInput,
} = require("../../src/jarvis/shared/contracts");

test("knowledge channels are narrow and versioned", () => {
  assert.equal(CHANNELS.getKnowledgeOverview, "jarvis:memory:v2-overview");
  assert.equal(CHANNELS.decideKnowledgeSuggestion, "jarvis:memory:v2-suggestion-decision");
  assert.equal(CHANNELS.resolveKnowledgeConflict, "jarvis:memory:v2-conflict-resolve");
  assert.equal(CHANNELS.completeKnowledgeTodo, "jarvis:memory:v2-todo-complete");
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
});
