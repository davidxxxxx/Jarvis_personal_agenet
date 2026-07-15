import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, RotateCcw, UserRound, X } from "lucide-react";
import type {
  JarvisProfileSampleReason,
  JarvisSpeakerClusterView,
  JarvisSpeakerCorrectionScope,
} from "../types";
import { Button } from "../../components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { useJarvisStore } from "./jarvisStore";

interface SpeakerChipProps {
  cluster: JarvisSpeakerClusterView | null;
  localLabel: string;
}

const MAX_SPEAKER_INPUT_CODE_POINTS = 80;

const PROFILE_REASON_KEYS: Record<JarvisProfileSampleReason, string> = {
  added: "jarvis.speakerProfileReasonAdded",
  session_scope: "jarvis.speakerProfileReasonSessionScope",
  insufficient_speech: "jarvis.speakerProfileReasonInsufficientSpeech",
  insufficient_windows: "jarvis.speakerProfileReasonInsufficientWindows",
  insufficient_quality: "jarvis.speakerProfileReasonInsufficientQuality",
  missing_embedding: "jarvis.speakerProfileReasonMissingEmbedding",
  already_present: "jarvis.speakerProfileReasonAlreadyPresent",
};

function boundSpeakerInput(value: string): string {
  return Array.from(value).slice(0, MAX_SPEAKER_INPUT_CODE_POINTS).join("");
}

