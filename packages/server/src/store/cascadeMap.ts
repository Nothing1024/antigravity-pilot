/**
 * Unified CDP cascade hash ↔ RPC conversation UUID mapping.
 *
 * The system has two ID namespaces:
 *   - CDP hash: `hashString(webSocketDebuggerUrl)`, e.g. "-xaveo6"
 *   - RPC UUID: real conversation UUID from LS trajectories
 *
 * This module provides a **single source of truth** for the mapping,
 * replacing the ad-hoc heuristics previously spread across ws-poller,
 * phase monitor, cascade API, etc.
 *
 * Only active when RPC is enabled (hybrid mode). In CDP-only mode this
 * module is a no-op — all lookups return undefined.
 */

import { normalizeWorkspaceId, uriToWorkspaceId } from "@ag/shared";

import { config } from "../config";
import { discovery, rpc } from "../rpc/routing";
import type { LSInstance } from "../rpc/discovery";

export interface CascadeMapping {
  /** CDP hash (cascadeStore key) */
  cascadeId: string;
  /** RPC conversation UUID */
  conversationId: string;
  /** Normalized workspace ID */
  workspaceId: string;
  /** Raw workspace URI from LS */
  workspaceUri: string;
  /** Last successful resolution timestamp */
  lastSeen: number;
}

class CascadeMap {
  private byCascade = new Map<string, CascadeMapping>();
  private byConversation = new Map<string, CascadeMapping>();

  set(mapping: CascadeMapping): void {
    // Remove stale reverse mapping ONLY if this cascade was previously bound
    // to a DIFFERENT conversation.
    const oldByCascade = this.byCascade.get(mapping.cascadeId);
    if (oldByCascade && oldByCascade.conversationId !== mapping.conversationId) {
      // Only clean up the reverse if no other cascade still references that conversation
      const otherRefs = [...this.byCascade.values()].filter(
        (m) => m.conversationId === oldByCascade.conversationId && m.cascadeId !== mapping.cascadeId
      );
      if (otherRefs.length === 0) {
        this.byConversation.delete(oldByCascade.conversationId);
      }
    }

    // Multiple cascades CAN map to the same conversationId (different windows, same workspace).
    // byConversation stores only the most recent one (used for reverse lookups).
    this.byCascade.set(mapping.cascadeId, mapping);
    this.byConversation.set(mapping.conversationId, mapping);
  }

  getByCascade(cascadeId: string): CascadeMapping | undefined {
    return this.byCascade.get(cascadeId);
  }

  getByConversation(conversationId: string): CascadeMapping | undefined {
    return this.byConversation.get(conversationId);
  }

  delete(cascadeId: string): void {
    const mapping = this.byCascade.get(cascadeId);
    if (mapping) {
      this.byConversation.delete(mapping.conversationId);
      this.byCascade.delete(cascadeId);
    }
  }

  /** All known mappings. */
  getAll(): CascadeMapping[] {
    return [...this.byCascade.values()];
  }

  /** Clear all mappings (e.g. when all cascades disconnect). */
  clear(): void {
    this.byCascade.clear();
    this.byConversation.clear();
  }

