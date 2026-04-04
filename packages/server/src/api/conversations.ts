import express from "express";

import { RPCError } from "../rpc/client";
import { runConversationMutation } from "../rpc/conversation-mutations";
import type { LSInstance } from "../rpc/discovery";
import { getMetadata, scanDiskConversations } from "../rpc/metadata";
import {
  conversationAffinity,
  conversationInstanceHints,
  discovery,
  getStepCount,
  normalizeWorkspaceId,
  rpc,
  rpcForConversation,
  uriToWorkspaceId,
} from "../rpc/routing";
import { conversationSignals } from "../rpc/signals";
import { messageTracker } from "../rpc/message-tracker";
import {
  MAX_SKIP,
  findNextValidOffset,
  isRecoverableStepError,
  oversizedStepOffset,
  placeholderStep,
} from "../rpc/step-recovery";

export const conversationsRouter: express.Router = express.Router();
export const router: express.Router = conversationsRouter;
export default router;

type WorkspaceRef = {
  workspaceFolderAbsoluteUri?: string;
};

type TrajectorySummary = Record<string, unknown> & {
  stepCount?: number;
  numTotalSteps?: number;
  status?: string;
  workspaces?: WorkspaceRef[];
};

type WorkspaceInfosResponse = {
  workspaceInfos?: {
    workspaceUri?: string;
  }[];
};

const warmedAt = new Map<string, number>();
const WARM_TTL_MS = 60_000;

function sendRpcError(res: express.Response, err: unknown): express.Response {
  if (err instanceof RPCError) {
    const status =
      err.code === "unauthenticated"
        ? 401
        : err.code === "permission_denied"
          ? 403
          : err.code === "not_found"
            ? 404
            : err.code === "unavailable"
              ? 503
              : 502;
    return res.status(status).json({ error: err.message, code: err.code });
  }

  const message = err instanceof Error ? err.message : String(err);
  return res.status(500).json({ error: message });
}

function getQueryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function warmUpDiskConversations(ids: string[], instances: LSInstance[]): void {
  const now = Date.now();
  const pending = ids.filter((id) => {
    const ts = warmedAt.get(id);
    return !ts || now - ts > WARM_TTL_MS;
  });
  if (pending.length === 0) return;

  for (const id of pending) warmedAt.set(id, now);

  console.log(
    `[warm-up] loading ${pending.length} disk-only conversation(s) across ${instances.length} LS(es)`,
  );

  const CONCURRENCY = 10;

  void (async () => {
    let loaded = 0;
    let failed = 0;

    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const batch = pending.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (cascadeId) => {
          for (const inst of instances) {
            try {
              await rpc.call(
                "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: 999999 },
                inst,
              );
              loaded += 1;
              return;
            } catch {
              // Try next LS instance.
            }
          }
          warmedAt.delete(cascadeId);
          failed += 1;
        }),
      );
    }

    if (failed > 0) {
      console.log(
        `[warm-up] done: ${loaded} loaded, ${failed} failed (no LS could load them)`,
      );
      return;
    }

    console.log(`[warm-up] done: ${loaded} loaded`);
  })();
}

conversationsRouter.get("/api/conversations", async (_req, res) => {
  try {
    const instances = await discovery.getInstances();
    const merged: Record<string, TrajectorySummary> = {};

    const knownWorkspaceIds = new Set(
      instances
        .map((inst) => inst.workspaceId)
        .filter((id): id is string => Boolean(id))
        .map((id) => normalizeWorkspaceId(id)),
    );

    await Promise.allSettled(
      instances.map(async (inst) => {
        try {
          const data = await rpc.call<{
            trajectorySummaries?: Record<string, TrajectorySummary>;
          }>("GetAllCascadeTrajectories", {}, inst);
          const summaries = data.trajectorySummaries ?? {};

          for (const [id, summary] of Object.entries(summaries)) {
            const wsUri = summary.workspaces?.[0]?.workspaceFolderAbsoluteUri;
            if (
              wsUri &&
              !knownWorkspaceIds.has(normalizeWorkspaceId(uriToWorkspaceId(wsUri)))
            ) {
              continue;
            }

            const existing = merged[id];
            const nextCount = summary.stepCount ?? summary.numTotalSteps ?? 0;
            const currentCount =
              existing?.stepCount ?? existing?.numTotalSteps ?? -1;
            if (!existing || nextCount > currentCount) {
              merged[id] = summary;
            }
          }
        } catch {
          // Skip unreachable instances.
        }
      }),
    );

    for (const [id, summary] of Object.entries(merged)) {
      const wsUri = summary.workspaces?.[0]?.workspaceFolderAbsoluteUri;
      if (wsUri) {
        conversationAffinity.set(id, uriToWorkspaceId(wsUri));
      }
    }

    const diskConversations = await scanDiskConversations();
    const diskOnlyIds: string[] = [];

    for (const diskConversation of diskConversations) {
      if (merged[diskConversation.id]) continue;

      let injectedWorkspaces: WorkspaceRef[] = [];
      const wsId = conversationAffinity.get(diskConversation.id);
      if (wsId && wsId.startsWith("file_")) {
        const uri = wsId.replace(/^file_/, "file:///").replace(/_/g, "/");
        injectedWorkspaces = [{ workspaceFolderAbsoluteUri: uri }];
      }

      diskOnlyIds.push(diskConversation.id);
      merged[diskConversation.id] = {
        summary: `${diskConversation.id.slice(0, 8)}…`,
        stepCount: 0,
        status: "CASCADE_RUN_STATUS_UNLOADED",
        lastModifiedTime: diskConversation.mtime,
        createdTime: diskConversation.mtime,
        trajectoryId: "",
        workspaces: injectedWorkspaces,
        _diskOnly: true,
      };
    }

    if (diskOnlyIds.length > 0 && instances.length > 0) {
      warmUpDiskConversations(diskOnlyIds, instances);
    }

    res.json({ trajectorySummaries: merged });
  } catch (err) {
    return sendRpcError(res, err);
  }
});

