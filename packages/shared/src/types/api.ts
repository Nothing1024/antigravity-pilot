export type ApiErrorResponse = {
  error: string;
};

export type ApiSuccessResponse = {
  success: true;
};

export type LoginRequestBody = {
  password: string;
};

export type LoginResponse = ApiSuccessResponse | ApiErrorResponse;

export type CascadesResponse = Array<{
  id: string;
  title: string;
  active: boolean;
}>;

type ClickMap = Record<number, string>;

type SnapshotPayload = {
  html: string;
  bodyBg: string;
  bodyColor: string;
  clickMap: ClickMap;
  hasFeedbackButtons: boolean;
  feedbackFingerprint: string | null;
};

export type GetSnapshotResponse = SnapshotPayload | ApiErrorResponse;

export type StylesResponse = {
  css: string;
  computedVars: Record<string, string>;
};

export type GetStylesResponse = StylesResponse | ApiErrorResponse;

export type QuotaModel = {
  label: string;
  percentage: number | null;
  resetTime: string;
};

export type QuotaInfo = {
  statusText: string;
  planName: string | null;
  models: QuotaModel[];
};

export type GetQuotaResponse = QuotaInfo | ApiErrorResponse;

export type SendMessageRequestBody = {
  message: string;
};

export type SendMessageResponse =
  | ApiSuccessResponse
  | { ok: false; reason: string }
  | ApiErrorResponse;

export type ClickRequestBody = {
  index: number;
};

export type ClickResponse =
  | (ApiSuccessResponse & { text: string; filePath: string | null })
  | ApiErrorResponse;

export type ScrollRequestBody =
  | { deltaY: number; ratio?: never; scrollTop?: never }
  | { ratio: number; deltaY?: never; scrollTop?: never }
  | { scrollTop: number; deltaY?: never; ratio?: never };

export type ScrollResponse =
  | (ApiSuccessResponse & {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    })
  | ApiErrorResponse;

export type NewConversationResponse = ApiSuccessResponse | ApiErrorResponse;

export type GetVapidKeyResponse =
  | {
      publicKey: string;
    }
  | ApiErrorResponse;

export type PushSubscriptionJSON = {
  endpoint: string;
  expirationTime?: number | null;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
};

export type SubscribePushResponse = ApiSuccessResponse | ApiErrorResponse;

export type UnsubscribePushRequestBody = {
  endpoint: string;
};

export type UnsubscribePushResponse = ApiSuccessResponse | ApiErrorResponse;

export type AutoActionSettings = {
  autoAcceptAll: boolean;
  autoRetry: boolean;
  retryBackoff: boolean;
};

export type GetAutoActionsResponse = AutoActionSettings | ApiErrorResponse;
export type SetAutoActionsResponse = AutoActionSettings | ApiErrorResponse;

// --- System Status API (F3) ---

import type { ConnectionState, ResponsePhase } from "./cascade";

export type CascadeStatus = {
  id: string;
  title: string;
  phase: ResponsePhase;
  connected: boolean;
  connectionState: ConnectionState;
  lastSnapshot: string | null;
  metadata: {
    chatTitle: string;
    windowTitle: string;
    isActive: boolean;
  };
};

export type ConnectionPoolStatus = {
  active: number;
  unhealthy: number;
  reconnecting: number;
  disconnected: number;
  maxConnections: number;
};

export type SystemStatusResponse = {
  version: string;
  uptime: number;
  cascades: CascadeStatus[];
  connectionPool: ConnectionPoolStatus;
};

// --- Screenshot API (F3) ---

export type ScreenshotResponse =
  | {
      image: string;
      width: number;
      height: number;
      timestamp: string;
    }
  | ApiErrorResponse;

// --- OpenAI-Compatible API Types (F4) ---

export type OAIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type OAIChatCompletionRequest = {
  model: string;
  messages: OAIMessage[];
  stream?: boolean;
  max_tokens?: number | null;
  temperature?: number | null;
};

export type OAIChatCompletionChoice = {
  index: number;
  message: OAIMessage;
  finish_reason: "stop" | "error" | "length" | null;
};

export type OAIChatCompletionResponse = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OAIChatCompletionChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type OAIStreamDelta = {
  role?: string;
  content?: string;
};

export type OAIStreamChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: OAIStreamDelta;
    finish_reason: "stop" | "error" | null;
  }>;
};

export type OAIModelObject = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

export type OAIModelListResponse = {
  object: "list";
  data: OAIModelObject[];
};

// --- API Key Config ---

export type ApiKeyConfig = {
  key: string;
  name: string;
};

// --- Session API Types (Phase 2) ---

export type SessionItem = {
  title: string;
  selector: string;
  active: boolean;
};

export type SessionListResponse = {
  sessions: SessionItem[];
  switcherSelector: string | null;
  hint: string | null;
};

// --- Model API Types (Phase 2) ---

export type ModelInfo = {
  model: string | null;
  source: string;
};

export type ModelOption = {
  name: string;
  selected: boolean;
  selector: string;
};

export type ModelListResponse = {
  current: string | null;
  models: ModelOption[];
};

// --- Rate Limit Info ---

export type RateLimitInfo = {
  limit: number;
  remaining: number;
  reset: string;
};

// --- Capabilities API ---

export type ServerMode = "hybrid" | "cdp-only" | "rpc-only" | "disconnected";

export type CapabilitiesResponse = {
  mode: ServerMode;
  cdp: {
    enabled: boolean;
    snapshot: boolean;
    connected: boolean;
  };
  rpc: {
    enabled: boolean;
    fallbackToCDP: boolean;
  };
  features: {
    simplify: boolean;
    screenshot: boolean;
    clickPassthrough: boolean;
    scrollSync: boolean;
    filePreview: boolean;
    messaging: boolean;
    trajectory: boolean;
    conversationHistory: boolean;
    modelSwitch: boolean;
    sessionSwitch: boolean;
    autoActions: boolean;
    pushNotifications: boolean;
  };
};
