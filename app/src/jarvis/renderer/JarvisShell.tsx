import { useTranslation } from "react-i18next";
import {
  BrainCircuit,
  CalendarDays,
  CheckSquare2,
  AlertTriangle,
  LockKeyhole,
  MessageSquareText,
  HardDrive,
  UsersRound,
  X,
} from "lucide-react";
import MeetingRecordingMount from "../../components/MeetingRecordingMount";
import { useJarvisStore, type JarvisView } from "./jarvisStore";
import { useJarvisRecording } from "./useJarvisRecording";
import JarvisTitleBar from "./JarvisTitleBar";
import TodayView from "./TodayView";
import MemoryView from "./MemoryView";
import PeopleView from "./PeopleView";
import TopicsView from "./TopicsView";
import TodosView from "./TodosView";
import JarvisStorageSettings from "./JarvisStorageSettings";

const NAV_ITEMS: Array<{
  id: JarvisView;
  icon: typeof CalendarDays;
}> = [
  { id: "today", icon: CalendarDays },
  { id: "people", icon: UsersRound },
  { id: "topics", icon: MessageSquareText },
  { id: "todos", icon: CheckSquare2 },
  { id: "memory", icon: BrainCircuit },
  { id: "storage", icon: HardDrive },
];

export default function JarvisShell() {
  const { t } = useTranslation();
  const recording = useJarvisRecording();
  const selectedView = useJarvisStore((state) => state.selectedView);
  const setSelectedView = useJarvisStore((state) => state.setSelectedView);
  const openSession = useJarvisStore((state) => state.openSession);
  const evidenceNavigation = useJarvisStore((state) => state.evidenceNavigation);
  const clearEvidenceNavigation = useJarvisStore((state) => state.clearEvidenceNavigation);

  const captureActive = ["recording", "degraded", "paused", "finalizing"].includes(
    recording.session.status
  );
  const content =
    selectedView === "people" ? (
      <PeopleView />
    ) : selectedView === "topics" ? (
      <TopicsView onOpenSession={openSession} />
    ) : selectedView === "todos" ? (
      <TodosView />
    ) : selectedView === "memory" ? (
      <MemoryView />
    ) : selectedView === "storage" ? (
      <JarvisStorageSettings captureActive={captureActive} />
    ) : (
      <TodayView
        recording={recording}
        onOpenSession={openSession}
        onViewAllTodos={() => setSelectedView("todos")}
      />
    );

  return (
    <div className="grid h-screen grid-rows-[40px_minmax(0,1fr)] overflow-hidden bg-background text-foreground">
      <MeetingRecordingMount />
      <JarvisTitleBar />
      {evidenceNavigation.phase === "failed" && (
        <div
          role="alert"
          className="fixed right-4 top-12 z-[70] flex max-w-sm items-start gap-2 rounded-xl border border-amber-300 bg-background p-3 shadow-lg"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">无法打开这条来源</p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {evidenceNavigation.code === "evidence_not_found"
                ? "这条来源已不存在或已被安全清理，其他录音和文字不受影响。"
                : evidenceNavigation.code === "session_unavailable"
                  ? "对应会话暂时无法读取，请稍后从记忆库重试。"
                  : "来源导航暂时失败，请稍后重试；已保存的数据不会丢失。"}
            </p>
          </div>
          <button
            type="button"
            onClick={clearEvidenceNavigation}
            aria-label="关闭来源导航错误"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
      <div
        data-testid="jarvis-shell"
        className="grid min-h-0 grid-cols-1 auto-rows-max overflow-y-auto bg-background text-foreground lg:grid-cols-[176px_minmax(420px,1fr)_380px] lg:grid-rows-1 lg:overflow-hidden"
      >
        <nav
          className="flex min-h-0 flex-row border-b border-border/40 bg-card/40 px-3 py-3 lg:flex-col lg:border-b-0 lg:border-r lg:py-4"
          aria-label={t("jarvis.navigation")}
        >
          <div className="mr-4 flex shrink-0 items-center gap-2 px-2 lg:mb-6 lg:mr-0">
            <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <BrainCircuit className="size-4" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold leading-4">Jarvis</p>
              <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <LockKeyhole className="size-2.5" aria-hidden="true" />
                {t("jarvis.localOnly")}
              </p>
            </div>
          </div>
          <ul className="flex min-w-0 gap-1 overflow-x-auto lg:block lg:space-y-1">
            {NAV_ITEMS.map(({ id, icon: Icon }) => {
              return (
                <li key={id}>
                  <button
                    type="button"
                    aria-current={id === selectedView ? "page" : undefined}
                    onClick={() => setSelectedView(id)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${
                      id === selectedView
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="size-4" aria-hidden="true" />
                      {id === "storage" ? t("jarvis.storage.title") : t(`jarvis.${id}`)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {content}
      </div>
    </div>
  );
}
