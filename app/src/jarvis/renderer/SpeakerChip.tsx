import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, UserRound, UserRoundCheck } from "lucide-react";
import { lockSpeaker } from "../../stores/meetingRecordingStore";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";

interface SpeakerChipProps {
  personId: string;
  displayName: string;
  confidence?: number;
  confirmed?: boolean;
}

const MAX_SPEAKER_NAME_CODE_POINTS = 80;
const MAX_SPEAKER_INPUT_CODE_POINTS = 160;

function boundSpeakerInput(value: string): string {
  return Array.from(value).slice(0, MAX_SPEAKER_INPUT_CODE_POINTS).join("");
}

function normalizeSpeakerName(value: string): string {
  return Array.from(value.trim()).slice(0, MAX_SPEAKER_NAME_CODE_POINTS).join("");
}

export default function SpeakerChip({
  personId,
  displayName,
  confidence,
  confirmed = false,
}: SpeakerChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const needsConfirmation = !confirmed && typeof confidence === "number" && confidence < 0.65;
  const chipLabel = needsConfirmation ? t("jarvis.needsConfirmation") : displayName;

  useEffect(() => setName(displayName), [displayName]);

  const persist = async (input: { displayName?: string; isSelf?: boolean }) => {
    const trimmed =
      input.displayName === undefined ? undefined : normalizeSpeakerName(input.displayName);
    if ((input.displayName !== undefined && !trimmed) || saving) return;
    setSaving(true);
    setError(false);
    try {
      const person = await window.electronAPI.jarvis.renamePerson({
        personId,
        ...(trimmed ? { displayName: trimmed } : {}),
        ...(input.isSelf === undefined ? {} : { isSelf: input.isSelf }),
      });
      const resolvedName = person.display_name || trimmed || displayName;
      lockSpeaker(personId, resolvedName);
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
            void persist({ displayName: name });
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
            onChange={(event) => setName(boundSpeakerInput(event.target.value))}
            maxLength={MAX_SPEAKER_INPUT_CODE_POINTS * 2}
            autoComplete="off"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t("jarvis.renameFailed")}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!normalizeSpeakerName(name) || saving}>
              <Check aria-hidden="true" />
              {t("jarvis.saveSpeakerName")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => void persist({ isSelf: true })}
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
