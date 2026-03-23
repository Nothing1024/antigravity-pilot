export interface LSInstance {
  pid: number;
  httpsPort: number;
  httpPort: number;
  lspPort: number;
  csrfToken: string;
  workspaceId?: string;
  /** Derived from discovery source */
  source: "daemon" | "process";
}
