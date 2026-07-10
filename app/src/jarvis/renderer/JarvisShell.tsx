import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  BrainCircuit,
  CalendarDays,
  CheckSquare2,
  LockKeyhole,
  MessageSquareText,
  UsersRound,
} from "lucide-react";
import { useJarvisStore, type JarvisView } from "./jarvisStore";
import { useJarvisRecording } from "./useJarvisRecording";
import TodayView from "./TodayView";

const NAV_ITEMS: Array<{
  id: JarvisView;
  icon: typeof CalendarDays;
}> = [
  { id: "today", icon: CalendarDays },
  { id: "people", icon: UsersRound },
  { id: "topics", icon: MessageSquareText },
  { id: "todos", icon: CheckSquare2 },
  { id: "memory", icon: BrainCircuit },
];

export default function JarvisShell() {
  const { t } = useTranslation();
  const recording = useJarvisRecording();
  const selectedView = useJarvisStore((state) => state.selectedView);
  const setSelectedView = useJarvisStore((state) => state.setSelectedView);

  useEffect(() => {
    if (selectedView !== "today") setSelectedView("today");
  }, [selectedView, setSelectedView]);

  return (
    <div className="grid h-screen grid-cols-[176px_minmax(420px,1fr)_320px] overflow-hidden bg-background text-foreground">
      <nav
        className="flex min-h-0 flex-col border-r border-border/40 bg-card/40 px-3 py-4"
        aria-label={t("jarvis.navigation")}
      >
        <div className="mb-6 flex items-center gap-2 px-2">
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
        <ul className="space-y-1">
          {NAV_ITEMS.map(({ id, icon: Icon }) => {
            const disabled = id !== "today";
            return (
              <li key={id}>
                <button
                  type="button"
                  disabled={disabled}
                  aria-current={id === "today" ? "page" : undefined}
                  onClick={() => setSelectedView(id)}
                  className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${
                    id === "today"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                  }`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="size-4" aria-hidden="true" />
                    {t(`jarvis.${id}`)}
                  </span>
                  {disabled && (
                    <span className="mt-1 block pl-6 text-[10px] leading-3 text-muted-foreground">
                      {t("jarvis.enableAfterAnalysis")}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <TodayView recording={recording} />
    </div>
  );
}
