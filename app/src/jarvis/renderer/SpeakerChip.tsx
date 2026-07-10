import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, UserRound, UserRoundCheck } from "lucide-react";
import { lockSpeaker } from "../../stores/meetingRecordingStore";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";

interface SpeakerChipProps {
  personId: string;
  displayName: string;
  confidence?: number;
}

export default function SpeakerChip({ personId, displayName, confidence }: SpeakerChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(displayName);
  const [visibleName, setVisibleName] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const needsConfirmation = typeof confidence === "number" && confidence < 0.65;
  const chipLabel = needsConfirmation ? t("jarvis.needsConfirmation") : visibleName;

  const persist = async (nextName: string, isSelf: boolean) => {
    const trimmed = nextName.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(false);
    try {
      await window.electronAPI.jarvis.renamePerson({
        personId,
        displayName: trimmed,
        isSelf,
      });
      lockSpeaker(personId, trimmed);
      setVisibleName(trimmed);
      setName(trimmed);
      setOpen(false);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
            needsConfirmation
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-border/70 bg-muted/70 text-foreground hover:bg-muted"
          }`}
        >
          <UserRound className="size-3.5" aria-hidden="true" />
          {chipLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-3 p-3" align="start">
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void persist(name, false);
          }}
        >
          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor={`speaker-${personId}`}
          >
            {t("jarvis.speakerName")}
          </label>
          <input
            id={`speaker-${personId}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="off"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t("jarvis.renameFailed")}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!name.trim() || saving}>
              <Check aria-hidden="true" />
              {t("jarvis.saveSpeakerName")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void persist(t("jarvis.selfName"), true)}
            >
              <UserRoundCheck aria-hidden="true" />
              {t("jarvis.markAsSelf")}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
