import type { CSSProperties } from "react";
import WindowControls from "../../components/WindowControls";

export default function JarvisTitleBar() {
  return (
    <header
      data-testid="jarvis-drag-region"
      data-app-region="drag"
      className="jarvis-drag-region flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-background/95 pl-4"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <span className="text-xs font-medium text-muted-foreground">Jarvis Memory</span>
      <div
        data-testid="jarvis-window-controls-slot"
        data-app-region="no-drag"
        className="jarvis-no-drag-region pr-1"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        <WindowControls />
      </div>
    </header>
  );
}
