const test = require("node:test");
const assert = require("node:assert/strict");
const JarvisRepository = require("../../src/jarvis/main/JarvisRepository");
const RestrainedNotificationPolicy = require("../../src/jarvis/main/RestrainedNotificationPolicy");

function activity(index) {
  const startedAt = new Date(2026, 6, 27, 10, index, 0).getTime();
  return {
    activityId: `activity-${index}`,
    startedAt,
    endedAt: startedAt + 60_000,
    applications: ["tencent_meeting"],
    sourceAttribution: "application_and_microphone",
    statistics: {
      microphoneParticipated: true,
      selfDetected: true,
      speakerCount: 3,
    },
  };
}

function localClassification(index) {
  return {
    activityId: `activity-${index}`,
    category: "social_call",
    confidence: 0.9,
    decision: "adopted",
    source: "local",
    reason: "local_initial_result",
    allowSummary: true,
    allowSuggestions: true,
    allowTodos: false,
    evidenceSegmentIds: [],
  };
}

test("activity corrections stay local and only propose a rule after three similar corrections", (t) => {
  let now = 1_000_000;
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  repository.createSession({
    id: "personalization-session",
    startedAt: 1,
    micDeviceId: "physical-mic",
  });

  const corrections = [];
  for (let index = 0; index < 3; index += 1) {
    const saved = repository.saveActivityClassificationBatch({
      sessionId: "personalization-session",
      activities: [activity(index)],
      classifications: [localClassification(index)],
      createdAt: now,
    });
    now += 1;
    corrections.push(
      repository.correctActivityClassification({
        classificationId: saved[0].id,
        category: "work_meeting",
        correctedAt: now,
      })
    );
    now += 1;
  }

  assert.equal(corrections[0].supportCount, 1);
  assert.equal(corrections[0].proposedRule, null);
  assert.equal(corrections[1].proposedRule, null);
  assert.equal(corrections[2].supportCount, 3);
  assert.equal(corrections[2].proposedRule.state, "proposed");
  assert.equal(repository.listPersonalizationRules().length, 1);

  const base = localClassification(4);
  assert.equal(
    repository.activityClassificationRepository.applyPersonalizationRule(activity(4), base)
      .category,
    "social_call"
  );
  repository.decidePersonalizationRule({
    ruleId: corrections[2].proposedRule.id,
    action: "enable",
    at: now++,
  });
  const learned = repository.activityClassificationRepository.applyPersonalizationRule(
    activity(4),
    base
  );
  assert.equal(learned.category, "work_meeting");
  assert.equal(learned.decision, "adopted");
  assert.match(learned.reason, /enabled_personalization_rule/u);

  assert.throws(
    () =>
      repository.db
        .prepare("UPDATE personalization_feedback SET corrected_value = ?")
        .run("gaming"),
    /immutable/u
  );
});

test("editing a personalization rule changes its target and matching conditions with audit history", (t) => {
  let now = new Date(2026, 6, 27, 10, 0, 0).getTime();
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  repository.createSession({
    id: "editable-rule-session",
    startedAt: 1,
    micDeviceId: "physical-mic",
  });

  let proposedRule;
  for (let index = 0; index < 3; index += 1) {
    const [saved] = repository.saveActivityClassificationBatch({
      sessionId: "editable-rule-session",
      activities: [activity(index)],
      classifications: [localClassification(index)],
      createdAt: now++,
    });
    proposedRule = repository.correctActivityClassification({
      classificationId: saved.id,
      category: "work_meeting",
      correctedAt: now++,
    }).proposedRule;
  }

  const edited = repository.decidePersonalizationRule({
    ruleId: proposedRule.id,
    action: "edit",
    label: "Chrome 上午的本人学习活动",
    targetValue: "learning",
    conditions: {
      applicationKeys: ["chrome"],
      selfParticipated: true,
      speakerCountBucket: "multiple",
      timeBucket: "morning",
    },
    at: now++,
  });

  assert.equal(edited.label, "Chrome 上午的本人学习活动");
  assert.equal(edited.targetValue, "learning");
  assert.deepEqual(edited.rule, {
    features: {
      applicationKeys: ["chrome"],
      selfParticipated: true,
      speakerCountBucket: "multiple",
      timeBucket: "morning",
    },
    category: "learning",
  });
  assert.equal(
    repository.activityClassificationRepository.applyPersonalizationRule(
      {
        ...activity(9),
        applications: ["chrome"],
      },
      localClassification(9)
    ).category,
    "social_call"
  );

  repository.decidePersonalizationRule({
    ruleId: edited.id,
    action: "enable",
    at: now++,
  });
  const learned = repository.activityClassificationRepository.applyPersonalizationRule(
    {
      ...activity(9),
      applications: ["chrome"],
    },
    localClassification(9)
  );
  assert.equal(learned.category, "learning");
  assert.equal(learned.allowSuggestions, false);

  const audit = repository.db
    .prepare(
      `SELECT detail_json FROM personalization_rule_events
       WHERE rule_id = ? AND action = 'edited' ORDER BY occurred_at DESC LIMIT 1`
    )
    .get(edited.id);
  assert.deepEqual(JSON.parse(audit.detail_json).next, {
    label: "Chrome 上午的本人学习活动",
    targetValue: "learning",
    conditions: {
      applicationKeys: ["chrome"],
      selfParticipated: true,
      speakerCountBucket: "multiple",
      timeBucket: "morning",
    },
  });
});

