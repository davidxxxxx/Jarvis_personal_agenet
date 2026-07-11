import { useEffect, useMemo, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

interface JarvisMicrophoneSelectorProps {
  disabled: boolean;
}

export default function JarvisMicrophoneSelector({ disabled }: JarvisMicrophoneSelectorProps) {
  const selected = useSettingsStore((state) => state.selectedMicDeviceId);
  const setSelected = useSettingsStore((state) => state.setSelectedMicDeviceId);
  const setPreferBuiltIn = useSettingsStore((state) => state.setPreferBuiltInMic);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        let next = (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === "audioinput"
        );
        if (next.length > 0 && next.every((device) => !device.label)) {
          const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          permissionStream.getTracks().forEach((track) => track.stop());
          next = (await navigator.mediaDevices.enumerateDevices()).filter(
            (device) => device.kind === "audioinput"
          );
        }
        if (active) {
          setDevices(next.filter((device) => device.deviceId !== "default"));
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    };
    void load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", load);
    };
  }, []);

  const selectedAvailable = useMemo(
    () =>
      !selected || selected === "default" || devices.some((device) => device.deviceId === selected),
    [devices, selected]
  );

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
      <label htmlFor="jarvis-microphone" className="text-xs font-medium text-muted-foreground">
        麦克风
      </label>
      <select
        id="jarvis-microphone"
        value={selected && selected !== "default" ? selected : ""}
        disabled={disabled}
        onChange={(event) => {
          setPreferBuiltIn(false);
          setSelected(event.target.value);
        }}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
      >
        <option value="">系统默认麦克风</option>
        {!selectedAvailable && <option value={selected}>之前选择的麦克风（当前不可用）</option>}
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `麦克风 ${index + 1}`}
          </option>
        ))}
      </select>
      {error && <span className="text-[11px] text-destructive">无法读取设备列表</span>}
    </div>
  );
}