  /**
   * Attempt to resolve the mapping for a CDP cascade.
   *
   * Strategy:
   *   1. Extract workspace name from the cascade's window title.
   *   2. Find the LS instance that owns that workspace.
   *   3. Query that LS for its trajectory summaries.
   *   4. Pick the conversation whose workspace matches.
   *      - Prefer RUNNING, then highest step count.
   *
   * @returns The resolved CascadeMapping, or null if resolution failed.
   */
  async enrich(
    cascadeId: string,
    windowTitle: string,
    instances?: LSInstance[],
  ): Promise<CascadeMapping | null> {
    if (!config.rpc.enabled) return null;

    const lsInstances = instances ?? await discovery.getInstances();
    if (lsInstances.length === 0) return null;

    // Step 1: Extract workspace name from window title
    const wsName = (
      windowTitle.split(" — ")[0] || windowTitle.split(" - ")[0] || ""
    ).trim().toLowerCase();
    if (!wsName) return null;

    // Step 2: Find matching LS instance(s)
    // Use strict matching: require exact segment match to avoid "short" matching "short-factory" etc.
    const matchedInstances = lsInstances.filter((inst) => {
      if (!inst.workspaceId) return false;
      const normalId = inst.workspaceId.toLowerCase();
      const segments = normalId.split("_");
      const lastSeg = segments[segments.length - 1] ?? "";

      // Exact match on last segment (most common: "vibee" ↔ "vibee")
      if (lastSeg === wsName) return true;
      // Full path ends with the workspace name
      if (normalId.endsWith(wsName.replace(/-/g, "_"))) return true;
      if (normalId.endsWith(wsName)) return true;

      return false;
    });

    if (matchedInstances.length === 0) {
      // debug: show why we couldn't match
      console.log(
        `[cascadeMap] enrich(${cascadeId.slice(0, 8)}) wsName="${wsName}" — no match among: ${lsInstances.map((i) => i.workspaceId?.split("_").pop()).join(", ")}`,
      );
      return null;
    }

    // Step 3: Query matched instances for their conversations
    // IMPORTANT: Each LS returns ALL conversations across ALL workspaces,
    // so we MUST filter by workspace URI after querying.
    type Candidate = {
      convId: string;
      status: string;
      steps: number;
      wsUri: string;
      wsId: string;
      inst: LSInstance;
    };
    const candidates: Candidate[] = [];

    // Build the target workspace URI pattern from the matched LS instance
    // e.g. "file_Users_nothing_workspace_vibee" → "/Users/nothing/workspace/vibee"
    const targetWsPatterns = matchedInstances.map((inst) => {
      const wsId = inst.workspaceId ?? "";
      // Convert "file_Users_nothing_workspace_vibee" → "users/nothing/workspace/vibee"
      return wsId.replace(/^file_/, "").replace(/_/g, "/").toLowerCase();
    });

    await Promise.allSettled(
      matchedInstances.map(async (inst) => {
        try {
          const data = await rpc.call<{
            trajectorySummaries?: Record<string, {
              status?: string;
              numTotalSteps?: number;
              stepCount?: number;
              workspaces?: { workspaceFolderAbsoluteUri?: string }[];
            }>;
          }>("GetAllCascadeTrajectories", {}, inst);

          const summaries = data.trajectorySummaries;
          if (!summaries) return;

          for (const [convId, summary] of Object.entries(summaries)) {
            const rawWsUri = summary.workspaces?.[0]?.workspaceFolderAbsoluteUri ?? "";
            candidates.push({
              convId,
              status: summary.status ?? "",
              steps: summary.numTotalSteps ?? summary.stepCount ?? 0,
              wsUri: rawWsUri,
              wsId: rawWsUri ? uriToWorkspaceId(rawWsUri) : inst.workspaceId ?? "",
              inst,
            });
          }
        } catch {
          // LS unreachable
        }
      }),
    );

    if (candidates.length === 0) return null;

    // Step 4: Filter candidates to only those whose workspace matches the target
    // e.g. for cascade "vibee", only keep conversations with wsUri containing "/workspace/vibee"
    const wsFiltered = candidates.filter((c) => {
      if (!c.wsUri) return false;
      const normalUri = c.wsUri.replace("file:///", "").toLowerCase();
      return targetWsPatterns.some((pattern) => normalUri === pattern || normalUri.endsWith("/" + pattern.split("/").pop()));
    });

    const finalCandidates = wsFiltered.length > 0 ? wsFiltered : candidates;

    if (wsFiltered.length === 0) {
      console.log(
        `[cascadeMap] enrich(${cascadeId.slice(0, 8)}) wsName="${wsName}" — no workspace-filtered match, ` +
        `${candidates.length} total candidates, target patterns: ${targetWsPatterns.join(", ")}`,
      );
    }

    // Step 5: Pick best candidate (RUNNING > most steps)
    finalCandidates.sort((a, b) => {
      const aRun = a.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0;
      const bRun = b.status === "CASCADE_RUN_STATUS_RUNNING" ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return b.steps - a.steps;
    });

    const best = finalCandidates[0];
    const normalWsId = normalizeWorkspaceId(best.wsId);

    const mapping: CascadeMapping = {
      cascadeId,
      conversationId: best.convId,
      workspaceId: normalWsId,
      workspaceUri: best.wsUri || best.inst.workspaceId || "",
      lastSeen: Date.now(),
    };

    this.set(mapping);
    console.log(
      `[cascadeMap] ${cascadeId.slice(0, 8)} → ${best.convId.slice(0, 12)}… (ws: ${normalWsId})`,
    );

    return mapping;
  }
}

export const cascadeMap = new CascadeMap();
