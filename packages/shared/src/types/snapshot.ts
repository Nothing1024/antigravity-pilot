export type ClickMap = Record<number, string>;

export interface Snapshot {
  html: string;
  bodyBg: string;
  bodyColor: string;
  clickMap: ClickMap;
  hasFeedbackButtons: boolean;
  feedbackFingerprint: string | null;
}

