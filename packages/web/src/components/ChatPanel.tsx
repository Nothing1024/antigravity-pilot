import type { TrajectoryStep } from "../types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { apiUrl } from "../services/api";

import { useStepsStream } from "../hooks/useStepsStream";
import { useCascadeStore } from "../stores/cascadeStore";
import { useCapabilitiesStore } from "../stores/capabilitiesStore";
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

// ── Constants ──

const DEFAULT_VISIBLE_TURNS = 5;

const HIDDEN_TYPES = new Set([
  "EPHEMERAL_MESSAGE",
  "CHECKPOINT",
  "KNOWLEDGE_ARTIFACTS",
  "CONVERSATION_HISTORY",
]);

const TOOL_TYPES = new Set([
  "VIEW_FILE",
  "RUN_COMMAND",
  "COMMAND_STATUS",
  "CODE_ACTION",
  "GREP_SEARCH",
  "FIND",
  "MCP_TOOL",
  "TOOL_USE",
  "TOOL_RESULT",
]);

// ── Helpers ──

function stepText(step: TrajectoryStep): string {
  return typeof step.content?.text === "string" ? step.content.text : "";
}

function stepIcon(type: string): string {
  switch (type) {
    case "USER_INPUT": return "👤";
    case "PLANNER_RESPONSE": return "🤖";
    case "VIEW_FILE": return "📄";
    case "RUN_COMMAND": return "⚡";
    case "COMMAND_STATUS": return "📟";
    case "CODE_ACTION": return "✏️";
    case "GREP_SEARCH": return "🔍";
    case "FIND": return "🔍";
    case "MCP_TOOL": return "🔧";
    case "ERROR_MESSAGE": return "❌";
    case "TOOL_USE": return "🔧";
    case "TOOL_RESULT": return "📋";
    default: return "📌";
  }
}

function stepLabel(type: string): string {
  switch (type) {
    case "USER_INPUT": return "User";
    case "PLANNER_RESPONSE": return "Assistant";
    case "VIEW_FILE": return "View File";
    case "RUN_COMMAND": return "Run Command";
    case "COMMAND_STATUS": return "Command Status";
    case "CODE_ACTION": return "Code Edit";
    case "GREP_SEARCH": return "Search";
    case "FIND": return "Find";
    case "MCP_TOOL": return "MCP Tool";
    case "ERROR_MESSAGE": return "Error";
    case "TOOL_USE": return "Tool";
    case "TOOL_RESULT": return "Result";
    default: return type.replace(/_/g, " ").toLowerCase();
  }
}

