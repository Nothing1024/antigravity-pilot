import type { TrajectoryStep } from "../types";

import { useStepsStream } from "../hooks/useStepsStream";
import { ChatViewport } from "./chat/ChatViewport";
import type { FileChange } from "./chat/FileChangesBar";
import type { ToolbarButton } from "./chat/ToolbarButtonsBar";

type Props = {
  cascadeId: string | null;
  onContentUpdate?: () => void;
  onFileChanges?: (files: FileChange[]) => void;
  onToolbarButtons?: (buttons: ToolbarButton[]) => void;
  onActionButtons?: (actions: ToolbarButton[]) => void;
};

function stepText(step: TrajectoryStep): string {
  if (typeof step.content?.text === "string") return step.content.text;
  if (!step.content) return "";
  try {
    return JSON.stringify(step.content, null, 2);
  } catch {
    return String(step.content);
  }
}

function stepTitle(step: TrajectoryStep): string {
  switch (step.type) {
    case "USER_INPUT":
      return "User";
    case "PLANNER_RESPONSE":
      return "Assistant";
    case "TOOL_USE":
      return "Tool";
    case "TOOL_RESULT":
      return "Result";
    default:
      return step.type;
  }
}

export function ChatPanel({
  cascadeId,
  onContentUpdate,
  onFileChanges,
  onToolbarButtons,
  onActionButtons,
}: Props) {
  const { steps, connected, running, error } = useStepsStream(cascadeId);

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="rounded-lg border border-border bg-card/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">
            Steps
            {connected ? "" : " • offline"}
            {running ? " • running" : ""}
          </div>
          <div className="text-[11px] text-muted-foreground">
            {cascadeId ? cascadeId.slice(0, 8) : "—"}
          </div>
        </div>

        {error ? (
          <div className="text-sm text-red-500">{error}</div>
        ) : steps.length === 0 ? (
          <div className="text-sm text-muted-foreground">Waiting for steps…</div>
        ) : (
          <div className="space-y-2">
            {steps.map((step, idx) => (
              <div
                key={step.stepId || String(idx)}
                className={[
                  "rounded-md border border-border/70 p-2",
                  step.type === "USER_INPUT" ? "bg-muted/50" : "bg-background/50",
                ].join(" ")}
              >
                <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{stepTitle(step)}</span>
                  <span>{step.status}</span>
                </div>
                <pre className="whitespace-pre-wrap text-sm leading-relaxed">
                  {stepText(step)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Shadow DOM UI mirror (legacy snapshot_update / CDP fallback). Keep for compatibility. */}
      <div className="min-h-[60vh]">
        <ChatViewport
          cascadeId={cascadeId}
          onContentUpdate={onContentUpdate}
          onFileChanges={onFileChanges}
          onToolbarButtons={onToolbarButtons}
          onActionButtons={onActionButtons}
        />
      </div>
    </div>
  );
}
