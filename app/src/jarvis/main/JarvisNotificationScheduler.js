"use strict";

const RestrainedNotificationPolicy = require("./RestrainedNotificationPolicy");

const DEFAULT_MAX_SLEEP_MS = 60_000;
const DEFAULT_DEFERRED_POLL_MS = 15_000;
const DEFAULT_NOTIFICATION_CONFIRMATION_TIMEOUT_MS = 5_000;
const MAX_TIMER_MS = 2_147_000_000;

function safeDelay(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive safe timer delay`);
  }
  return value;
}

function reminderIdentity(item) {
  return { todoId: item.todoId, generation: item.generation };
}

function notificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createElectronNotificationDelivery({
  Notification,
  onClick,
  confirmationTimeoutMs = DEFAULT_NOTIFICATION_CONFIRMATION_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof Notification !== "function") {
    throw new TypeError("Electron Notification constructor is required");
  }
  if (typeof onClick !== "function") throw new TypeError("notification click handler is required");
  if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
    throw new TypeError("notification acknowledgement timers are required");
  }
  const timeoutMs = safeDelay(confirmationTimeoutMs, "notification confirmation timeout");

  return ({ title, body } = {}) => {
    if (typeof title !== "string" || !title || typeof body !== "string" || !body) {
      throw new TypeError("notification title and body are required");
    }
    if (typeof Notification.isSupported === "function" && !Notification.isSupported()) {
      throw notificationError(
        "JARVIS_OS_NOTIFICATIONS_UNAVAILABLE",
        "Windows notifications are unavailable"
      );
    }

    return new Promise((resolve, reject) => {
      let notification = null;
      let timer = null;
      let settled = false;
      const removeAcknowledgementListeners = () => {
        if (!notification || typeof notification.removeListener !== "function") return;
        notification.removeListener("show", onShow);
        notification.removeListener("failed", onFailed);
      };
      const settle = (callback, value, { close = false } = {}) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutImpl(timer);
        timer = null;
        removeAcknowledgementListeners();
        if (close) {
          try {
            notification?.close?.();
          } catch {
            // A failed or timed-out native notification is already being retried durably.
          }
        }
        callback(value);
      };
      const onShow = () => settle(resolve);
      const onFailed = () =>
        settle(
          reject,
          notificationError(
            "JARVIS_OS_NOTIFICATION_DELIVERY_FAILED",
            "Windows notification delivery failed"
          ),
          { close: true }
        );

      try {
        notification = new Notification({ title, body });
        notification.once("show", onShow);
        notification.once("failed", onFailed);
        notification.on("click", () => {
          try {
            void Promise.resolve(onClick()).catch(() => {});
          } catch {
            // Opening the control panel is best-effort after Windows already showed the reminder.
          }
        });
        timer = setTimeoutImpl(() => {
          settle(
            reject,
            notificationError(
              "JARVIS_OS_NOTIFICATION_CONFIRMATION_TIMEOUT",
              "Windows notification acknowledgement timed out"
            ),
            { close: true }
          );
        }, timeoutMs);
        timer?.unref?.();
        notification.show();
      } catch (error) {
        settle(reject, error, { close: true });
      }
    });
  };
}

function activeFocusContext(context) {
  return Boolean(
    context?.fullscreenGame === true ||
    context?.meetingActive === true ||
    context?.presentationActive === true
  );
}

function normalizeFocusContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new TypeError("notification focus context is unavailable");
    error.code = "JARVIS_NOTIFICATION_CONTEXT_UNAVAILABLE";
    throw error;
  }
  const keys = ["fullscreenGame", "meetingActive", "presentationActive"];
  if (keys.some((key) => typeof value[key] !== "boolean")) {
    const error = new TypeError("notification focus context is incomplete");
    error.code = "JARVIS_NOTIFICATION_CONTEXT_INCOMPLETE";
    throw error;
  }
  return {
    fullscreenGame: value.fullscreenGame,
    meetingActive: value.meetingActive,
    presentationActive: value.presentationActive,
  };
}

class JarvisNotificationScheduler {
  constructor({
    repository,
    policy = new RestrainedNotificationPolicy(),
    notify,
    contextProvider = async () => null,
    now = Date.now,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    maxSleepMs = DEFAULT_MAX_SLEEP_MS,
    deferredPollMs = DEFAULT_DEFERRED_POLL_MS,
    log = () => {},
  } = {}) {
    const repositoryMethods = [
      "getNotificationPreferences",
      "reconcileTodoReminders",
      "listDueTodoReminders",
      "getNextTodoReminderAt",
      "deferTodoReminders",
      "claimTodoReminderDelivery",
      "releaseTodoReminderDelivery",
    ];
    for (const method of repositoryMethods) {
      if (!repository || typeof repository[method] !== "function") {
        throw new TypeError(`repository.${method} must be a function`);
      }
    }
    if (
      !policy ||
      typeof policy.evaluate !== "function" ||
      typeof policy.mergeDeferred !== "function"
    ) {
      throw new TypeError("restrained notification policy is required");
    }
    for (const [name, value] of Object.entries({
      notify,
      contextProvider,
      now,
      setTimeoutImpl,
      clearTimeoutImpl,
      log,
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
    }
    this.repository = repository;
    this.policy = policy;
    this.notify = notify;
    this.contextProvider = contextProvider;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.maxSleepMs = safeDelay(maxSleepMs, "maxSleepMs");
    this.deferredPollMs = safeDelay(deferredPollMs, "deferredPollMs");
    this.log = log;
    this.running = false;
    this.timer = null;
    this.timerDueAt = null;
    this.inFlight = null;
    this.rerunRequested = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.repository.reconcileTodoReminders(this.now());
    this.wake(1);
  }

  async stop() {
    this.running = false;
    this.rerunRequested = false;
    this._clearTimer();
    await this.inFlight;
  }

  wake(delayMs = 1) {
    if (!this.running) return;
    const delay = safeDelay(delayMs, "notification wake delay");
    if (this.inFlight) {
      this.rerunRequested = true;
      return;
    }
    this._schedule(delay);
  }

  _clearTimer() {
    if (this.timer !== null) this.clearTimeoutImpl(this.timer);
    this.timer = null;
    this.timerDueAt = null;
  }

  _schedule(delayMs) {
    if (!this.running) return;
    const dueAt = this.now() + delayMs;
    if (this.timer !== null && this.timerDueAt !== null && this.timerDueAt <= dueAt) return;
    this._clearTimer();
    this.timerDueAt = dueAt;
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      this.timerDueAt = null;
      void this._drain();
    }, delayMs);
    this.timer?.unref?.();
  }

  async _drain() {
    if (!this.running || this.inFlight) return;
    this.inFlight = this.runOnce();
    let result = null;
    try {
      result = await this.inFlight;
    } catch (error) {
      this.log({
        phase: "notification_scheduler_failed",
        code: error?.code ?? null,
        error: error?.message ?? String(error),
      });
    } finally {
      this.inFlight = null;
    }
    if (!this.running) return;
    if (this.rerunRequested) {
      this.rerunRequested = false;
      this._schedule(1);
      return;
    }
    this._schedule(result?.nextDelayMs ?? this.maxSleepMs);
  }

  async runOnce() {
    const evaluatedAt = this.now();
    this.repository.reconcileTodoReminders(evaluatedAt);
    const preferences = this.repository.getNotificationPreferences();
    let context;
    try {
      context = normalizeFocusContext(await this.contextProvider());
    } catch (error) {
      // Unknown focus state is handled conservatively: an unavailable context must not
      // interrupt a possible presentation or call.
      context = { presentationActive: true };
      this.log({
        phase: "notification_context_unavailable",
        code: error?.code ?? null,
      });
    }

    const due = this.repository.listDueTodoReminders(evaluatedAt, 200);
    const notify = [];
    const deferred = new Map();
    for (const reminder of due) {
      const decision = this.policy.evaluate({
        kind: "todo_reminder",
        todo: reminder,
        preferences,
        context,
        now: evaluatedAt,
      });
      if (decision.action === "notify") {
        notify.push(reminder);
      } else if (decision.action === "defer") {
        const group = deferred.get(decision.reason) ?? [];
        group.push(reminder);
        deferred.set(decision.reason, group);
      }
    }

    let deferredCount = 0;
    for (const [reason, items] of deferred) {
      deferredCount += this.repository.deferTodoReminders(
        items.map(reminderIdentity),
        reason,
        evaluatedAt
      );
    }

    let notifiedCount = 0;
    let deliveryFailed = false;
    if (notify.length > 0) {
      // Claim in SQLite before invoking Electron. Restart recovery therefore cannot replay
      // a notification that may already have reached Windows.
      const claimed = this.repository.claimTodoReminderDelivery(
        notify.map(reminderIdentity),
        evaluatedAt
      );
      if (claimed.length > 0) {
        const notification = this.policy.mergeDeferred(
          claimed.map((item) => ({
            kind: "todo_reminder",
            id: item.todoId,
            title: item.title,
          }))
        );
        if (notification) {
          try {
            await this.notify(notification);
            notifiedCount = claimed.length;
          } catch (error) {
            deliveryFailed = true;
            this.repository.releaseTodoReminderDelivery(claimed.map(reminderIdentity), {
              claimedAt: evaluatedAt,
              reason:
                error?.code === "JARVIS_OS_NOTIFICATIONS_UNAVAILABLE"
                  ? "os_notifications_unavailable"
                  : "delivery_failed",
              at: this.now(),
            });
            this.log({
              phase: "notification_delivery_failed",
              count: claimed.length,
              code: error?.code ?? null,
            });
          }
        }
      }
    }

    const nextDelayMs = this._nextDelay({
      evaluatedAt,
      preferences,
      context,
      deferredCount,
      deliveryFailed,
    });
    return {
      dueCount: due.length,
      deferredCount,
      notifiedCount,
      deliveryFailed,
      nextDelayMs,
    };
  }

  _nextDelay({ evaluatedAt, preferences, context, deferredCount, deliveryFailed }) {
    if (Number.isSafeInteger(preferences?.mutedUntil) && preferences.mutedUntil > evaluatedAt) {
      return Math.max(1, Math.min(this.maxSleepMs, preferences.mutedUntil - evaluatedAt));
    }
    if (deliveryFailed || (deferredCount > 0 && activeFocusContext(context))) {
      return Math.min(this.maxSleepMs, this.deferredPollMs);
    }
    if (preferences?.focusMode === true) return this.maxSleepMs;
    const nextAt = this.repository.getNextTodoReminderAt(evaluatedAt);
    if (!Number.isSafeInteger(nextAt)) return this.maxSleepMs;
    return Math.max(1, Math.min(this.maxSleepMs, nextAt - evaluatedAt));
  }
}

module.exports = JarvisNotificationScheduler;
module.exports.DEFAULT_MAX_SLEEP_MS = DEFAULT_MAX_SLEEP_MS;
module.exports.DEFAULT_DEFERRED_POLL_MS = DEFAULT_DEFERRED_POLL_MS;
module.exports.DEFAULT_NOTIFICATION_CONFIRMATION_TIMEOUT_MS =
  DEFAULT_NOTIFICATION_CONFIRMATION_TIMEOUT_MS;
module.exports.createElectronNotificationDelivery = createElectronNotificationDelivery;
