const PENDING_TTL_MS = 10 * 60 * 1000;
const CONFIRMED_TTL_MS = 2 * 60 * 1000;

interface PendingMessage {
  clientMessageId: string;
  minStepOffset: number;
  expiresAt: number;
}

interface ConfirmedMessage {
  clientMessageId: string;
  expiresAt: number;
}

interface ConversationMessageState {
  pending: PendingMessage[];
  confirmedByStepOffset: Map<number, ConfirmedMessage>;
}

function isTrackableUserStep(step: unknown): step is Record<string, unknown> {
  if (!step || typeof step !== "object") return false;
  const record = step as Record<string, unknown>;
  return (
    record.type === "CORTEX_STEP_TYPE_USER_INPUT" &&
    record._corrupted !== true
  );
}

function annotateStep(
  step: unknown,
  clientMessageId: string,
): Record<string, unknown> {
  const record = step as Record<string, unknown>;
  if (record.clientMessageId === clientMessageId) return record;
  return { ...record, clientMessageId };
}

export class ConversationMessageTracker {
  private readonly conversations = new Map<string, ConversationMessageState>();

  trackPendingMessage(
    cascadeId: string,
    clientMessageId: string,
    minStepOffset: number,
    now = Date.now(),
  ): void {
    const state = this.getState(cascadeId, true);
    this.pruneState(state, now);

    state.pending = state.pending.filter(
      (entry) => entry.clientMessageId !== clientMessageId,
    );
    for (const [stepOffset, confirmed] of state.confirmedByStepOffset) {
      if (confirmed.clientMessageId === clientMessageId) {
        state.confirmedByStepOffset.delete(stepOffset);
      }
    }

    state.pending.push({
      clientMessageId,
      minStepOffset,
      expiresAt: now + PENDING_TTL_MS,
    });
  }

  annotateSteps(
    cascadeId: string,
    offset: number,
    steps: unknown[],
    now = Date.now(),
  ): unknown[] {
    const state = this.getState(cascadeId, false);
    if (!state || steps.length === 0) return steps;

    this.pruneState(state, now);
    if (state.pending.length === 0 && state.confirmedByStepOffset.size === 0) {
      this.conversations.delete(cascadeId);
      return steps;
    }

    let annotatedSteps = steps;

    const setAnnotatedStep = (index: number, clientMessageId: string) => {
      const current = annotatedSteps[index];
      if (!isTrackableUserStep(current)) return;
      const next = annotateStep(current, clientMessageId);
      if (next === current) return;
      if (annotatedSteps === steps) {
        annotatedSteps = steps.slice();
      }
      annotatedSteps[index] = next;
    };

    for (const [stepOffset, confirmed] of state.confirmedByStepOffset) {
      const index = stepOffset - offset;
      if (index < 0 || index >= steps.length) continue;
      setAnnotatedStep(index, confirmed.clientMessageId);
    }

    for (let index = 0; index < steps.length; index++) {
      const stepOffset = offset + index;
      const step = annotatedSteps[index];
      if (!isTrackableUserStep(step)) continue;
      if ((step as Record<string, unknown>).clientMessageId) continue;

      const pending = state.pending[0];
      if (!pending) break;
      if (stepOffset < pending.minStepOffset) continue;

      setAnnotatedStep(index, pending.clientMessageId);
      state.pending.shift();
      state.confirmedByStepOffset.set(stepOffset, {
        clientMessageId: pending.clientMessageId,
        expiresAt: now + CONFIRMED_TTL_MS,
      });
    }

    if (state.pending.length === 0 && state.confirmedByStepOffset.size === 0) {
      this.conversations.delete(cascadeId);
    }

    return annotatedSteps;
  }

  clearConversation(cascadeId: string): void {
    this.conversations.delete(cascadeId);
  }

  private getState(
    cascadeId: string,
    create: true,
  ): ConversationMessageState;
  private getState(
    cascadeId: string,
    create: false,
  ): ConversationMessageState | undefined;
  private getState(
    cascadeId: string,
    create: boolean,
  ): ConversationMessageState | undefined {
    const existing = this.conversations.get(cascadeId);
    if (existing || !create) return existing;

    const created: ConversationMessageState = {
      pending: [],
      confirmedByStepOffset: new Map(),
    };
    this.conversations.set(cascadeId, created);
    return created;
  }

  private pruneState(state: ConversationMessageState, now: number): void {
    state.pending = state.pending.filter((entry) => entry.expiresAt > now);
    for (const [stepOffset, confirmed] of state.confirmedByStepOffset) {
      if (confirmed.expiresAt <= now) {
        state.confirmedByStepOffset.delete(stepOffset);
      }
    }
  }
}

export const messageTracker = new ConversationMessageTracker();
