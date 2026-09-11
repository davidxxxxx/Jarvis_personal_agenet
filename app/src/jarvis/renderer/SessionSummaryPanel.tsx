import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { JarvisAnalysisStatus, JarvisSessionDetail, JarvisSessionSummary } from "../types";
import type { SessionStatus } from "./sessionMachine";

interface SessionSummaryPanelProps {
  sessionId: string | null;
  sessionStatus: SessionStatus;
}

interface SummaryView {
  summary: JarvisSessionSummary;
  decisions: string[];
  suggestions: string[];
  detail: JarvisSessionDetail;
}

type PanelState =
  | { kind: "hidden" }
  | { kind: "loading"; outcome: AnalysisOutcome }
  | { kind: "ready"; view: SummaryView }
  | {
      kind: "unavailable";
      outcome: Extract<AnalysisOutcome, "offline" | "quota_limited" | "retry_needed">;
      errorCode: string | null;
    };

type AnalysisOutcome =
  "waiting" | "analyzing" | "ready" | "offline" | "quota_limited" | "retry_needed";

const TERMINAL_ANALYSIS_STATES = new Set<JarvisAnalysisStatus["state"]>([
  "quota_limited",
  "retry_needed",
  "blocked",
]);
const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 1_000;

function analysisOutcome(status: JarvisAnalysisStatus): AnalysisOutcome {
  if (status.state === "waiting" || status.state === "preparing") return "waiting";
  if (status.state === "queued" || status.state === "analyzing") return "analyzing";
  if (status.state === "ready") return "ready";
  if (status.state === "quota_limited") return "quota_limited";
  if (
    status.state === "blocked" &&
    (status.errorCode === "offline" || status.errorCode === "analysis_runtime_not_ready")
  ) {
    return "offline";
  }
  return "retry_needed";
}

function stringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string").slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

function suggestionArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          item &&
          typeof item === "object" &&
          "content" in item &&
          typeof item.content === "string"
        ) {
          return item.content;
        }
        return null;
      })
      .filter((item): item is string => item !== null)
      .slice(0, 100);
  } catch {
    return [];
  }
}

function toSummaryView(detail: JarvisSessionDetail): SummaryView | null {
  if (!detail.summary) return null;
  return {
    summary: detail.summary,
    decisions: stringArray(detail.summary.decisions_json),
    suggestions: suggestionArray(detail.summary.suggestions_json),
    detail,
  };
}

