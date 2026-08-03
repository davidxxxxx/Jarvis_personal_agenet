"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CHANNELS,
  normalizeLearningGoalCreateInput,
  normalizeLearningGoalEditInput,
  normalizeLearningGoalIdInput,
} = require("../../src/jarvis/shared/contracts");

test("learning goal channels are explicit and operation-specific", () => {
  assert.deepEqual(
    {
      list: CHANNELS.listLearningGoals,
      create: CHANNELS.createLearningGoal,
      edit: CHANNELS.editLearningGoal,
      archive: CHANNELS.archiveLearningGoal,
      restore: CHANNELS.restoreLearningGoal,
      delete: CHANNELS.deleteLearningGoal,
    },
    {
      list: "jarvis:learning-goals:list",
      create: "jarvis:learning-goals:create",
      edit: "jarvis:learning-goals:edit",
      archive: "jarvis:learning-goals:archive",
      restore: "jarvis:learning-goals:restore",
      delete: "jarvis:learning-goals:delete",
    }
  );
});

test("learning goal inputs carry only normalized titles and local opaque ids", () => {
  assert.deepEqual(normalizeLearningGoalCreateInput({ title: "  学习   英语  " }), {
    title: "学习 英语",
  });
  assert.deepEqual(
    normalizeLearningGoalEditInput({ goalId: "learning-goal_1", title: "复习口语" }),
    { goalId: "learning-goal_1", title: "复习口语" }
  );
  assert.deepEqual(normalizeLearningGoalIdInput({ goalId: "learning-goal_1" }), {
    goalId: "learning-goal_1",
  });
});

test("learning goal contracts reject timestamps, extra context, paths, and unbounded titles", () => {
  for (const input of [
    { title: "英语", at: 1 },
    { title: "英语", sessionId: "session-1" },
    { title: "英语", personName: "private-name" },
    { title: "" },
    { title: "x".repeat(501) },
    { title: `valid${String.fromCharCode(0)}hidden` },
  ]) {
    assert.throws(() => normalizeLearningGoalCreateInput(input));
  }
  assert.throws(() => normalizeLearningGoalEditInput({ goalId: "../private", title: "英语" }));
  assert.throws(() => normalizeLearningGoalEditInput({ goalId: "goal-1", title: "英语", at: 1 }));
  assert.throws(() => normalizeLearningGoalIdInput({ goalId: "goal-1", action: "delete" }));
});
