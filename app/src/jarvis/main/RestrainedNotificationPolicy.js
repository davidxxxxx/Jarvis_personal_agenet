"use strict";

function safeNow(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
}

class RestrainedNotificationPolicy {
  evaluate({
    kind,
    todo = null,
    preferences = {},
    context = {},
    now = Date.now(),
  } = {}) {
    const currentTime = safeNow(now);
    if (kind === "candidate_suggestion") {
      return { action: "in_app_only", reason: "candidate_suggestions_never_notify" };
    }
    if (kind === "new_action") {
      return { action: "in_app_badge", reason: "new_actions_are_batched" };
    }
    if (kind === "session_summary") {
      return { action: "in_app_summary", reason: "session_end_single_summary" };
    }
    if (kind !== "todo_reminder") {
      return { action: "suppress", reason: "unsupported_notification_kind" };
    }
    if (
      todo?.verificationState !== "confirmed" ||
      todo?.reminderSource !== "user" ||
      !Number.isSafeInteger(todo?.reminderAt)
    ) {
      return { action: "suppress", reason: "reminder_not_explicitly_confirmed" };
    }
    if (preferences.focusMode === true) {
      return { action: "defer", reason: "focus_mode" };
    }
    if (
      Number.isSafeInteger(preferences.mutedUntil) &&
      preferences.mutedUntil > currentTime
    ) {
      return { action: "defer", reason: "temporarily_muted" };
    }
    if (
      context.fullscreenGame === true ||
      context.meetingActive === true ||
      context.presentationActive === true
    ) {
      return { action: "defer", reason: "active_focus_context" };
    }
    return { action: "notify", reason: "confirmed_user_reminder" };
  }

  mergeDeferred(items = []) {
    const due = items.filter((item) => item?.kind === "todo_reminder");
    if (due.length === 0) return null;
    return {
      title: "Jarvis",
      body:
        due.length === 1
          ? due[0].title
          : `有 ${due.length} 个已确认提醒等待查看`,
      count: due.length,
      itemIds: due
        .map((item) => item.id)
        .filter((id) => typeof id === "string" && id),
    };
  }
}

module.exports = RestrainedNotificationPolicy;
