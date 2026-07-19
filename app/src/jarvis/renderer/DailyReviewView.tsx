import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  JarvisDailyDigestFactualItem,
  JarvisDailyDigestReadResult,
  JarvisDailyDigestStatus,
} from "../types";
import EvidenceLink from "./EvidenceLink";

function currentLocalDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function Facts({ items }: { items: JarvisDailyDigestFactualItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground">
      {items.map((item, index) => (
        <li key={`${index}:${item.text}`}>
          <span aria-hidden="true">• </span>
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

interface DailyReviewViewProps {
  localDate?: string;
}

const DIGEST_POLL_INTERVAL_MS = 2_000;
const MAX_VISIBLE_POLL_ATTEMPTS = 120;
const POLLABLE_DIGEST_STATES = new Set<JarvisDailyDigestStatus["state"]>([
  "queued",
  "running",
  "retry_needed",
]);

export default function DailyReviewView({ localDate = currentLocalDate() }: DailyReviewViewProps) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<JarvisDailyDigestReadResult["digest"]>(null);
  const [status, setStatus] = useState<JarvisDailyDigestStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [confirmingPaidRetry, setConfirmingPaidRetry] = useState(false);
  const [regenerationUncertain, setRegenerationUncertain] = useState(false);
  const generation = useRef(0);
  const pollState = status?.state ?? null;

  const refresh = useCallback(
    async (showLoading = true) => {
      const request = ++generation.current;
      if (showLoading) setLoading(true);
      try {
        const result = await window.electronAPI.jarvis.getDailyDigest(localDate);
        if (generation.current !== request) return;
        setSaved(result.digest);
        setStatus(result.status);
        setFailed(false);
        return true;
      } catch {
        if (generation.current === request) setFailed(true);
        return false;
      } finally {
        if (showLoading && generation.current === request) setLoading(false);
      }
    },
    [localDate]
  );

  useEffect(() => {
    void refresh(true);
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (!pollState || !POLLABLE_DIGEST_STATES.has(pollState)) return;
    let active = true;
    let visibleAttempts = 0;
    let timer: number | null = null;

    const schedule = () => {
      if (!active || visibleAttempts >= MAX_VISIBLE_POLL_ATTEMPTS) return;
      timer = window.setTimeout(async () => {
        timer = null;
        if (!active) return;
        const visible =
          document.visibilityState !== "hidden" &&
          (typeof document.hasFocus !== "function" || document.hasFocus());
        if (visible) {
          visibleAttempts += 1;
          await refresh(false);
        }
        schedule();
      }, DIGEST_POLL_INTERVAL_MS);
    };

    schedule();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pollState, refresh]);

  const regenerate = async (allowUsageUnknown = false) => {
    if (regenerating) return;
    setRegenerating(true);
    setRegenerationUncertain(false);
    try {
      setStatus(
        allowUsageUnknown
          ? await window.electronAPI.jarvis.regenerateDailyDigest(localDate, true)
          : await window.electronAPI.jarvis.regenerateDailyDigest(localDate)
      );
      setConfirmingPaidRetry(false);
      setFailed(false);
    } catch {
      setRegenerationUncertain(true);
      const reconciled = await refresh(false);
      if (reconciled) {
        setConfirmingPaidRetry(false);
        setRegenerationUncertain(false);
      }
    } finally {
      setRegenerating(false);
    }
  };

  const reconcileUncertainRegeneration = async () => {
    if (regenerating) return;
    setRegenerating(true);
    try {
      if (await refresh(false)) {
        setConfirmingPaidRetry(false);
        setRegenerationUncertain(false);
      }
    } finally {
      setRegenerating(false);
    }
  };

  const statusLabel = status
    ? {
        not_generated: t("jarvis.dailyReview.status.notGenerated", {
          defaultValue: "Not generated / 尚未生成",
        }),
        empty: t("jarvis.dailyReview.status.empty", { defaultValue: "No activity / 暂无内容" }),
        queued: t("jarvis.dailyReview.status.queued", { defaultValue: "Queued / 已排队" }),
        running: t("jarvis.dailyReview.status.running", { defaultValue: "Generating / 生成中" }),
        retry_needed: t("jarvis.dailyReview.status.retry", {
          defaultValue: "Retry needed / 等待重试",
        }),
        ready: t("jarvis.dailyReview.status.ready", { defaultValue: "Saved / 已保存" }),
        blocked: t("jarvis.dailyReview.status.blocked", { defaultValue: "Blocked / 暂时受阻" }),
      }[status.state]
    : null;
  const usageUnknownBlocked =
    status?.state === "blocked" && status.errorCode === "usage_unknown";
  const regularRegenerateAvailable =
    status?.retryable ||
    status?.state === "not_generated" ||
    (status?.state === "blocked" && !usageUnknownBlocked);

  return (
    <section className="rounded-xl border border-border/50 bg-card/70 p-4" aria-busy={loading}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {t("jarvis.dailyReview.title", { defaultValue: "Daily review / 每日回顾" })}
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{localDate}</p>
        </div>
        {saved && (
          <span className="rounded-full bg-muted px-2 py-1 text-[10px] font-medium text-foreground">
            {saved.completeness === "final"
              ? t("jarvis.dailyReview.final", { defaultValue: "Final / 完整" })
              : t("jarvis.dailyReview.partial", { defaultValue: "Partial / 部分" })}
            {` · v${saved.revision}`}
          </span>
        )}
      </div>

      {status && status.state !== "ready" && (
        <div role="status" className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs">
          {statusLabel}
          {status.attemptCount > 0 ? ` · ${status.attemptCount}` : ""}
        </div>
      )}
      {failed && (
        <div role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs">
          {t("jarvis.dailyReview.loadFailed", {
            defaultValue: "Daily review is temporarily unavailable / 每日回顾暂时不可用",
          })}
        </div>
      )}

      {saved ? (
        <div className="mt-4 space-y-4">
          <div>
            <h3 className="text-xs font-semibold text-foreground">
              {t("jarvis.dailyReview.today", { defaultValue: "Today / 今天" })}
            </h3>
            <Facts items={saved.content.sections.today} />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-foreground">
              {t("jarvis.dailyReview.decisions", {
                defaultValue: "Topics and decisions / 主题与决定",
              })}
            </h3>
            <Facts items={saved.content.sections.topicsAndDecisions} />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-foreground">
              {t("jarvis.dailyReview.todos", { defaultValue: "Commitments / 承诺与待办" })}
            </h3>
            <Facts items={saved.content.sections.commitmentsAndTodos} />
          </div>
          {saved.content.sections.tomorrowSuggestions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-foreground">
                {t("jarvis.dailyReview.suggestions", { defaultValue: "Suggestions / 建议" })}
              </h3>
              <ul className="mt-2 space-y-2">
                {saved.content.sections.tomorrowSuggestions.map((suggestion) => (
                  <li key={suggestion.text} className="rounded-lg bg-muted/30 p-2 text-xs">
                    <p className="text-foreground">{suggestion.text}</p>
                    <p className="mt-1 text-muted-foreground">{suggestion.rationale}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {saved.evidence.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              <EvidenceLink
                handle={saved.evidence[0].handle}
                quote={saved.evidence[0].quote}
                startedAt={saved.evidence[0].startedAt}
                audioState={saved.evidence[0].audioState}
              />
            </div>
          )}
        </div>
      ) : (
        !loading &&
        !failed && (
          <p className="mt-4 text-xs text-muted-foreground">
            {t("jarvis.dailyReview.noDigest", {
              defaultValue: "No saved review for this day / 这一天还没有已保存的回顾",
            })}
          </p>
        )
      )}

      {regularRegenerateAvailable && !regenerationUncertain && (
        <button
          type="button"
          disabled={regenerating}
          onClick={() => void regenerate()}
          className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
        >
          {regenerating
            ? t("jarvis.dailyReview.regenerating", { defaultValue: "Queuing… / 正在排队…" })
            : t("jarvis.dailyReview.regenerate", { defaultValue: "Regenerate / 重新生成" })}
        </button>
      )}
      {usageUnknownBlocked && !confirmingPaidRetry && !regenerationUncertain && (
        <button
          type="button"
          disabled={regenerating}
          onClick={() => setConfirmingPaidRetry(true)}
          className="mt-4 rounded-lg border border-amber-500/50 px-3 py-1.5 text-xs text-amber-700 disabled:opacity-50 dark:text-amber-300"
        >
          {t("jarvis.dailyReview.retryAnyway", {
            defaultValue: "Retry anyway / 仍然重试",
          })}
        </button>
      )}
      {usageUnknownBlocked && confirmingPaidRetry && (
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
          <p className="text-xs leading-5 text-foreground">
            {regenerationUncertain
              ? t("jarvis.dailyReview.submissionUncertain", {
                  defaultValue:
                    "The request may already have been accepted. Check its status before any retry. / 请求可能已经被接受，请先查询状态，不能再次付费重试。",
                })
              : t("jarvis.dailyReview.usageUnknownWarning", {
                  defaultValue:
                    "The previous request may already have been charged. Retrying sends one new paid request. / 上一次请求可能已经计费，再次重试会发送一个新的付费请求。",
                })}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {regenerationUncertain ? (
              <button
                type="button"
                disabled={regenerating}
                onClick={() => void reconcileUncertainRegeneration()}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {regenerating
                  ? t("jarvis.dailyReview.checkingStatus", {
                      defaultValue: "Checking… / 正在查询…",
                    })
                  : t("jarvis.dailyReview.checkStatus", {
                      defaultValue: "Check status / 查询状态",
                    })}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={regenerating}
                  onClick={() => void regenerate(true)}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {regenerating
                    ? t("jarvis.dailyReview.regenerating", {
                        defaultValue: "Queuing… / 正在排队…",
                      })
                    : t("jarvis.dailyReview.confirmPaidRetry", {
                        defaultValue: "Confirm paid retry / 确认再次付费重试",
                      })}
                </button>
                <button
                  type="button"
                  disabled={regenerating}
                  onClick={() => setConfirmingPaidRetry(false)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  {t("common.cancel", { defaultValue: "Cancel / 取消" })}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
