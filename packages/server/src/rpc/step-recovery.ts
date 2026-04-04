/**
 * Shared utilities for recovering from LS step-fetch errors.
 *
 * Known failure modes:
 *  1. Oversized step (>4MB protobuf limit) - LS tells us the offset.
 *  2. Invalid UTF-8 in a protobuf field - LS fails the whole batch.
 *
 * For (1) we skip directly. For (2) we binary-search for the next
 * offset where GetCascadeTrajectorySteps succeeds.
 */

import { RPCError } from "./client";
import type { LSInstance } from "./discovery";
import { rpcForConversation } from "./routing";

const OVERSIZED_RE = /step at offset (\d+) larger than \d+ byte limit/;

/** Return the oversized step offset from an LS error, or -1. */
export function oversizedStepOffset(err: unknown): number {
  if (!(err instanceof RPCError)) return -1;
  const match = err.message.match(OVERSIZED_RE);
  return match ? parseInt(match[1], 10) : -1;
}

/** Is this a known LS serialization error we can skip past? */
export function isRecoverableStepError(err: unknown): boolean {
  if (!(err instanceof RPCError)) return false;
  if (OVERSIZED_RE.test(err.message)) return true;
  if (err.message.includes("invalid UTF-8")) return true;
  return false;
}

/** Max total steps to skip in one fetch loop. */
export const MAX_SKIP = 1000;

/** Placeholder injected for steps the LS cannot serialize. */
export function placeholderStep(reason: string) {
  return {
    type: "CORTEX_STEP_TYPE_USER_INPUT",
    status: "CORTEX_STEP_STATUS_DONE",
    _corrupted: true,
    _corruptedReason: reason,
    userInput: { items: [{ text: `_(${reason})_` }] },
  };
}

/**
 * Binary-search for the smallest offset in [lo, hi) where
 * GetCascadeTrajectorySteps succeeds.
 *
 * Returns `hi` if no valid offset exists in the range.
 * Cost: <= log2(hi - lo) RPC round-trips (~10 for a 1000-step gap).
 */
export async function findNextValidOffset(
  cascadeId: string,
  lo: number,
  hi: number,
  instance?: LSInstance,
): Promise<number> {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    try {
      await rpcForConversation(
        "GetCascadeTrajectorySteps",
        cascadeId,
        { cascadeId, stepOffset: mid },
        instance,
        true,
      );
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}