export default function SessionSummaryPanel({
  sessionId,
  sessionStatus,
}: SessionSummaryPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<PanelState>({ kind: "hidden" });
  const [refreshGeneration, setRefreshGeneration] = useState(0);

  useEffect(() => {
    if (!sessionId || sessionStatus !== "completed") {
      setState({ kind: "hidden" });
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    let attempt = 0;
    setState({ kind: "loading", outcome: "waiting" });

    const refresh = async () => {
      attempt += 1;
      try {
        const detail = await window.electronAPI.jarvis.getSessionDetail(sessionId);
        if (cancelled) return;
        const view = detail ? toSummaryView(detail) : null;
        if (view) {
          setState({ kind: "ready", view });
          return;
        }

        const status = await window.electronAPI.jarvis.getAnalysisStatus(sessionId);
        if (cancelled) return;
        if (TERMINAL_ANALYSIS_STATES.has(status.state)) {
          const outcome = analysisOutcome(status);
          setState({
            kind: "unavailable",
            outcome:
              outcome === "offline" || outcome === "quota_limited" ? outcome : "retry_needed",
            errorCode: status.errorCode,
          });
          return;
        }
        setState({ kind: "loading", outcome: analysisOutcome(status) });
        if (attempt >= MAX_POLL_ATTEMPTS) {
          setState({
            kind: "unavailable",
            outcome: "retry_needed",
            errorCode: "analysis_timeout",
          });
          return;
        }
        timer = window.setTimeout(() => void refresh(), POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) {
          setState({
            kind: "unavailable",
            outcome: "retry_needed",
            errorCode: "analysis_failed",
          });
        }
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [refreshGeneration, sessionId, sessionStatus]);

  const retry = useCallback(async () => {
    if (!sessionId) return;
    setState({ kind: "loading", outcome: "waiting" });
    try {
      await window.electronAPI.jarvis.analyzeSession(sessionId, "final");
      setRefreshGeneration((generation) => generation + 1);
    } catch {
      setState({
        kind: "unavailable",
        outcome: "retry_needed",
        errorCode: "analysis_failed",
      });
    }
  }, [sessionId]);

  if (state.kind === "hidden") return null;

  const outcome = state.kind === "ready" ? "ready" : state.outcome;
  const outcomeLabel =
    outcome === "waiting"
      ? t("jarvis.currentSummary.status.waiting", { defaultValue: "Waiting for analysis" })
      : outcome === "analyzing"
        ? t("jarvis.currentSummary.status.analyzing", { defaultValue: "Analyzing" })
        : outcome === "ready"
          ? t("jarvis.currentSummary.status.ready", { defaultValue: "Ready" })
          : outcome === "offline"
            ? t("jarvis.currentSummary.status.offline", { defaultValue: "Offline" })
            : outcome === "quota_limited"
              ? t("jarvis.currentSummary.status.quotaLimited", {
                  defaultValue: "Quota limited",
                })
              : t("jarvis.currentSummary.status.retryNeeded", {
                  defaultValue: "Retry needed",
                });

  return (
    <section
      className="rounded-xl border border-border/50 bg-card/80 p-4 shadow-sm"
      aria-labelledby="current-session-summary-title"
    >
      <div className="flex items-center gap-2">
        {state.kind === "ready" ? (
          <CheckCircle2 className="size-4 text-emerald-500" aria-hidden="true" />
        ) : (
          <LoaderCircle
            className={`size-4 text-primary ${state.kind === "loading" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
        )}
        <h2 id="current-session-summary-title" className="text-sm font-semibold text-foreground">
          {t("jarvis.currentSummary.title")}
        </h2>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {outcomeLabel}
        </span>
      </div>

      {state.kind === "loading" && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {t("jarvis.currentSummary.loading")}
        </p>
      )}

      {state.kind === "unavailable" && (
        <div className="mt-3">
          <p role="status" className="text-sm leading-5 text-muted-foreground">
            {t("jarvis.currentSummary.unavailable")}
          </p>
          <Button type="button" variant="outline" className="mt-3 w-full" onClick={retry}>
            <RotateCcw aria-hidden="true" />
            {t("jarvis.currentSummary.retry")}
          </Button>
        </div>
      )}

      {state.kind === "ready" && (
        <div className="mt-3 space-y-4">
          <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/85">
            {state.view.summary.summary}
          </p>
          {state.view.detail.topics.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-foreground">
                {t("jarvis.currentSummary.topics", { defaultValue: "Topics" })}
              </h3>
              <ul className="mt-2 space-y-2">
                {state.view.detail.topics.slice(0, 8).map((topic) => (
                  <li key={topic.id} className="rounded-lg bg-muted/35 px-3 py-2">
                    <p className="text-xs font-medium text-foreground">{topic.canonical_title}</p>
                    {topic.description && (
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                        {topic.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.view.decisions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-foreground">
                {t("jarvis.currentSummary.decisions")}
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {state.view.decisions.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </div>
          )}
          {state.view.detail.todos.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-foreground">
                {t("jarvis.currentSummary.todos")}
              </h3>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {state.view.detail.todos.slice(0, 8).map((todo) => (
                  <li key={todo.id}>○ {todo.content}</li>
                ))}
              </ul>
            </div>
          )}
          {state.view.suggestions.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-foreground">
                {t("jarvis.currentSummary.suggestions")}
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {state.view.suggestions.map((suggestion) => (
                  <li key={suggestion}>{suggestion}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
