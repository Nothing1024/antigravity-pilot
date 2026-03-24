/**
 * WorkspaceId 工具函数（共享给 server/web）。
 *
 * Antigravity 的 Language Server 使用一种特殊的 workspaceId 表示：
 *   file:///tmp/mock_ws  ->  file_tmp_mock_ws
 *
 * 这里的转换与 server 侧 RPC 路由保持一致，避免多处复制实现导致行为漂移。
 */

/** Convert a workspace URI to the LS workspaceId format. */
export function uriToWorkspaceId(uri: string): string {
  return uri.replace(/^file:\/\/\//, "file_").replace(/\//g, "_");
}

/**
 * Normalize a workspace ID to a canonical form for comparison.
 *
 * 两个来源对同一 workspace 可能产生结构不同的 ID：
 * - CLI --workspace_id : file_e_3A_Work_novels  (percent-encoded colon, lowercase drive)
 * - uriToWorkspaceId() : file_E:_Work_novels    (literal colon, original case)
 *
 * 归一化策略：统一小写，并把字面量 `:` 替换为 `_3a`。
 */
export function normalizeWorkspaceId(id: string): string {
  return id.replace(/:/g, "_3a").toLowerCase();
}

