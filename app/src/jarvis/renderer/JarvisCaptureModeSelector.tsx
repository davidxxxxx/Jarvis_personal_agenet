import { useTranslation } from "react-i18next";
import type { JarvisCaptureMode } from "../types";

interface JarvisCaptureModeSelectorProps {
  value: JarvisCaptureMode;
  onChange: (mode: JarvisCaptureMode) => void;
  disabled: boolean;
}

const MODES: ReadonlyArray<readonly [JarvisCaptureMode, string]> = [
  ["mic", "jarvis.capture.modes.mic"],
  ["system", "jarvis.capture.modes.system"],
  ["dual", "jarvis.capture.modes.dual"],
];

export default function JarvisCaptureModeSelector({
  value,
  onChange,
  disabled,
}: JarvisCaptureModeSelectorProps) {
  const { t } = useTranslation();

  return (
    <fieldset
      disabled={disabled}
      className="mt-3 flex flex-wrap gap-x-4 gap-y-2 border-t border-border/40 pt-3"
    >
      <legend className="mb-2 text-xs font-medium text-muted-foreground">
        {t("jarvis.capture.groupLabel")}
      </legend>
      {MODES.map(([mode, labelKey]) => (
        <label key={mode} className="flex items-center gap-1.5 text-xs text-foreground">
          <input
            type="radio"
            name="jarvis-capture-mode"
            value={mode}
            checked={value === mode}
            onChange={() => onChange(mode)}
          />
          {t(labelKey)}
        </label>
      ))}
    </fieldset>
  );
}