test("activity correction refreshes the corrected session participant snapshot", (t) => {
  const repository = new JarvisRepository(":memory:", { now: () => 1_000 });
  t.after(() => repository.close());
  repository.createSession({
    id: "corrected-session",
    startedAt: 1,
    micDeviceId: "physical-mic",
  });
  const [saved] = repository.saveActivityClassificationBatch({
    sessionId: "corrected-session",
    activities: [activity(0)],
    classifications: [localClassification(0)],
    createdAt: 1_000,
  });
  const refreshes = [];
  repository.refreshSessionParticipantSnapshot = (sessionId, options) => {
    refreshes.push({ sessionId, options });
  };

  const result = repository.correctActivityClassification({
    classificationId: saved.id,
    category: "work_meeting",
    correctedAt: 1_001,
  });

  assert.equal(result.classification.sessionId, "corrected-session");
  assert.deepEqual(refreshes, [{ sessionId: "corrected-session", options: { at: 1_001 } }]);
});

test("durable activity correction survives participant refresh and diagnostic failures", (t) => {
  const diagnostics = [];
  const repository = new JarvisRepository(":memory:", {
    now: () => 2_000,
    log(entry) {
      diagnostics.push(entry);
      throw new Error("diagnostic sink failed");
    },
  });
  t.after(() => repository.close());
  repository.createSession({
    id: "refresh-failure-session",
    startedAt: 1,
    micDeviceId: "physical-mic",
  });
  const [saved] = repository.saveActivityClassificationBatch({
    sessionId: "refresh-failure-session",
    activities: [activity(1)],
    classifications: [localClassification(1)],
    createdAt: 2_000,
  });
  repository.refreshSessionParticipantSnapshot = () => {
    const error = new Error("G:\\private\\speaker-name must not reach diagnostics");
    error.code = "SNAPSHOT_RETRY";
    throw error;
  };

  const result = repository.correctActivityClassification({
    classificationId: saved.id,
    category: "work_meeting",
    correctedAt: 2_001,
  });

  assert.equal(result.classification.category, "work_meeting");
  assert.deepEqual(diagnostics, [
    {
      phase: "activity_correction_participant_refresh",
      state: "deferred",
      sessionId: "refresh-failure-session",
      errorCode: "SNAPSHOT_RETRY",
    },
  ]);
  assert.equal(
    repository.listSessionActivityClassifications("refresh-failure-session")[0].category,
    "work_meeting"
  );
});

test("ignored suggestions lower only the same local fingerprint and remain idempotent", (t) => {
  const repository = new JarvisRepository(":memory:", { now: () => 10 });
  t.after(() => repository.close());

  repository.recordSuggestionDismissalFeedback({
    suggestionId: "suggestion-1",
    summary: "整理腾讯会议纪要",
    occurredAt: 10,
  });
  repository.recordSuggestionDismissalFeedback({
    suggestionId: "suggestion-1",
    summary: "整理腾讯会议纪要",
    occurredAt: 11,
  });

  assert.equal(repository.getSuggestionPersonalizationPenalty("整理腾讯会议纪要"), 0.15);
  assert.equal(repository.getSuggestionPersonalizationPenalty("复习英语"), 0);
});

test("focus and temporary mute preferences are durable and notification policy is strict", (t) => {
  let now = 20_000;
  const repository = new JarvisRepository(":memory:", { now: () => now });
  t.after(() => repository.close());
  const policy = new RestrainedNotificationPolicy();

  assert.equal(repository.getNotificationPreferences().effectiveMuted, false);
  const muted = repository.setNotificationPreferences({
    focusMode: false,
    mutedUntil: now + 60_000,
    at: now,
  });
  assert.equal(muted.effectiveMuted, true);
  assert.deepEqual(
    policy.evaluate({
      kind: "candidate_suggestion",
      preferences: muted,
      now,
    }),
    { action: "in_app_only", reason: "candidate_suggestions_never_notify" }
  );
  assert.deepEqual(
    policy.evaluate({
      kind: "todo_reminder",
      todo: {
        verificationState: "pending_confirmation",
        reminderSource: "user",
        reminderAt: now,
      },
      preferences: {},
      now,
    }),
    { action: "suppress", reason: "reminder_not_explicitly_confirmed" }
  );
  assert.deepEqual(
    policy.evaluate({
      kind: "todo_reminder",
      todo: {
        verificationState: "confirmed",
        reminderSource: "user",
        reminderAt: now,
      },
      preferences: {},
      context: { fullscreenGame: true },
      now,
    }),
    { action: "defer", reason: "active_focus_context" }
  );
  assert.deepEqual(
    policy.evaluate({
      kind: "todo_reminder",
      todo: {
        verificationState: "confirmed",
        reminderSource: "user",
        reminderAt: now,
      },
      preferences: {},
      now,
    }),
    { action: "notify", reason: "confirmed_user_reminder" }
  );
});
