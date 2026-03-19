export type CascadeId = string;

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
}

// 来源：legacy server.js (已删除) 中 cascade.metadata（extractMetadata + resolveChatTitle）。
export interface CascadeMetadata {
  windowTitle: string;
  chatTitle: string;
  titleSource: TitleSource;
  isActive: boolean;
  mode: "cascade" | "iframe";
}

