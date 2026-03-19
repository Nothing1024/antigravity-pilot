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

