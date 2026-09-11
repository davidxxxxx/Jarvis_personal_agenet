const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DISMISS_REASON_CODES,
  KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION,
  KnowledgeActionLifecycleError,
  applyKnowledgeActionCommand,
  createKnowledgeActionState,
  reduceKnowledgeActionEvents,
  toKnowledgeActionNonSensitiveMetadata,
  validateKnowledgeActionCommand,
  validateKnowledgeActionEvent,
} = require("../../src/jarvis/main/KnowledgeActionLifecycle");

const BASE_AT = 1_786_000_000_000;

function command(type, overrides = {}) {
  return {
    commandId: `command-${type}`,
    type,
    at: BASE_AT,
    ...overrides,
  };
}

function apply(state, nextCommand) {
  return applyKnowledgeActionCommand(state, nextCommand);
}

function lifecycleError(code) {
  return (error) => error instanceof KnowledgeActionLifecycleError && error.code === code;
}

test("manual_create creates a confirmed local Todo through one append-only event", () => {
  const initial = createKnowledgeActionState();
  const result = apply(
    initial,
    command("manual_create", {
      todoId: "todo-manual-1",
      title: "整理会议纪要",
      dueText: null,
    })
  );

  assert.equal(result.status, "applied");
  assert.equal(result.event.schemaVersion, KNOWLEDGE_ACTION_EVENT_SCHEMA_VERSION);
  assert.equal(result.event.entityKind, "todo");
  assert.deepEqual(result.state.todos["todo-manual-1"], {
    id: "todo-manual-1",
    title: "整理会议纪要",
    dueText: null,
    status: "open",
    verificationState: "confirmed",
    pinned: false,
    urgency: "normal",
    sourceKind: "manual",
    sourceSessionId: null,
    sourceSegmentIds: [],
    sourceSuggestionId: null,
    convertedFromSuggestion: false,
    hasReminder: false,
    userModified: false,
    dismissedFromVerificationState: null,
    dismissReasonCode: null,
    dismissLocalNote: null,
  });
  assert.equal(result.state.events.length, 1);
  assert.equal(initial.events.length, 0, "the reducer must not mutate its input state");
});

test("transcript_create stores only stable segment references and rejects raw quote fields", () => {
  const result = apply(
    createKnowledgeActionState(),
    command("transcript_create", {
      todoId: "todo-transcript-1",
      title: "把方案发给张三",
      dueText: "明天",
      sessionId: "session-1",
      segmentIds: ["segment-2", "segment-1"],
    })
  );

  assert.equal(result.state.todos["todo-transcript-1"].sourceKind, "transcript");
  assert.deepEqual(result.state.todos["todo-transcript-1"].sourceSegmentIds, [
    "segment-2",
    "segment-1",
  ]);
  assert.throws(
    () =>
      validateKnowledgeActionCommand(
        command("transcript_create", {
          todoId: "todo-transcript-2",
          title: "不应接受原文",
          dueText: null,
          sessionId: "session-1",
          segmentIds: ["segment-1"],
          quote: "sensitive transcript text",
        })
      ),
    lifecycleError("KNOWLEDGE_ACTION_INVALID_COMMAND")
  );
  assert.throws(
    () =>
      validateKnowledgeActionCommand(
        command("transcript_create", {
          todoId: "todo-transcript-2",
          title: "重复证据",
          dueText: null,
          sessionId: "session-1",
          segmentIds: ["segment-1", "segment-1"],
        })
      ),
    lifecycleError("KNOWLEDGE_ACTION_INVALID_COMMAND")
  );
});

test("todo_dismiss records a closed reason and local-only note, then restores prior verification", () => {
  let state = createKnowledgeActionState({
    todos: [
      {
        id: "todo-pending-1",
        title: "确认截止时间",
        dueText: null,
        status: "open",
        verificationState: "pending_confirmation",
      },
    ],
  });
  const dismissed = apply(
    state,
    command("todo_dismiss", {
      commandId: "command-dismiss-pending",
      todoId: "todo-pending-1",
      reasonCode: "wrong_context",
      localNote: "这是视频里的台词，不是我的任务。",
    })
  );
  state = dismissed.state;

  assert.equal(state.todos["todo-pending-1"].status, "dismissed");
  assert.equal(state.todos["todo-pending-1"].verificationState, "dismissed");
  assert.equal(
    state.todos["todo-pending-1"].dismissedFromVerificationState,
    "pending_confirmation"
  );
  assert.equal(state.todos["todo-pending-1"].dismissReasonCode, "wrong_context");
  assert.equal(state.todos["todo-pending-1"].dismissLocalNote, "这是视频里的台词，不是我的任务。");
  assert.deepEqual(toKnowledgeActionNonSensitiveMetadata(dismissed.event), {
    schemaVersion: 1,
    type: "todo_dismiss",
    entityKind: "todo",
    reasonCode: "wrong_context",
  });

  const restored = apply(
    state,
    command("todo_restore", {
      commandId: "command-restore-pending",
      todoId: "todo-pending-1",
      at: BASE_AT + 1,
    })
  );
  assert.equal(restored.state.todos["todo-pending-1"].status, "open");
  assert.equal(restored.state.todos["todo-pending-1"].verificationState, "pending_confirmation");
  assert.equal(restored.state.todos["todo-pending-1"].dismissReasonCode, null);
  assert.equal(restored.state.todos["todo-pending-1"].dismissLocalNote, null);
});

