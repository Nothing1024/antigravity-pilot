export type TrajectoryStepType =
  | "USER_INPUT"
  | "PLANNER_RESPONSE"
  | "TOOL_USE"
  | "TOOL_RESULT"
  | (string & {});

export type TrajectoryStepStatus =
  | "PENDING"
  | "RUNNING"
  | "DONE"
  | "ERROR"
  | (string & {});

export type TrajectoryStepContent = {
  text?: string;
  [key: string]: unknown;
};

export interface TrajectoryStep {
  stepId: string;
  type: TrajectoryStepType;
  status: TrajectoryStepStatus;
  content?: TrajectoryStepContent;
  timestamp?: number;
  clientMessageId?: string;
  _corrupted?: boolean;
}
