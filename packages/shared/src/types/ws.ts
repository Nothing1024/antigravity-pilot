import type { QuotaInfo } from "./api";
import type { CascadeListItem, ConnectionState, ResponsePhase } from "./cascade";
import type { Snapshot } from "./snapshot";

export type CascadeListMessage = {
  type: "cascade_list";
  cascades: Array<CascadeListItem & { quota: QuotaInfo | null }>;
};

export type SnapshotUpdateMessage = {
  type: "snapshot_update";
  cascadeId: string;
  snapshot: Snapshot;
};

export type CssUpdateMessage = {
  type: "css_update";
  cascadeId: string;
};

export type AiCompleteMessage = {
  type: "ai_complete";
  cascadeId: string;
  title: string;
};

export type QuotaUpdateMessage = {
  type: "quota_update";
  cascadeId: string;
  quota: QuotaInfo;
};

export type AutoActionMessage = {
  type: "auto_action";
  cascadeId: string;
  action: string;
  title: string;
};

export type PhaseChangeMessage = {
  type: "phase_change";
  cascadeId: string;
  phase: ResponsePhase;
  previousPhase: ResponsePhase;
};

export type ConnectionStateMessage = {
  type: "connection_state";
  cascadeId: string;
  state: ConnectionState;
  previousState: ConnectionState;
};

export type WSMessage =
  | CascadeListMessage
  | SnapshotUpdateMessage
  | CssUpdateMessage
  | AiCompleteMessage
  | QuotaUpdateMessage
  | AutoActionMessage
  | PhaseChangeMessage
  | ConnectionStateMessage;