conversationsRouter.get("/api/conversations/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const data = await rpcForConversation(
      "GetCascadeTrajectory",
      id,
      { cascadeId: id },
      undefined,
      true,
    );
    res.json(data);
  } catch (err) {
    return sendRpcError(res, err);
  }
});

conversationsRouter.get("/api/conversations/:id/steps", async (req, res) => {
  const id = req.params.id;
  const offset = parseNonNegativeInt(getQueryString(req.query.offset), 0);
  const limit = getQueryString(req.query.limit);
  const tail = getQueryString(req.query.tail);

  try {
    let resolvedOffset = offset;
    let stepCount: number | undefined;
    let pinnedInstance: LSInstance | undefined;
    let stepsArray: unknown[] = [];

    if (tail) {
      const sc = await getStepCount(id, undefined, true);
      pinnedInstance = sc.instance;
      if (sc.count > 0) {
        stepCount = sc.count;
        const tailSize = parseNonNegativeInt(tail, 0);
        resolvedOffset = Math.max(0, stepCount - tailSize);
      }
    }

    let currentOffset = resolvedOffset;
    const parsedLimit = limit ? parseNonNegativeInt(limit, 0) : undefined;
    const targetCount =
      parsedLimit ?? (stepCount ? stepCount - resolvedOffset : 100);
    let consecutiveSkips = 0;

    while (stepsArray.length < targetCount) {
      try {
        const data = await rpcForConversation<{ steps?: unknown[] }>(
          "GetCascadeTrajectorySteps",
          id,
          { cascadeId: id, stepOffset: currentOffset },
          pinnedInstance,
          true,
        );

        const chunk = data.steps ?? [];
        if (chunk.length === 0) break;

        stepsArray.push(...chunk);
        currentOffset += chunk.length;
        consecutiveSkips = 0;
      } catch (fetchErr) {
        const badOffset = oversizedStepOffset(fetchErr);
        if (badOffset >= 0) {
          const skipCount = badOffset - currentOffset + 1;
          for (let index = 0; index < skipCount; index += 1) {
            stepsArray.push(
              placeholderStep("Language Server: step exceeds 4MB protobuf limit"),
            );
          }
          currentOffset = badOffset + 1;
          consecutiveSkips += skipCount;
          if (consecutiveSkips >= MAX_SKIP) break;
          continue;
        }

        if (isRecoverableStepError(fetchErr)) {
          if (stepCount === undefined) {
            const sc = await getStepCount(id, undefined, true);
            stepCount = sc.count;
            pinnedInstance ??= sc.instance;
          }
          const nextValid = await findNextValidOffset(
            id,
            currentOffset + 1,
            stepCount ?? currentOffset + MAX_SKIP,
            pinnedInstance,
          );
          const skipCount = nextValid - currentOffset;
          for (let index = 0; index < skipCount; index += 1) {
            stepsArray.push(
              placeholderStep("Language Server: invalid UTF-8 in step data"),
            );
          }
          console.log(
            `Skipping corrupted range [${currentOffset}, ${nextValid - 1}] (${skipCount} steps)`,
          );
          currentOffset = nextValid;
          consecutiveSkips += skipCount;
          if (consecutiveSkips >= MAX_SKIP) break;
          continue;
        }

        throw fetchErr;
      }
    }

    if (stepsArray.length > targetCount) {
      stepsArray = stepsArray.slice(0, targetCount);
    }

    res.json({
      steps: stepsArray,
      offset: resolvedOffset,
      ...(stepCount !== undefined ? { stepCount } : {}),
    });
  } catch (err) {
    return sendRpcError(res, err);
  }
});

