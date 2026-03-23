import { darwinAdapter } from "./darwin.js";
import { linuxAdapter } from "./linux.js";
import type { PlatformAdapter } from "./types.js";
import { win32Adapter } from "./win32.js";

export function getPlatformAdapter(
  platform: NodeJS.Platform = process.platform,
): PlatformAdapter {
  switch (platform) {
    case "darwin":
      return darwinAdapter;
    case "linux":
      return linuxAdapter;
    case "win32":
      return win32Adapter;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export const platformAdapter = getPlatformAdapter();
