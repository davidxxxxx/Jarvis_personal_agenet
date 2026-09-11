"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { CHANNELS, normalizeKnowledgeActionInput } = require("../../src/jarvis/shared/contracts");

test("knowledge action IPC uses one versioned closed channel", () => {
  assert.equal(CHANNELS.applyKnowledgeAction, "jarvis:memory:v2-knowledge-action");
  assert.deepEqual(
    normalizeKnowledgeActionInput({
      commandId: "command_manual_1",
      type: "manual_create",
      todoId: "todo_manual_1",
      title: "整理会议纪要",
      dueText: null,
    }),
    {
      commandId: "command_manual_1",
      type: "manual_create",
      todoId: "todo_manual_1",
      title: "整理会议纪要",
      dueText: null,
    }
  );
});

test("transcript action accepts stable references but rejects raw transcript fields", () => {
  assert.deepEqual(
    normalizeKnowledgeActionInput({
      commandId: "command_transcript_1",
      type: "transcript_create",
      todoId: "todo_transcript_1",
      title: "发送方案",
      dueText: "明天",
      sessionId: "session_1",
      segmentIds: ["segment_1", "segment_2"],
    }).segmentIds,
    ["segment_1", "segment_2"]
  );
  assert.throws(
    () =>
      normalizeKnowledgeActionInput({
        commandId: "command_transcript_2",
        type: "transcript_create",
        todoId: "todo_transcript_2",
        title: "发送方案",
        dueText: null,
        sessionId: "session_1",
        segmentIds: ["segment_1"],
        quote: "raw transcript must not cross this contract",
      }),
    /invalid keys/i
  );
});

test("dismissal has a finite reason code and the renderer cannot choose timestamps", () => {
  assert.deepEqual(
    normalizeKnowledgeActionInput({
      commandId: "command_dismiss_1",
      type: "todo_dismiss",
      todoId: "todo_1",
      reasonCode: "wrong_context",
      localNote: "这是视频台词。",
    }),
    {
      commandId: "command_dismiss_1",
      type: "todo_dismiss",
      todoId: "todo_1",
      reasonCode: "wrong_context",
      localNote: "这是视频台词。",
    }
  );
  assert.throws(
    () =>
      normalizeKnowledgeActionInput({
        commandId: "command_dismiss_2",
        type: "todo_dismiss",
        todoId: "todo_1",
        reasonCode: "whatever_the_model_said",
      }),
    /reason/i
  );
  assert.throws(
    () =>
      normalizeKnowledgeActionInput({
        commandId: "command_dismiss_3",
        type: "todo_dismiss",
        todoId: "todo_1",
        reasonCode: "other",
        at: 1,
      }),
    /invalid keys/i
  );
});

test("edit, urgency, restore and suggestion undo shapes are closed", () => {
  const inputs = [
    {
      commandId: "command_edit_1",
      type: "title_due_edit",
      todoId: "todo_1",
      dueText: null,
    },
    {
      commandId: "command_urgent_1",
      type: "urgency_set",
      todoId: "todo_1",
      urgency: "urgent",
    },
    {
      commandId: "command_restore_1",
      type: "todo_restore",
      todoId: "todo_1",
    },
    {
      commandId: "command_undo_1",
      type: "suggestion_accept_undo",
      suggestionId: "suggestion_1",
    },
  ];
  for (const input of inputs) assert.deepEqual(normalizeKnowledgeActionInput(input), input);
  assert.throws(
    () =>
      normalizeKnowledgeActionInput({
        commandId: "command_edit_empty",
        type: "title_due_edit",
        todoId: "todo_1",
      }),
    /empty/i
  );
});
