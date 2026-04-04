/**
 * Conversation-aware RPC routing.
 *
 * Routes RPC calls to the correct Language Server based on conversation
 * ownership (affinity). The affinity cache maps cascadeId → workspaceId.
 */

import { LSDiscovery, type LSInstance } from "./discovery";
import { RPCClient, RPCError } from "./client";
import { config } from "../config";
import { normalizeWorkspaceId, uriToWorkspaceId } from "@ag/shared";

export { normalizeWorkspaceId, uriToWorkspaceId };

// Module-scoped singletons — shared by all route modules
export const discovery = new LSDiscovery(config.rpc.discoveryInterval);
export const rpc = new RPCClient(discovery);

/**
 * Conversation → owning workspaceId affinity cache.
 * Built from conversation metadata (workspaces[0].workspaceFolderAbsoluteUri)
 * and used to route RPC calls to the correct LS instance.
 */
export const conversationAffinity = new Map<string, string>(); // cascadeId → workspaceId
export const conversationInstanceHints = new Map<string, LSInstance>(); // cascadeId → last known owner

/**
 * Route an RPC call to the correct LS for a given conversation.
 *
 * Strategy:
 *   1. If we have a cached affinity for this cascadeId → use that LS.
 *   2. Otherwise, try all LS instances (first success wins).
 *   3. On success from try-all, learn the affinity for future calls.
 */
export async function rpcForConversation<T>(
  method: string,
  cascadeId: string,
  body: Record<string, unknown> = {},
  pinnedInstance?: LSInstance,
  /** Allow try-all fallback for disk-only .pb reads. Must be false for
   *  mutation RPCs to prevent writes to the wrong LS. */
  readOnly = false,
): Promise<T> {
  const result = await resolveAndCall<T>(
    method,
    cascadeId,
    body,
    pinnedInstance,
    readOnly,
  );
  return result.data;
}

/** The LS status that indicates the agent is actively executing. */
const RUNNING_STATUS = "CASCADE_RUN_STATUS_RUNNING";

/**
 * Discover which LS instance owns a conversation by querying all instances
 * for their trajectory summaries.
 *
 * Resolution priority:
 *   1. Workspace ownership: the conversation's metadata contains a
 *      workspaceFolderAbsoluteUri — pick the LS whose workspaceId matches.
 *      If multiple LSes match (shouldn't happen), use stepCount as tiebreaker.
 *   2. (readOnly only) Status-based: if no workspace metadata is available,
 *      pick the LS that is RUNNING (definitively the owner). stepCount as
 *      tiebreaker. Only used for reads — writes require definitive ownership.
 *
 * Returns the owning instance or null if ownership cannot be determined.
 * NOTE: affinity is only learned when workspace metadata is available.
 */
export async function discoverOwnerInstance(
  cascadeId: string,
  instances: LSInstance[],
  /** When true, use RUNNING status + stepCount heuristics as fallback
   *  when no workspace metadata is available. When false (default),
   *  return null for unresolvable conversations to prevent write
   *  misrouting — writes require definitive workspace-based ownership. */
  readOnly = false,
): Promise<LSInstance | null> {
  // Collect which instances know about this conversation
  const candidates: {
    inst: LSInstance;
    stepCount: number;
    status: string;
    wsUri?: string;
  }[] = [];

  await Promise.allSettled(
    instances.map(async (inst) => {
      try {
        const data = await rpc.call<{
          trajectorySummaries?: Record<
            string,
            {
              stepCount?: number;
              status?: string;
              workspaces?: { workspaceFolderAbsoluteUri?: string }[];
            }
          >;
        }>("GetAllCascadeTrajectories", {}, inst);
        const summary = data.trajectorySummaries?.[cascadeId];
        if (!summary) return;
        candidates.push({
          inst,
          stepCount: summary.stepCount ?? 0,
          status: (summary.status as string) ?? "",
          wsUri: summary.workspaces?.[0]?.workspaceFolderAbsoluteUri,
        });
      } catch {
        // Skip unreachable instances
      }
    }),
  );

  if (candidates.length === 0) return null;

  // Determine the conversation's workspace URI (consistent across candidates)
  const wsUri = candidates.find((c) => c.wsUri)?.wsUri;

  if (wsUri) {
    const wsId = uriToWorkspaceId(wsUri);
    conversationAffinity.set(cascadeId, wsId);
    // Only route to the LS that owns this workspace — never misroute
    const normalWsId = normalizeWorkspaceId(wsId);
    const wsOwners = candidates.filter(
      (c) => c.inst.workspaceId && normalizeWorkspaceId(c.inst.workspaceId) === normalWsId,
    );
    if (wsOwners.length === 0) return null;
    wsOwners.sort((a, b) => b.stepCount - a.stepCount);
    return wsOwners[0].inst;
  }

  // No workspace metadata.
  //
  // For writes (readOnly=false): return null. Without a workspace URI we
  // cannot determine definitive ownership. Returning a heuristic guess
  // here would let mutations (SendUserCascadeMessage, RevertToCascadeStep,
  // etc.) reach a non-owner LS — the exact bug this guard prevents.
  //
  // For reads (readOnly=true): use RUNNING status + stepCount heuristics.
  // A RUNNING LS is definitively the active owner (only one LS can execute
  // a conversation at a time). Affinity is NOT learned because we don't
  // know the workspace URI.
  if (!readOnly) return null;

  candidates.sort((a, b) => {
    const aRunning = a.status === RUNNING_STATUS ? 1 : 0;
    const bRunning = b.status === RUNNING_STATUS ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning;
    return b.stepCount - a.stepCount;
  });
  return candidates[0].inst;
}

