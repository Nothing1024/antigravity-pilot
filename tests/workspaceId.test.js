import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWorkspaceId,
  uriToWorkspaceId,
} from "../packages/shared/dist/utils/workspaceId.js";

test("uriToWorkspaceId: converts file URI to LS workspaceId", () => {
  assert.equal(uriToWorkspaceId("file:///tmp/mock_ws"), "file_tmp_mock_ws");
  assert.equal(
    uriToWorkspaceId("file:///Users/nothing/workspace/antigravity"),
    "file_Users_nothing_workspace_antigravity",
  );
});

test("normalizeWorkspaceId: lowercases and normalizes ':' to _3a", () => {
  assert.equal(normalizeWorkspaceId("file_E:_Work_novels"), "file_e_3a_work_novels");
  assert.equal(normalizeWorkspaceId("file_e_3A_Work_novels"), "file_e_3a_work_novels");
  assert.equal(normalizeWorkspaceId("ABC:DEF"), "abc_3adef");
});