test("suggestion_dismiss and suggestion_restore preserve a conservative reversible lifecycle", () => {
  let state = createKnowledgeActionState({
    suggestions: [{ id: "suggestion-1", state: "proposed" }],
  });
  state = apply(
    state,
    command("suggestion_dismiss", {
      suggestionId: "suggestion-1",
      reasonCode: "low_value",
    })
  ).state;
  assert.equal(state.suggestions["suggestion-1"].state, "dismissed");
  assert.equal(state.suggestions["suggestion-1"].dismissReasonCode, "low_value");

  state = apply(
    state,
    command("suggestion_restore", {
      commandId: "command-suggestion-restore",
      suggestionId: "suggestion-1",
      at: BASE_AT + 1,
    })
  ).state;
  assert.equal(state.suggestions["suggestion-1"].state, "proposed");
  assert.equal(state.suggestions["suggestion-1"].dismissReasonCode, null);

  assert.throws(
    () =>
      validateKnowledgeActionCommand(
        command("suggestion_dismiss", {
          suggestionId: "suggestion-1",
          reasonCode: "low_value",
          localNote: "must remain local but suggestions do not accept notes",
        })
      ),
    lifecycleError("KNOWLEDGE_ACTION_INVALID_COMMAND")
  );
});

test("suggestion_accept creates a linked Todo and a safe undo removes only that conversion", () => {
  let state = createKnowledgeActionState({
    suggestions: [{ id: "suggestion-1", state: "proposed" }],
  });
  state = apply(
    state,
    command("suggestion_accept", {
      suggestionId: "suggestion-1",
      todoId: "todo-from-suggestion-1",
      title: "复盘今天的会议",
      dueText: null,
    })
  ).state;

  assert.equal(state.suggestions["suggestion-1"].state, "accepted");
  assert.equal(state.suggestions["suggestion-1"].convertedTodoId, "todo-from-suggestion-1");
  assert.equal(state.todos["todo-from-suggestion-1"].sourceSuggestionId, "suggestion-1");

  const undone = apply(
    state,
    command("suggestion_accept_undo", {
      commandId: "command-suggestion-accept-undo",
      suggestionId: "suggestion-1",
      at: BASE_AT + 1,
    })
  );
  assert.equal(undone.state.suggestions["suggestion-1"].state, "proposed");
  assert.equal(undone.state.suggestions["suggestion-1"].convertedTodoId, null);
  assert.equal(undone.state.todos["todo-from-suggestion-1"], undefined);
});

for (const [name, mutate] of [
  [
    "edited",
    (state) =>
      apply(
        state,
        command("title_due_edit", {
          commandId: "command-edit-converted",
          todoId: "todo-from-suggestion-1",
          title: "用户修改后的标题",
          at: BASE_AT + 1,
        })
      ).state,
  ],
  [
    "pinned",
    (state) =>
      apply(
        state,
        command("todo_pin", {
          commandId: "command-pin-converted",
          todoId: "todo-from-suggestion-1",
          at: BASE_AT + 1,
        })
      ).state,
  ],
]) {
  test(`suggestion_accept_undo fails closed after the converted Todo was ${name}`, () => {
    let state = createKnowledgeActionState({
      suggestions: [{ id: "suggestion-1", state: "proposed" }],
    });
    state = apply(
      state,
      command("suggestion_accept", {
        suggestionId: "suggestion-1",
        todoId: "todo-from-suggestion-1",
        title: "候选建议",
        dueText: null,
      })
    ).state;
    state = mutate(state);
    const before = state;

    assert.throws(
      () =>
        apply(
          state,
          command("suggestion_accept_undo", {
            commandId: `command-undo-${name}`,
            suggestionId: "suggestion-1",
            at: BASE_AT + 2,
          })
        ),
      lifecycleError("KNOWLEDGE_ACTION_ACCEPT_UNDO_BLOCKED")
    );
    assert.equal(state, before, "a blocked transition must not mutate state");
  });
}

test("suggestion_accept_undo fails closed when the converted Todo has a reminder", () => {
  const state = createKnowledgeActionState({
    suggestions: [
      {
        id: "suggestion-accepted",
        state: "accepted",
        convertedTodoId: "todo-with-reminder",
      },
    ],
    todos: [
      {
        id: "todo-with-reminder",
        title: "已设置提醒",
        status: "open",
        verificationState: "confirmed",
        sourceKind: "suggestion",
        sourceSuggestionId: "suggestion-accepted",
        convertedFromSuggestion: true,
        hasReminder: true,
      },
    ],
  });

  assert.throws(
    () =>
      apply(
        state,
        command("suggestion_accept_undo", {
          suggestionId: "suggestion-accepted",
        })
      ),
    lifecycleError("KNOWLEDGE_ACTION_ACCEPT_UNDO_BLOCKED")
  );
});

