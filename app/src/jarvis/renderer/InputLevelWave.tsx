interface InputLevelWaveProps {
  level: number;
  label: string;
  active: boolean;
}

const WAVE_SHAPE = [
  0.24, 0.34, 0.46, 0.58, 0.72, 0.84, 0.96, 0.78, 0.62, 0.48, 0.68, 0.9, 0.9, 0.68,
  0.48, 0.62, 0.78, 0.96, 0.84, 0.72, 0.58, 0.46, 0.34, 0.24,
];

export default function InputLevelWave({ level, label, active }: InputLevelWaveProps) {
  const normalized = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const percent = Math.round(normalized * 100);

  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="flex h-8 w-28 items-center justify-center gap-px overflow-hidden rounded-lg bg-muted/60 px-2"
    >
      {WAVE_SHAPE.map((shape, index) => (
        <span
          // This fixed shape is decorative; the single meter above owns the semantics.
          aria-hidden="true"
          data-wave-bar
          key={index}
          className={`w-0.5 rounded-full transition-[height,background-color,opacity] duration-100 ${
            active ? "bg-red-500" : "bg-primary/70"
          }`}
          style={{
            height: `${3 + Math.round(normalized * shape * 25)}px`,
            opacity: 0.38 + normalized * 0.62,
          }}
        />
      ))}
    </div>
  );
}