conversationsRouter.post("/api/conversations", async (req, res) => {
  try {
    const body = asRecord(req.body);
    const metadata = await getMetadata(Boolean(body.fileAccessGranted));

    let workspaceUri =
      typeof body.workspaceFolderAbsoluteUri === "string"
        ? body.workspaceFolderAbsoluteUri
        : undefined;

    let targetInstance: LSInstance | undefined;
    if (workspaceUri) {
      const workspaceId = normalizeWorkspaceId(uriToWorkspaceId(workspaceUri));
      const instances = await discovery.getInstances();
      targetInstance =
        instances.find(
          (inst) =>
            inst.workspaceId &&
            normalizeWorkspaceId(inst.workspaceId) === workspaceId,
        ) ?? undefined;

      if (!targetInstance) {
        return res.status(503).json({
          error:
            "No Language Server found for this workspace. Open the project in Antigravity first.",
          detail: workspaceUri,
        });
      }
    } else {
      targetInstance = (await discovery.getInstance()) ?? undefined;
      try {
        const workspaceInfos = await rpc.call<WorkspaceInfosResponse>(
          "GetWorkspaceInfos",
          {},
          targetInstance,
        );
        workspaceUri = workspaceInfos.workspaceInfos?.[0]?.workspaceUri;
      } catch {
        // Best effort only.
      }
    }

    const data = await rpc.call<Record<string, unknown>>(
      "StartCascade",
      {
        ...body,
        metadata,
        ...(workspaceUri ? { workspaceFolderAbsoluteUri: workspaceUri } : {}),
      },
      targetInstance,
    );

    const newId =
      typeof data.cascadeId === "string" ? data.cascadeId : undefined;
    const learnedWorkspaceId =
      targetInstance?.workspaceId ??
      (workspaceUri ? uriToWorkspaceId(workspaceUri) : undefined);
    if (newId && learnedWorkspaceId) {
      conversationAffinity.set(newId, learnedWorkspaceId);
    }
    if (newId && targetInstance) {
      conversationInstanceHints.set(newId, targetInstance);
    }
    if (newId) {
      conversationSignals.emit("activate", newId);
    }

    res.status(201).json(data);
  } catch (err) {
    return sendRpcError(res, err);
  }
});

conversationsRouter.post("/api/conversations/:id/messages", async (req, res) => {
  const id = req.params.id;
  try {
    return await runConversationMutation(id, async () => {
      const body = asRecord(req.body);
      const metadata = await getMetadata(Boolean(body.fileAccessGranted));
      const clientMessageId =
        typeof body.clientMessageId === "string" ? body.clientMessageId : undefined;
      const { count: preSendStepCount, instance } = await getStepCount(id);

      const rpcRequest: Record<string, unknown> = {
        metadata,
        cascadeId: id,
        userMessage: {
          parts: Array.isArray(body.items) ? body.items : [],
        },
      };

      if (Array.isArray(body.media) && body.media.length > 0) {
        rpcRequest.media = body.media;
      }

      const plannerType = body.plannerType;
      const plannerTypeConfig =
        plannerType === "planning" ? { planning: {} } : { conversational: {} };

      if (typeof body.model === "string" || plannerType !== undefined) {
        rpcRequest.cascadeConfig = {
          plannerConfig: {
            plannerTypeConfig,
            ...(typeof body.model === "string"
              ? { requestedModel: { model: body.model } }
              : {}),
          },
        };
      }

      const data = await rpcForConversation(
        "SendUserCascadeMessage",
        id,
        rpcRequest,
        instance,
      );
      if (clientMessageId && clientMessageId.length > 0) {
        messageTracker.trackPendingMessage(id, clientMessageId, preSendStepCount);
      }
      conversationSignals.emit("activate", id);
      return res.json(data);
    });
  } catch (err) {
    return sendRpcError(res, err);
  }
});

conversationsRouter.post("/api/conversations/:id/stop", async (req, res) => {
  const id = req.params.id;
  try {
    const data = await rpcForConversation("CancelCascadeInvocation", id, {
      cascadeId: id,
    });
    res.json(data);
  } catch (err) {
    return sendRpcError(res, err);
  }
});
