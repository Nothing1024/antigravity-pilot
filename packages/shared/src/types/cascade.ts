export type CascadeId = string;

// --- Response Monitor Phase (F2) ---
export enum ResponsePhase {
  /** Agent is idle, waiting for input */
  IDLE = "idle",
  /** Agent is thinking (loading indicator visible, no output yet) */
  THINKING = "thinking",
  /** Agent is generating output (stop button visible) */
  GENERATING = "generating",
  /** Agent has completed, response is ready */
  COMPLETED = "completed",
  /** Agent is waiting for user approval (Accept/Reject dialog) */
  APPROVAL_PENDING = "approval_pending",
  /** A tool is running (e.g. terminal command) */
  TOOL_RUNNING = "tool_running",
  /** Quota/rate limit error */
  QUOTA_ERROR = "quota_error",
  /** Agent error */
  ERROR = "error",
}

// --- CDP Connection State (F1) ---
export enum ConnectionState {
  CONNECTING = "connecting",
  CONNECTED = "connected",
  UNHEALTHY = "unhealthy",
  RECONNECTING = "reconnecting",
  DISCONNECTED = "disconnected",
}

// 来源：legacy server.js (已删除) resolveChatTitle() 的 source 字段。
export type TitleSource =
  | "extracted"
  | "previous"
  | "window"
  | "previous-generic"
  | "window-generic"
  | "fallback-session";

// /cascades 列表项（移动端会话选择）。
export interface CascadeListItem {
  id: CascadeId;
  title: string;
  window?: string;
  active: boolean;
  phase?: ResponsePhase;
  connectionState?: ConnectionState;
}

// 来源：legacy server.js (已删除) 中 cascade.metadata（extractMetadata + resolveChatTitle）。
export interface CascadeMetadata {
  windowTitle: string;
  chatTitle: string;
  titleSource: TitleSource;
  isActive: boolean;
  mode: "cascade" | "iframe";
}

