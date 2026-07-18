interface InputLevelWaveProps {
  level: number;
  label: string;
  active: boolean;
  idleLabel: string;
  quietLabel: string;
  audibleLabel: string;
}

const AUDIBLE_THRESHOLD = 0.015;
const BAR_COUNT = 40;
const WAVE_SHAPE = Array.from({ length: BAR_COUNT }, (_, index) => {
  const variation = Math.abs(Math.sin(index * 0.73) * Math.cos(index * 0.21));
  return 0.32 + variation * 0.68;
});

export default function InputLevelWave({
  level,
  label,
  active,
  idleLabel,
  quietLabel,
  audibleLabel,
}: InputLevelWaveProps) {
  const normalized = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const percent = Math.round(normalized * 100);
  const isAudible = active && normalized >= AUDIBLE_THRESHOLD;
  const state = !active ? "idle" : isAudible ? "audible" : "quiet";
  const stateLabel = state === "idle" ? idleLabel : isAudible ? audibleLabel : quietLabel;
  // Speech RMS is commonly around 0.05–0.1. A square-root curve makes that
  // range visually useful without changing or reprocessing the audio itself.
  const visualLevel = isAudible ? Math.min(1, Math.sqrt(normalized) * 2.2) : 0;

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${stateLabel}, ${percent}%`}
      data-audio-state={state}
      className={`w-full rounded-xl border px-4 py-3 transition-[border-color,background-color,box-shadow] duration-150 ${
        isAudible
          ? "border-emerald-400/50 bg-gradient-to-r from-cyan-500/10 via-emerald-500/10 to-cyan-500/10 shadow-[0_0_24px_rgba(16,185,129,0.16)]"
          : "border-border/60 bg-muted/35"
      }`}
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-2 font-medium text-foreground">
          <span
            aria-hidden="true"
            className={`size-2 rounded-full ${
              isAudible
                ? "animate-pulse bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]"
                : active
                  ? "bg-muted-foreground/45"
                  : "bg-muted-foreground/25"
            }`}
          />
          {stateLabel}
        </span>
        <span className="font-mono tabular-nums text-muted-foreground">{percent}%</span>
      </div>

      <div className="relative mt-2 flex h-14 items-center gap-[3px] overflow-hidden">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/70"
        />
        {WAVE_SHAPE.map((shape, index) => (
          <span
            // This fixed shape is decorative; the single meter above owns the semantics.
            aria-hidden="true"
            data-wave-bar
            key={index}
            className={`relative min-w-px flex-1 rounded-full transition-[height,background-color,opacity,box-shadow] duration-100 ${
              isAudible
                ? "bg-gradient-to-t from-cyan-500 via-emerald-400 to-cyan-300 shadow-[0_0_7px_rgba(52,211,153,0.45)]"
                : "bg-muted-foreground/35"
            }`}
            style={{
              height: `${isAudible ? 6 + Math.round(visualLevel * shape * 44) : 2}px`,
              opacity: isAudible ? 0.72 + shape * 0.28 : active ? 0.5 : 0.28,
            }}
          />
        ))}
      </div>
    </div>
  );
}