test("pin, urgency and title/due commands update open Todos and are reversible where defined", () => {
  let state = apply(
    createKnowledgeActionState(),
    command("manual_create", {
      todoId: "todo-1",
      title: "原始标题",
      dueText: null,
    })
  ).state;
  state = apply(
    state,
    command("todo_pin", {
      commandId: "command-pin",
      todoId: "todo-1",
      at: BASE_AT + 1,
    })
  ).state;
  state = apply(
    state,
    command("urgency_set", {
      commandId: "command-urgent",
      todoId: "todo-1",
      urgency: "urgent",
      at: BASE_AT + 2,
    })
  ).state;
  state = apply(
    state,
    command("title_due_edit", {
      commandId: "command-edit",
      todoId: "todo-1",
      title: "更新标题",
      dueText: "周五",
      at: BASE_AT + 3,
    })
  ).state;
  state = apply(
    state,
    command("todo_unpin", {
      commandId: "command-unpin",
      todoId: "todo-1",
      at: BASE_AT + 4,
    })
  ).state;

  assert.deepEqual(
    {
      pinned: state.todos["todo-1"].pinned,
      urgency: state.todos["todo-1"].urgency,
      title: state.todos["todo-1"].title,
      dueText: state.todos["todo-1"].dueText,
      userModified: state.todos["todo-1"].userModified,
    },
    {
      pinned: false,
      urgency: "urgent",
      title: "更新标题",
      dueText: "周五",
      userModified: true,
    }
  );
});

test("commandId is idempotent for an identical command and conflicts on payload reuse", () => {
  const create = command("manual_create", {
    todoId: "todo-idempotent",
    title: "幂等创建",
    dueText: null,
  });
  const first = apply(createKnowledgeActionState(), create);
  const second = apply(first.state, { ...create });

  assert.equal(second.status, "already_applied");
  assert.equal(second.state, first.state);
  assert.deepEqual(second.event, first.event);
  assert.equal(second.state.events.length, 1);

  assert.throws(
    () => apply(first.state, { ...create, title: "复用同一 commandId 的不同负载" }),
    lifecycleError("KNOWLEDGE_ACTION_COMMAND_ID_CONFLICT")
  );
});

test("illegal state transitions and no-op edits fail closed", () => {
  const proposed = createKnowledgeActionState({
    suggestions: [{ id: "suggestion-1", state: "proposed" }],
    todos: [
      {
        id: "todo-1",
        title: "一个待办",
        dueText: null,
        status: "open",
        verificationState: "confirmed",
      },
    ],
  });

  for (const invalid of [
    command("suggestion_restore", { suggestionId: "suggestion-1" }),
    command("todo_restore", { todoId: "todo-1" }),
    command("todo_unpin", { todoId: "todo-1" }),
    command("urgency_set", { todoId: "todo-1", urgency: "normal" }),
    command("title_due_edit", { todoId: "todo-1", title: "一个待办" }),
  ]) {
    assert.throws(
      () => apply(proposed, invalid),
      lifecycleError("KNOWLEDGE_ACTION_INVALID_TRANSITION")
    );
  }
  assert.equal(proposed.events.length, 0);
});

test("dismiss reasons are a finite code-only enumeration", () => {
  assert.deepEqual(DISMISS_REASON_CODES, [
    "not_relevant",
    "already_done",
    "not_mine",
    "wrong_context",
    "low_value",
    "other",
  ]);
  assert.equal(
    DISMISS_REASON_CODES.every((reason) => /^[a-z_]+$/u.test(reason)),
    true
  );
  assert.throws(
    () =>
      validateKnowledgeActionCommand(
        command("todo_dismiss", {
          todoId: "todo-1",
          reasonCode: "视频里的台词",
        })
      ),
    lifecycleError("KNOWLEDGE_ACTION_INVALID_COMMAND")
  );
});

test("event replay is deterministic and rejects a tampered command fingerprint", () => {
  let result = apply(
    createKnowledgeActionState(),
    command("manual_create", {
      todoId: "todo-replay",
      title: "回放测试",
      dueText: null,
    })
  );
  result = apply(
    result.state,
    command("todo_pin", {
      commandId: "command-replay-pin",
      todoId: "todo-replay",
      at: BASE_AT + 1,
    })
  );

  const replayed = reduceKnowledgeActionEvents(createKnowledgeActionState(), result.state.events);
  assert.deepEqual(replayed, result.state);
  assert.deepEqual(validateKnowledgeActionEvent(result.event), result.event);

  assert.throws(
    () => validateKnowledgeActionEvent({ ...result.event, commandFingerprint: "0".repeat(64) }),
    lifecycleError("KNOWLEDGE_ACTION_INVALID_EVENT")
  );
});