export default function SpeakerChip({ cluster, localLabel }: SpeakerChipProps) {
  const { t } = useTranslation();
  const people = useJarvisStore((state) => state.people);
  const busyClusterId = useJarvisStore((state) => state.speakerCorrectionBusyClusterId);
  const storeError = useJarvisStore((state) => state.speakerCorrectionError);
  const ambiguousCandidates = useJarvisStore((state) => state.speakerCorrectionCandidates);
  const ambiguousCandidateClusterId = useJarvisStore(
    (state) => state.speakerCorrectionCandidateClusterId
  );
  const confirmSpeaker = useJarvisStore((state) => state.confirmSpeaker);
  const rejectSpeaker = useJarvisStore((state) => state.rejectSpeaker);
  const undoSpeaker = useJarvisStore((state) => state.undoSpeaker);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState("");
  const [scope, setScope] = useState<JarvisSpeakerCorrectionScope>("session");
  const [outcome, setOutcome] = useState<string | null>(null);

  useEffect(() => {
    setOutcome(null);
  }, [cluster?.id, cluster?.updatedAt]);

  if (!cluster) {
    return (
      <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border/50 px-2.5 text-xs text-muted-foreground">
        <UserRound className="size-3.5" aria-hidden="true" />
        {localLabel}
      </span>
    );
  }

  const busy = busyClusterId === cluster.id;
  const visibleAmbiguousCandidates =
    ambiguousCandidateClusterId === cluster.id ? ambiguousCandidates : [];
  const suggestedPerson = cluster.suggestedPerson;
  const chipLabel =
    cluster.linkState === "confirmed"
      ? cluster.person?.isSelf
        ? t("jarvis.speakerSelf")
        : (cluster.person?.displayName ?? t("jarvis.speakerUnknown"))
      : cluster.linkState === "suggested" && suggestedPerson
        ? t("jarvis.speakerSuggested", { name: suggestedPerson.displayName })
        : t("jarvis.speakerUnknown");

  const applyConfirmation = async (
    target: { personId: string } | { newPersonName: string },
    selectedScope: JarvisSpeakerCorrectionScope,
    closeAfter = false
  ) => {
    const result = await confirmSpeaker({ clusterId: cluster.id, ...target, scope: selectedScope });
    setOutcome(
      result.profileSampleAdded
        ? t("jarvis.speakerLinkedAndLearned")
        : t("jarvis.speakerLinkedOnly", {
            reason: t(PROFILE_REASON_KEYS[result.profileSampleReason]),
          })
    );
    if (closeAfter) setOpen(false);
  };

  const contain = (operation: Promise<unknown>) => {
    void operation.catch(() => undefined);
  };

  const closeAfterSuccess = async (operation: Promise<unknown>) => {
    await operation;
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
            cluster.linkState === "suggested"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              : "border-border/70 bg-muted/70 text-foreground hover:bg-muted"
          }`}
        >
          <UserRound className="size-3.5" aria-hidden="true" />
          {chipLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3 p-3" align="start">
        <p className="text-xs text-muted-foreground">
          {t("jarvis.speakerLocalLabel", { label: cluster.localLabel })}
        </p>
        {cluster.linkState === "rejected" && cluster.lastRejectedPerson && (
          <p className="text-xs text-muted-foreground">
            {t("jarvis.speakerExcludedCandidate", {
              name: cluster.lastRejectedPerson.displayName,
            })}
          </p>
        )}
        {cluster.linkState === "suggested" && suggestedPerson && (
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                contain(applyConfirmation({ personId: suggestedPerson.id }, "session", true))
              }
            >
              <Check aria-hidden="true" />
              {t("jarvis.speakerAcceptSession")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                contain(applyConfirmation({ personId: suggestedPerson.id }, "persistent"))
              }
            >
              <Check aria-hidden="true" />
              {t("jarvis.speakerAcceptPersistent")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                contain(closeAfterSuccess(rejectSpeaker(cluster.id, suggestedPerson.id)))
              }
            >
              <X aria-hidden="true" />
              {t("jarvis.speakerReject")}
            </Button>
          </div>
        )}
        {visibleAmbiguousCandidates.length > 0 && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-xs text-muted-foreground">
              {t("jarvis.speakerAmbiguousCandidates")}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {visibleAmbiguousCandidates.map((candidate) => (
                <Button
                  key={candidate.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => contain(applyConfirmation({ personId: candidate.id }, scope))}
                >
                  {candidate.isSelf ? t("jarvis.speakerSelf") : candidate.displayName}
                </Button>
              ))}
            </div>
          </div>
        )}
        <form
          className="space-y-2 border-t border-border/50 pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            const normalizedName = name.trim().replace(/\s+/gu, " ");
            if (normalizedName) {
              contain(applyConfirmation({ newPersonName: normalizedName }, scope));
            } else if (selectedPersonId) {
              contain(applyConfirmation({ personId: selectedPersonId }, scope));
            }
          }}
        >
          <label className="block text-xs font-medium" htmlFor={`speaker-person-${cluster.id}`}>
            {t("jarvis.speakerExistingPerson")}
          </label>
          <select
            id={`speaker-person-${cluster.id}`}
            value={selectedPersonId}
            onChange={(event) => setSelectedPersonId(event.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">{t("jarvis.speakerChoosePerson")}</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.is_self ? t("jarvis.speakerSelf") : person.display_name}
              </option>
            ))}
          </select>
          <label className="block text-xs font-medium" htmlFor={`speaker-name-${cluster.id}`}>
            {t("jarvis.speakerNewPersonName")}
          </label>
          <input
            id={`speaker-name-${cluster.id}`}
            value={name}
            onChange={(event) => setName(boundSpeakerInput(event.target.value))}
            autoComplete="off"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={scope === "persistent"}
              onChange={(event) => setScope(event.target.checked ? "persistent" : "session")}
            />
            <span>{t("jarvis.speakerPersistentScope")}</span>
          </label>
          <p className="text-xs text-muted-foreground">
            {scope === "persistent"
              ? t("jarvis.speakerPersistentExplanation")
              : t("jarvis.speakerSessionExplanation")}
          </p>
          <Button type="submit" size="sm" disabled={busy || (!name.trim() && !selectedPersonId)}>
            {t("jarvis.speakerConfirm")}
          </Button>
        </form>
        {cluster.canUndo && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => contain(closeAfterSuccess(undoSpeaker(cluster.id)))}
          >
            <RotateCcw aria-hidden="true" />
            {t("jarvis.speakerUndo")}
          </Button>
        )}
        {outcome && (
          <p role="status" className="text-xs text-emerald-700">
            {outcome}
          </p>
        )}
        {storeError && (
          <p role="alert" className="text-xs text-destructive">
            {storeError}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
