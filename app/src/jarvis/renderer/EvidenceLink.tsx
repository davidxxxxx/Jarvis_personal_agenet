import type { JarvisEvidenceHandle } from "../types";
import { useJarvisStore } from "./jarvisStore";

interface EvidenceLinkProps {
  handle?: JarvisEvidenceHandle | null;
  quote: string | null;
  startedAt: number;
  audioState: "available" | "expired" | "missing";
  transcriptState?: "available" | "missing";
}

function availabilityLabel(
  audioState: EvidenceLinkProps["audioState"],
  transcriptState: NonNullable<EvidenceLinkProps["transcriptState"]>
): string {
  const audio =
    audioState === "available"
      ? "audio available"
      : audioState === "expired"
        ? "audio expired"
        : "audio missing";
  const transcript =
    transcriptState === "available" ? "transcript available" : "transcript missing";
  return `${audio}; ${transcript}`;
}

export default function EvidenceLink({
  handle = null,
  quote,
  startedAt,
  audioState,
  transcriptState = "available",
}: EvidenceLinkProps) {
  const openEvidence = useJarvisStore((state) => state.openEvidence);
  const time = new Date(startedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const availability = availabilityLabel(audioState, transcriptState);
  const content = (
    <>
      <span className="block text-xs leading-5">{quote ?? "Transcript evidence unavailable"}</span>
      <span className="mt-1 block text-[10px] text-muted-foreground">
        {time} · {availability}
      </span>
    </>
  );

  if (!handle) {
    return <blockquote className="border-l border-border pl-2">{content}</blockquote>;
  }

  return (
    <button
      type="button"
      aria-label={`Open evidence at ${time}; ${availability}`}
      onClick={() => void openEvidence(handle)}
      className="w-full rounded-md border-l-2 border-primary/60 bg-muted/20 px-2 py-1.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {content}
    </button>
  );
}
