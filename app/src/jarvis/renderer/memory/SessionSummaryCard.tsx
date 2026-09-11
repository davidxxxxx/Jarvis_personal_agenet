import type { JarvisSessionDetail } from "../../types";
import { summaryRefreshMessage, type LegacySuggestion } from "./presentation";

interface Props {
  summary: JarvisSessionDetail["summary"];
  refresh: { recommended: 0 | 1; reason: string | null } | null | undefined;
  loading: boolean;
  summaryInputReady: boolean;
  decisions: string[];
  suggestions: LegacySuggestion[];
  onAnalyze: () => void;
}

export default function SessionSummaryCard({
  summary,
  refresh,
  loading,
  summaryInputReady,
  decisions,
  suggestions,
  onAnalyze,
}: Props) {
  return (
    <section className="order-1 mt-6 rounded-xl border border-border/50 bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">完整总结</h2>
        {refresh?.recommended === 1 && (
          <button
            type="button"
            onClick={onAnalyze}
            disabled={loading}
            className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800 disabled:opacity-50 dark:text-amber-200"
          >
            {loading ? "正在刷新…" : "付费刷新总结"}
          </button>
        )}
      </div>
      {refresh?.recommended === 1 && (
        <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
          {summaryRefreshMessage(refresh.reason)}
        </p>
      )}
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground/80">
        {summary?.summary ??
          (summaryInputReady
            ? "尚未生成总结。录音和转写已安全保存。"
            : "正在完成最终转写和说话人识别，完成后会自动生成总结。")}
      </p>
      {decisions.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">关键决定</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {decisions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">AI 建议</h3>
          <ul className="mt-2 space-y-2 text-sm text-muted-foreground">
            {suggestions.map((item) => (
              <li key={item.content}>
                <span className="text-foreground">{item.content}</span> — {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