// ── Markdown rendering ──

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text: string): string {
  try {
    return marked.parse(text) as string;
  } catch {
    return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

function hasMarkdown(text: string): boolean {
  return /(\*\*|__|#{1,6}\s|```|^\s*[-*]\s|^\|.+\|)/m.test(text);
}

// ── Step filtering ──

function isVisible(step: TrajectoryStep | null | undefined): step is TrajectoryStep {
  if (!step) return false;
  if (step._corrupted) return false;
  if (HIDDEN_TYPES.has(step.type)) return false;
  if (step.type === "PLANNER_RESPONSE" && !stepText(step)) return false;
  if (step.type === "USER_INPUT" && !stepText(step)) return false;
  if (step.type === "ERROR_MESSAGE" && !stepText(step)) return false;
  return true;
}

function isToolLike(step: TrajectoryStep): boolean {
  if (TOOL_TYPES.has(step.type)) return true;
  if (step.type === "PLANNER_RESPONSE" && step.toolOnly) return true;
  return false;
}

// ── Turn model ──

interface Turn {
  /** The USER_INPUT step that starts this turn */
  userStep: TrajectoryStep;
  /** Assistant prose responses (non-tool planner responses) */
  assistantSteps: TrajectoryStep[];
  /** All tool-like steps (tool calls + tool results + toolOnly planners) */
  toolSteps: TrajectoryStep[];
  /** Error steps */
  errorSteps: TrajectoryStep[];
  /** Tool names extracted from toolOnly planner responses (for group header) */
  toolNames: string[];
  /** Is any step still running/generating? */
  isActive: boolean;
}

function buildTurns(steps: TrajectoryStep[]): Turn[] {
  const filtered = steps.filter(isVisible);
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const flush = () => {
    if (current) turns.push(current);
  };

  for (const step of filtered) {
    if (step.type === "USER_INPUT") {
      flush();
      current = {
        userStep: step,
        assistantSteps: [],
        toolSteps: [],
        errorSteps: [],
        toolNames: [],
        isActive: false,
      };
      continue;
    }

    // If no user step yet, skip (shouldn't happen but be safe)
    if (!current) continue;

    if (step.type === "ERROR_MESSAGE") {
      current.errorSteps.push(step);
    } else if (isToolLike(step)) {
      current.toolSteps.push(step);
      // Extract tool names from toolOnly planner responses for group header
      if (step.type === "PLANNER_RESPONSE" && step.toolOnly) {
        const names = stepText(step).split(", ").filter(Boolean);
        for (const n of names) {
          if (!current.toolNames.includes(n)) current.toolNames.push(n);
        }
      }
    } else if (step.type === "PLANNER_RESPONSE") {
      current.assistantSteps.push(step);
    }

    if (step.status === "RUNNING" || step.status === "GENERATING") {
      current.isActive = true;
    }
  }
  flush();
  return turns;
}

// ── Sub-components ──

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    DONE: { color: "text-green-400", label: "✓" },
    RUNNING: { color: "text-yellow-400", label: "⟳" },
    GENERATING: { color: "text-blue-400", label: "⟳" },
    ERROR: { color: "text-red-400", label: "✗" },
    PENDING: { color: "text-gray-400", label: "…" },
  };
  const info = map[status] ?? { color: "text-gray-400", label: status };
  return <span className={`text-[10px] ${info.color}`}>{info.label}</span>;
}

const COLLAPSE_THRESHOLD = 400;

function MessageContent({ text, type }: { text: string; type: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > COLLAPSE_THRESHOLD;
  const isAssistant = type === "PLANNER_RESPONSE";
  const shouldCollapse = isAssistant && isLong && !expanded;

  const displayText = shouldCollapse ? text.slice(0, COLLAPSE_THRESHOLD) + "…" : text;

  if (isAssistant && hasMarkdown(displayText)) {
    return (
      <div>
        <div
          className="prose prose-sm prose-invert max-w-none text-foreground/90
            prose-headings:text-foreground prose-headings:mt-3 prose-headings:mb-1 prose-headings:text-sm
            prose-p:my-1 prose-p:leading-relaxed
            prose-ul:my-1 prose-li:my-0
            prose-code:text-blue-300 prose-code:bg-blue-500/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded
            prose-pre:bg-black/30 prose-pre:border prose-pre:border-border/30
            prose-table:text-xs
            prose-th:text-muted-foreground prose-th:border-border prose-th:px-2 prose-th:py-1
            prose-td:border-border prose-td:px-2 prose-td:py-1
            prose-strong:text-foreground prose-strong:font-semibold
            prose-a:text-blue-400"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(displayText) }}
        />
        {isLong && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            {expanded ? "收起 ▲" : "展开全部 ▼"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
        {displayText}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
        >
          {expanded ? "收起 ▲" : "展开全部 ▼"}
        </button>
      )}
    </div>
  );
}

/** Compact one-liner for a tool step (excludes toolOnly planner responses) */
function ToolStepRow({ step }: { step: TrajectoryStep }) {
  // Skip toolOnly planner responses — their names are in the group header
  if (step.type === "PLANNER_RESPONSE" && step.toolOnly) return null;

  const text = stepText(step);
  return (
    <div className="flex items-start gap-2 rounded border border-border/40 bg-muted/20 px-2 py-1.5 text-xs">
      <span className="shrink-0 mt-0.5">{stepIcon(step.type)}</span>
      <div className="min-w-0 flex-1">
        <span className="font-medium text-muted-foreground">{stepLabel(step.type)}</span>
        {text && (
          <span className="ml-2 text-foreground/70 break-all font-mono text-[11px]">{
            text.length > 120 ? text.slice(0, 120) + "…" : text
          }</span>
        )}
      </div>
      <StatusBadge status={step.status} />
    </div>
  );
}

/** Collapsible tool group within a turn */
function TurnToolGroup({ steps, toolNames }: { steps: TrajectoryStep[]; toolNames: string[] }) {
  const [expanded, setExpanded] = useState(false);

  // Only count non-toolOnly steps for display
  const displaySteps = steps.filter(s => !(s.type === "PLANNER_RESPONSE" && s.toolOnly));
  if (displaySteps.length === 0) return null;

  const allDone = displaySteps.every(s => s.status === "DONE");
  const hasRunning = displaySteps.some(s => s.status === "RUNNING" || s.status === "GENERATING");

  // Header shows tool names summary
  const headerNames = toolNames.length > 0 
    ? toolNames.slice(0, 5).join(", ") + (toolNames.length > 5 ? ` +${toolNames.length - 5}` : "")
    : `${displaySteps.length} 个工具步骤`;

  return (
    <div className="space-y-1">
      {/* Tool group header — click to toggle */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 rounded-md border border-border/30 bg-muted/10 px-3 py-1.5 text-xs
          hover:bg-muted/20 transition-colors cursor-pointer"
      >
        <span className="shrink-0">🔧</span>
        <span className="text-muted-foreground font-medium truncate flex-1 text-left">
          {headerNames}
        </span>
        <span className="text-[10px] text-muted-foreground/60">
          {displaySteps.length} 步
        </span>
        {hasRunning ? (
          <span className="text-yellow-400 text-[10px] animate-pulse">⟳</span>
        ) : allDone ? (
          <span className="text-green-400 text-[10px]">✓</span>
        ) : null}
        <span className="text-muted-foreground/50 text-[10px]">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {/* Expanded: show all tool steps */}
      {expanded && (
        <div className="ml-3 space-y-1 border-l-2 border-border/20 pl-2">
          {displaySteps.map((step, i) => (
            <ToolStepRow key={step.stepId || `tool-${i}`} step={step} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single conversation Turn: user message + assistant response + tool group */
function TurnCard({ turn, turnIndex }: { turn: Turn; turnIndex: number }) {
  const userText = stepText(turn.userStep);
  // Get the last assistant response (the "final answer")
  const lastAssistant = turn.assistantSteps.length > 0
    ? turn.assistantSteps[turn.assistantSteps.length - 1]
    : null;

  return (
    <div className="space-y-2">
      {/* Turn divider */}
      <div className="flex items-center gap-2 pt-1">
        <div className="h-px flex-1 bg-border/20" />
        <span className="text-[10px] text-muted-foreground/40 font-mono">
          #{turnIndex + 1}
        </span>
        <div className="h-px flex-1 bg-border/20" />
      </div>

      {/* User message */}
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="mb-1 flex items-center gap-2 text-[11px]">
          <span>👤</span>
          <span className="font-medium text-muted-foreground">User</span>
          <span className="ml-auto"><StatusBadge status={turn.userStep.status} /></span>
        </div>
        <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
          {userText}
        </pre>
      </div>

      {/* Tool group (collapsed by default with names in header) */}
      {turn.toolSteps.length > 0 && (
        <TurnToolGroup steps={turn.toolSteps} toolNames={turn.toolNames} />
      )}

      {/* Error messages */}
      {turn.errorSteps.map((step, i) => (
        <div key={step.stepId || `err-${i}`} className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px]">
            <span>❌</span>
            <span className="font-medium text-red-400">Error</span>
          </div>
          <pre className="whitespace-pre-wrap text-xs text-red-300/80">{stepText(step)}</pre>
        </div>
      ))}

      {/* Assistant response (final prose answer) */}
      {lastAssistant ? (
        <div className="rounded-md border border-border/70 bg-background/50 p-3">
          <div className="mb-1 flex items-center gap-2 text-[11px]">
            <span>🤖</span>
            <span className="font-medium text-muted-foreground">Assistant</span>
            <span className="ml-auto"><StatusBadge status={lastAssistant.status} /></span>
          </div>
          <MessageContent text={stepText(lastAssistant)} type="PLANNER_RESPONSE" />
        </div>
      ) : turn.isActive ? (
        <div className="rounded-md border border-border/50 bg-background/30 p-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground animate-pulse">
            <span>🤖</span>
            <span>思考中…</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── Main component ──

export function ChatPanel({
  cascadeId,
  onContentUpdate,
  onFileChanges,
  onToolbarButtons,
  onActionButtons,
}: Props) {
  const { steps, connected, running, error, switchTo } = useStepsStream(cascadeId);
  const cdpSnapshotEnabled = useCapabilitiesStore((s) => s.capabilities.cdp.snapshot);
  const [visibleTurns, setVisibleTurns] = useState(DEFAULT_VISIBLE_TURNS);

  // ── Conversation history ──
  type ConvSummary = { id: string; status: string; numTotalSteps: number; workspace?: string };
  const [conversations, setConversations] = useState<ConvSummary[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);

  // Get workspace from current cascade for filtering
  const cascades = useCascadeStore((s) => s.cascades);
  const currentCascade = cascades.find((c) => c.id === cascadeId);
  const workspaceUri = currentCascade?.workspaceUri ?? currentCascade?.workspace ?? "";

  // Reset local state when cascade changes
  useEffect(() => {
    setConversations([]);
    setActiveConvId(null);
    setVisibleTurns(DEFAULT_VISIBLE_TURNS);
  }, [cascadeId]);

  // Fetch conversation list on mount and periodically, scoped to workspace
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const wsParam = workspaceUri ? `?workspace=${encodeURIComponent(workspaceUri)}` : "";
        const res = await fetch(apiUrl(`/api/conversations/history${wsParam}`));
        const data = await res.json();
        if (!cancelled && Array.isArray(data.conversations)) {
          setConversations(data.conversations);
        }
      } catch { /* ignore */ }
    };
    void load();
    const timer = setInterval(load, 30_000); // refresh every 30s
    return () => { cancelled = true; clearInterval(timer); };
  }, [cascadeId, workspaceUri]);

  const handleConvSwitch = useCallback((convId: string) => {
    setActiveConvId(convId);
    switchTo(convId);
  }, [switchTo]);

  const turns = useMemo(() => buildTurns(steps), [steps]);

  // Only show the last N turns
  const startIdx = Math.max(0, turns.length - visibleTurns);
  const displayedTurns = turns.slice(startIdx);
  const hasMore = startIdx > 0;

  const loadMore = useCallback(() => {
    setVisibleTurns(prev => Math.min(prev + 5, turns.length));
  }, [turns.length]);

  const loadAll = useCallback(() => {
    setVisibleTurns(turns.length);
  }, [turns.length]);

  return (
    <div className="flex flex-col gap-4 py-4">
      <div>
        {/* Header */}
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground flex items-center gap-2">
            <span>对话</span>
            {!connected && (
              <span className="inline-flex items-center gap-1 text-red-400">
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                <span>离线</span>
              </span>
            )}
            {connected && running && (
              <span className="inline-flex items-center gap-1 text-green-400">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-green-500" />
                </span>
                <span>进行中</span>
              </span>
            )}
            {connected && !running && (
              <span className="inline-flex items-center gap-1 text-muted-foreground/50">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
                <span>就绪</span>
              </span>
            )}
            <span className="text-[10px] opacity-50">
              ({turns.length} 轮 · {steps.length} 步)
            </span>
          </div>
          <div className="flex items-center gap-2">
            {/* Conversation history picker */}
            {conversations.length > 1 && (
              <select
                className="rounded bg-muted/30 border border-border/30 px-1.5 py-0.5 text-[10px] text-muted-foreground
                  focus:outline-none focus:ring-1 focus:ring-blue-500/30 max-w-[140px]"
                value={activeConvId ?? ""}
                onChange={(e) => handleConvSwitch(e.target.value)}
              >
                <option value="" disabled>切换会话</option>
                {conversations.map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {c.status === "RUNNING" ? "▶ " : ""}
                    #{i + 1} ({c.numTotalSteps}步)
                    {c.id.slice(0, 6)}
                  </option>
                ))}
              </select>
            )}
            {/* Turns selector */}
            <select
              className="rounded bg-muted/30 border border-border/30 px-1.5 py-0.5 text-[10px] text-muted-foreground
                focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              value={visibleTurns}
              onChange={(e) => setVisibleTurns(Number(e.target.value))}
            >
              {[3, 5, 10, 20, 50].map(n => (
                <option key={n} value={n}>最近 {n} 轮</option>
              ))}
              <option value={99999}>全部</option>
            </select>
          </div>
        </div>

        {error ? (
          <div className="text-sm text-red-500">{error}</div>
        ) : turns.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-sm text-muted-foreground gap-2">
            <svg className="animate-spin h-5 w-5 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" strokeLinecap="round"/>
            </svg>
            <span>等待对话…</span>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Load more button */}
            {hasMore && (
              <div className="flex items-center justify-center gap-2 py-1">
                <button
                  onClick={loadMore}
                  className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors"
                >
                  ↑ 加载更早 5 轮对话
                </button>
                <span className="text-[10px] text-muted-foreground/30">|</span>
                <button
                  onClick={loadAll}
                  className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  全部 ({turns.length} 轮)
                </button>
              </div>
            )}

            {/* Turn cards */}
            {displayedTurns.map((turn, i) => (
              <TurnCard
                key={turn.userStep.stepId || `turn-${startIdx + i}`}
                turn={turn}
                turnIndex={startIdx + i}
              />
            ))}
          </div>
        )}
      </div>

      {/* Shadow DOM UI mirror — only render when CDP snapshot is enabled */}
      {cdpSnapshotEnabled && (
        <div className="min-h-0">
          <ChatViewport
            cascadeId={cascadeId}
            onContentUpdate={onContentUpdate}
            onFileChanges={onFileChanges}
            onToolbarButtons={onToolbarButtons}
            onActionButtons={onActionButtons}
          />
        </div>
      )}
    </div>
  );
}
