import type { JarvisCaptureMode } from "../types";

interface JarvisCaptureModeSelectorProps {
  value: JarvisCaptureMode;
  onChange: (mode: JarvisCaptureMode) => void;
  disabled: boolean;
}

const MODES: ReadonlyArray<readonly [JarvisCaptureMode, string]> = [
  ["mic", "仅麦克风"],
  ["system", "仅电脑声音"],
  ["dual", "麦克风和电脑声音"],
];

export default function JarvisCaptureModeSelector({
  value,
  onChange,
  disabled,
}: JarvisCaptureModeSelectorProps) {
  return (
    <fieldset
      disabled={disabled}
      className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/40 pt-3"
    >
      <legend className="mb-2 text-xs font-medium text-muted-foreground">采集声音</legend>
      {MODES.map(([mode, label]) => (
        <label key={mode} className="flex items-center gap-1.5 text-xs text-foreground">
          <input
            type="radio"
            name="jarvis-capture-mode"
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