/**
 * Like rpcForConversation, but also returns which LS instance was used.
 * Use this when subsequent calls must be pinned to the same LS.
 *
 * Resolution strategy:
 *   1. Pinned instance (caller override) → use directly.
 *   2. Affinity cache hit → use that LS.
 *   3. Cache miss → discover owner via GetAllCascadeTrajectories
 *      (pick LS with highest stepCount). Fail if not found anywhere.
 */
export async function resolveAndCall<T>(
  method: string,
  cascadeId: string,
  body: Record<string, unknown> = {},
  pinnedInstance?: LSInstance,
  /** When true, enables try-all fallback for disk-only conversations.
   *  Must be false for mutation RPCs and when the returned instance
   *  will be pinned for subsequent writes. */
  readOnly = false,
): Promise<{ data: T; instance: LSInstance }> {
  const QUIET_METHODS = new Set(["GetCascadeTrajectorySteps", "GetCascadeTrajectory", "GetAllCascadeTrajectories"]);
  const verbose = !QUIET_METHODS.has(method);
  // If caller pinned a specific instance, use it directly
  if (pinnedInstance) {
    if (verbose) console.log(`[rpc:route] ${cascadeId.slice(0, 8)}… ${method} → pinned PID=${pinnedInstance.pid}`);
    const data = await rpc.call<T>(method, body, pinnedInstance);
    return { data, instance: pinnedInstance };
  }

  const instances = await discovery.getInstances();
  if (instances.length === 0) {
    throw new RPCError("No LS instances available", "unavailable");
  }

  const hinted = conversationInstanceHints.get(cascadeId);
  if (hinted) {
    const liveHint = instances.find(
      (inst) =>
        inst.pid === hinted.pid &&
        inst.httpsPort === hinted.httpsPort,
    );
    if (liveHint) {
      try {
        if (verbose) {
          console.log(
            `[rpc:route] ${cascadeId.slice(0, 8)}… ${method} → hint PID=${liveHint.pid}`,
          );
        }
        const data = await rpc.call<T>(method, body, liveHint);
        return { data, instance: liveHint };
      } catch (err) {
        if (
          err instanceof RPCError &&
          (err.code === "unavailable" || err.code === "not_found")
        ) {
          conversationInstanceHints.delete(cascadeId);
        } else {
          throw err;
        }
      }
    } else {
      conversationInstanceHints.delete(cascadeId);
    }
  }

  // Try the affinity LS first
  const wsId = conversationAffinity.get(cascadeId);
  if (wsId) {
    const normalWsId = normalizeWorkspaceId(wsId);
    const preferred = instances.find(
      (i) => i.workspaceId && normalizeWorkspaceId(i.workspaceId) === normalWsId,
    );
    if (preferred) {
      try {
        if (verbose) console.log(`[rpc:route] ${cascadeId.slice(0, 8)}… ${method} → affinity ws=${wsId} PID=${preferred.pid}`);
        const data = await rpc.call<T>(method, body, preferred);
        conversationInstanceHints.set(cascadeId, preferred);
        return { data, instance: preferred };
      } catch (err) {
        if (
          err instanceof RPCError &&
          (err.code === "unavailable" || err.code === "not_found")
        ) {
          // Affinity LS is dead or lost the conversation — clear stale affinity and re-discover
          conversationAffinity.delete(cascadeId);
        } else {
          // Application error (e.g. invalid model, internal LS error) -> throw immediately
          throw err;
        }
      }
    }
  }

  // Discover owner: query all LSes for trajectory summaries.
  // Pass readOnly so heuristic fallback (RUNNING/stepCount) is only used
  // for reads. Writes get null when workspace metadata is unavailable.
  const owner = await discoverOwnerInstance(cascadeId, instances, readOnly);
  if (owner) {
    if (verbose) console.log(`[rpc:route] ${cascadeId.slice(0, 8)}… ${method} → discovered owner PID=${owner.pid}${owner.workspaceId ? ` ws=${owner.workspaceId}` : ''}`);
    const data = await rpc.call<T>(method, body, owner);
    conversationInstanceHints.set(cascadeId, owner);
    return { data, instance: owner };
  }

  if (!readOnly && instances.length === 1) {
    const onlyInstance = instances[0];
    if (verbose) {
      console.log(
        `[rpc:route] ${cascadeId.slice(0, 8)}… ${method} → single-instance fallback PID=${onlyInstance.pid}`,
      );
    }
    const data = await rpc.call<T>(method, body, onlyInstance);
    conversationInstanceHints.set(cascadeId, onlyInstance);
    return { data, instance: onlyInstance };
  }

  // Fallback for read-only operations: conversation not in any LS's memory
  // (disk-only .pb file). Try all instances — the LS will auto-load from
  // disk if the .pb exists in its conversation store.
  //
  // Restricted to reads because multiple LSes can load the same .pb from
  // the shared conversations dir. The first success doesn't prove ownership,
  // so routing a write here could mutate state on the wrong LS.
  //
  // Since discoverOwnerInstance now handles the "candidates in memory but
  // no workspace metadata" case (using RUNNING status), this path is only
  // reached for truly unknown conversations (no LS has them in
  // GetAllCascadeTrajectories). All LSes will load the same .pb from disk,
  // so they're functionally equivalent. We still sort by RUNNING > stepCount
  // as defense-in-depth.
  if (readOnly) {
    const results: { data: T; instance: LSInstance; isRunning: boolean; stepCount: number }[] = [];
    const errors: unknown[] = [];
    await Promise.allSettled(
      instances.map(async (inst) => {
        try {
          const data = await rpc.call<T>(method, body, inst);
          const any = data as Record<string, unknown>;
          const isRunning = any.status === RUNNING_STATUS;
          const stepCount =
            (any.numTotalSteps as number) ??
            (Array.isArray(any.steps) ? (any.steps as unknown[]).length : 0);
          results.push({ data, instance: inst, isRunning, stepCount });
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    if (results.length > 0) {
      results.sort((a, b) => {
        // RUNNING LS is definitively the active owner
        if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
        return b.stepCount - a.stepCount;
      });
      if (verbose) console.log(`[rpc:route] ${cascadeId.slice(0, 8)}… ${method} → try-all fallback PID=${results[0].instance.pid}`);
      conversationInstanceHints.set(cascadeId, results[0].instance);
      return { data: results[0].data, instance: results[0].instance };
    }
    if (errors.length > 0) throw errors[0];
  }

  throw new RPCError(
    `Conversation ${cascadeId.slice(0, 8)}… not found on any Language Server`,
    "not_found",
  );
}

/**
 * Try an RPC call against all LS instances, returning the first successful result.
 * Use for operations that are NOT conversation-scoped.
 */
export async function rpcAny<T>(
  method: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const instances = await discovery.getInstances();
  let lastError: unknown;
  for (const inst of instances) {
    try {
      return await rpc.call<T>(method, body, inst);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new RPCError("No LS instances available", "unavailable");
}

/**
 * Fetch step count for a conversation from trajectory summary.
 * Optionally pin to a specific LS instance for consistency.
 */
export async function getStepCount(
  cascadeId: string,
  pinnedInstance?: LSInstance,
  /** Enable read-only try-all fallback for disk-only conversations.
   *  Use true only when the returned instance will NOT be pinned for
   *  subsequent write operations (e.g. read-only steps endpoint).
   *  Use false (default) when the instance may be reused for mutations
   *  (e.g. SendUserCascadeMessage) to prevent writes to the wrong LS. */
  readOnly = false,
): Promise<{ count: number; instance: LSInstance | undefined }> {
  try {
    const result = await resolveAndCall<{ numTotalSteps?: number }>(
      "GetCascadeTrajectory",
      cascadeId,
      { cascadeId },
      pinnedInstance,
      readOnly,
    );
    return { count: result.data.numTotalSteps ?? 0, instance: result.instance };
  } catch {
    return { count: 0, instance: undefined };
  }
}
