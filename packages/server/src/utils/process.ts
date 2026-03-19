import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// 来源：legacy server.js (已删除) checkProcessRunning()
export function checkProcessRunning(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd =
      process.platform === "darwin"
        ? `pgrep -f "${name}.app/" || pgrep -x "${name}"`
        : `tasklist /FI "IMAGENAME eq ${name}.exe" /NH`;

    exec(cmd, (err, stdout) => {
      if (err) return resolve(false);
      if (process.platform === "win32") {
        return resolve(stdout.toLowerCase().includes(name.toLowerCase()));
      }
      return resolve(stdout.trim().length > 0);
    });
  });
}

// 来源：legacy server.js (已删除) getDefaultAntigravityPath()
export function getDefaultAntigravityPath(): string {
  if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Antigravity.app/Contents/MacOS/Antigravity",
      join(
        process.env.HOME || "",
        "Applications",
        "Antigravity.app",
        "Contents",
        "MacOS",
        "Antigravity"
      )
    ];
    return candidates.find((p) => existsSync(p)) || candidates[0];
  }
  return join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "Antigravity",
    "Antigravity.exe"
  );
}
