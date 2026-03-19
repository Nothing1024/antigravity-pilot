import type { TitleSource } from "@ag/shared";

// 来源：legacy server.js (已删除) GENERIC_CHAT_TITLES
export const GENERIC_CHAT_TITLES = new Set<string>([
  "explore",
  "explorer",
  "agent",
  "chat",
  "new chat",
  "new conversation",
  "conversation",
  "home",
  "settings",
  "search",
  "source control",
  "run and debug",
  "extensions",
  "terminal"
]);

// 来源：legacy server.js (已删除) normalizeTitle()
export function normalizeTitle(title: unknown): string {
  return String(title || "").replace(/\s+/g, " ").trim();
}

// 来源：legacy server.js (已删除) isGenericChatTitle()
export function isGenericChatTitle(title: unknown): boolean {
  const normalized = normalizeTitle(title).toLowerCase();
  return !normalized || GENERIC_CHAT_TITLES.has(normalized);
}

// 来源：legacy server.js (已删除) deriveTitleFromWindow()
export function deriveTitleFromWindow(windowTitle: unknown): string {
  const normalized = normalizeTitle(windowTitle);
  if (!normalized) return "";

  const parts = normalized
    .split(/[—-]/)
    .map((p) => normalizeTitle(p))
    .filter(Boolean);

  if (parts.length === 0) return "";

  for (const part of parts) {
    if (!isGenericChatTitle(part)) return part;
  }
  return parts[0] || "";
}

export type ResolveChatTitleArgs = {
  extractedTitle: unknown;
  previousTitle: unknown;
  windowTitle: unknown;
  cascadeId: unknown;
};

export type ResolvedChatTitle = {
  title: string;
  source: TitleSource;
};

// 来源：legacy server.js (已删除) resolveChatTitle()
export function resolveChatTitle(args: ResolveChatTitleArgs): ResolvedChatTitle {
  const extracted = normalizeTitle(args.extractedTitle);
  const previous = normalizeTitle(args.previousTitle);
  const windowFallback = deriveTitleFromWindow(args.windowTitle);

  if (extracted && !isGenericChatTitle(extracted)) {
    return { title: extracted, source: "extracted" };
  }
  if (previous && !isGenericChatTitle(previous)) {
    return { title: previous, source: "previous" };
  }
  if (windowFallback && !isGenericChatTitle(windowFallback)) {
    return { title: windowFallback, source: "window" };
  }
  if (previous) {
    return { title: previous, source: "previous-generic" };
  }
  if (windowFallback) {
    return { title: windowFallback, source: "window-generic" };
  }

  const suffix = String(args.cascadeId || "").slice(-4) || "N/A";
  return { title: `Session ${suffix}`, source: "fallback-session" };
}

export type CascadeEntryLike = {
  id: string;
  metadata?: {
    chatTitle?: unknown;
    isActive?: unknown;
  };
};

// 来源：legacy server.js (已删除) cascadeListSignature()
export function cascadeListSignature(
  cascadeMap: Map<string, CascadeEntryLike>
): string {
  const list = Array.from(cascadeMap.values())
    .map((c) => ({
      id: c.id,
      title: normalizeTitle(c.metadata?.chatTitle),
      active: !!c.metadata?.isActive
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify(list);
}

