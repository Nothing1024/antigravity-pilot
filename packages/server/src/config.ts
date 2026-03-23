import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

import type { AutoActionSettings } from "@ag/shared";
import { DEFAULT_CDP_PORTS, DEFAULT_PORT } from "@ag/shared";
import { autoActionSettings } from "./autoaction/index";
import { getDefaultAntigravityPath } from "./utils/process";

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
};

export type UserConfigFile = {
  password?: string;
  port?: number;
  antigravityPath?: string;
  cdpPorts?: number[];
  managerUrl?: string;
  managerPassword?: string;
  vapidKeys?: VapidKeys;
  vapidSubject?: string;
  authSecret?: string;
  autoActions?: Partial<AutoActionSettings>;

  // F1: Connection Pool
  connectionPool?: Partial<ConnectionPoolConfig>;

  // F4/F5: API Service
  apiKeys?: Array<{ key: string; name: string }>;
  api?: Partial<ApiConfig>;

  // F6: Webhooks
  webhooks?: WebhookConfigEntry[];
};

export type ConnectionPoolConfig = {
  maxConnections: number;
  healthCheckInterval: number;
  healthCheckTimeout: number;
  reconnectDelay: number;
  reconnectMaxDelay: number;
  reconnectMaxAttempts: number;
};

export type RateLimitConfig = {
  global: number;          // req/min for all endpoints
  completions: number;     // req/min for /v1/chat/completions
};

export type ApiConfig = {
  enabled: boolean;
  openaiCompat: boolean;
  rateLimit: RateLimitConfig;
};

export type WebhookConfigEntry = {
  url: string;
  secret?: string;
  name: string;
  events?: string[];
  enabled?: boolean;
};

export type AppConfig = {
  configPath: string;
  pushSubsPath: string;

  password: string;
  port: number;
  cdpPorts: number[];
  antigravityPath: string | null;

  managerUrl: string;
  managerPassword: string;

  vapidKeys: VapidKeys;
  vapidSubject: string;

  authSecret: string;

  autoActions: AutoActionSettings;

  // F1: Connection Pool
  connectionPool: ConnectionPoolConfig;

  // F4/F5: API Service
  apiKeys: Array<{ key: string; name: string }>;
  api: ApiConfig;

  // F6: Webhooks
  webhooks: WebhookConfigEntry[];
};

function getRepoRootPathFromHere(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../");
}

function readUserConfig(configPath: string): UserConfigFile {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw) as UserConfigFile;
  } catch {
    return {};
  }
}

function tryPersistUserConfig(configPath: string, userConfig: UserConfigFile): void {
  try {
    writeFileSync(configPath, JSON.stringify(userConfig, null, 2));
  } catch {
    // Best-effort only.
  }
}

function ensureAuthSecret(
  configPath: string,
  userConfig: UserConfigFile,
  envSecret: string | undefined
): string {
  if (userConfig.authSecret) return userConfig.authSecret;
  if (envSecret) return envSecret;

  const secret = randomBytes(32).toString("hex");
  userConfig.authSecret = secret;
  tryPersistUserConfig(configPath, userConfig);
  return secret;
}

function ensureVapidKeys(configPath: string, userConfig: UserConfigFile): VapidKeys {
  if (userConfig.vapidKeys?.publicKey && userConfig.vapidKeys?.privateKey) {
    return userConfig.vapidKeys;
  }

  const keys = webpush.generateVAPIDKeys();
  userConfig.vapidKeys = keys;
  tryPersistUserConfig(configPath, userConfig);
  return keys;
}

export function loadConfig(): AppConfig {
  const repoRoot = getRepoRootPathFromHere();

  // 注意：这里必须定位到仓库根的 config.json；不要从 packages/server/src 旁边读。
  const configPath = path.resolve(repoRoot, "config.json");
  const pushSubsPath = path.resolve(repoRoot, ".push-subscriptions.json");

  const userConfig = readUserConfig(configPath);

  const password = userConfig.password || process.env.PASSWORD || "monitor";

  const portRaw = userConfig.port ?? process.env.PORT ?? DEFAULT_PORT;
  const port = Number(portRaw) || DEFAULT_PORT;

  const cdpPorts = Array.isArray(userConfig.cdpPorts)
    ? userConfig.cdpPorts
    : Array.from(DEFAULT_CDP_PORTS);

  const antigravityPath =
    userConfig.antigravityPath ||
    process.env.ANTIGRAVITY_PATH ||
    getDefaultAntigravityPath();

  const managerUrl =
    userConfig.managerUrl || process.env.MANAGER_URL || "http://127.0.0.1:8045";
  const managerPassword =
    userConfig.managerPassword || process.env.MANAGER_PASSWORD || "";

  const authSecret = ensureAuthSecret(configPath, userConfig, process.env.AUTH_SECRET);

  const vapidKeys = ensureVapidKeys(configPath, userConfig);
  const vapidSubject =
    userConfig.vapidSubject ||
    process.env.VAPID_SUBJECT ||
    "mailto:noreply@example.com";

  const autoActions: AutoActionSettings = {
    autoAcceptAll: userConfig.autoActions?.autoAcceptAll ?? false,
    autoRetry: userConfig.autoActions?.autoRetry ?? false,
    retryBackoff: userConfig.autoActions?.retryBackoff ?? true,
  };

  const connectionPool: ConnectionPoolConfig = {
    maxConnections: userConfig.connectionPool?.maxConnections ?? 8,
    healthCheckInterval: userConfig.connectionPool?.healthCheckInterval ?? 30_000,
    healthCheckTimeout: userConfig.connectionPool?.healthCheckTimeout ?? 5_000,
    reconnectDelay: userConfig.connectionPool?.reconnectDelay ?? 1_000,
    reconnectMaxDelay: userConfig.connectionPool?.reconnectMaxDelay ?? 60_000,
    reconnectMaxAttempts: userConfig.connectionPool?.reconnectMaxAttempts ?? 0,
  };

  const apiKeys = userConfig.apiKeys || [];

  const api: ApiConfig = {
    enabled: userConfig.api?.enabled ?? true,
    openaiCompat: userConfig.api?.openaiCompat ?? true,
    rateLimit: {
      global: userConfig.api?.rateLimit?.global ?? 120,
      completions: userConfig.api?.rateLimit?.completions ?? 10,
    },
  };

  const webhooks = userConfig.webhooks || [];

  webpush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);

  return {
    configPath,
    pushSubsPath,
    password,
    port,
    cdpPorts,
    antigravityPath,
    managerUrl,
    managerPassword,
    vapidKeys,
    vapidSubject,
    authSecret,
    autoActions,
    connectionPool,
    apiKeys,
    api,
    webhooks,
  };
}

export const config = loadConfig();

// Initialize runtime auto-action settings from config
autoActionSettings.autoAcceptAll = config.autoActions.autoAcceptAll;
autoActionSettings.autoRetry = config.autoActions.autoRetry;
autoActionSettings.retryBackoff = config.autoActions.retryBackoff;
