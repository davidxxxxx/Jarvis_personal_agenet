import { useState } from "react";
import { ListPlus } from "lucide-react";
import type { JarvisTranscriptSegment } from "../types";
import { createKnowledgeActionId, TodoComposerDialog } from "./KnowledgeActionDialogs";

export default function TranscriptTodoButton({
  sessionId,
  segment,
  onCreated,
}: {
  sessionId: string;
  segment: JarvisTranscriptSegment;
  onCreated?: () => void;
}) {
  const [composerCommand, setComposerCommand] = useState<{
    commandId: string;
    todoId: string;
  } | null>(null);
  const [created, setCreated] = useState(false);

  if (segment.result_kind !== "final") return null;

  return (
    <>
      <button
        type="button"
        disabled={created}
        onClick={() =>
          setComposerCommand({
            commandId: createKnowledgeActionId("command"),
            todoId: createKnowledgeActionId("todo"),
          })
        }
        aria-label="从该转写创建 Todo"
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:opacity-70"
      >
        <ListPlus className="size-3" aria-hidden="true" />
        {created ? "已加入 Todo" : "转为 Todo"}
      </button>
      {composerCommand && (
        <TodoComposerDialog
          heading="从转写创建待办"
          description="请自行填写独立的待办标题。转写原文不会自动成为标题；系统只保存这条转写的本地引用。"
          confirmLabel="创建待办"
          initialTitle=""
          onCancel={() => setComposerCommand(null)}
          onConfirm={async ({ title, dueText }) => {
            await window.electronAPI.jarvis.applyKnowledgeAction({
              commandId: composerCommand.commandId,
              type: "transcript_create",
              todoId: composerCommand.todoId,
              title,
              dueText,
              sessionId,
              segmentIds: [segment.id],
            });
            setComposerCommand(null);
            setCreated(true);
            onCreated?.();
          }}
        />
      )}
    </>
  );
}
