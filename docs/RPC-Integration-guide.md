# RPC 层集成执行指南

## 全局地图

### 一句话概括
将 antigravity-pilot 从"CDP DOM 抓取"架构升级为"RPC + CDP 混合"架构，用结构化 API 替代脆弱的 HTML 解析，降低 80% 带宽、提升 20x 响应速度、支持多工作区。

### Phase 依赖链
```
Phase 0: 准备工作（创建目录、类型定义）
    ↓
Phase 1: RPC 基础设施（LS 发现、RPC 客户端、工作区路由）
    ↓
Phase 2: 消息发送迁移（RPC 优先 + CDP 降级）
    ↓
Phase 3: 状态检测迁移（混合模式）
    ↓
Phase 4: WebSocket Delta Polling（核心轮询逻辑）
    ↓
Phase 5: 前端适配（解析 TrajectoryStep）
    ↓
Phase 6: OpenAI API 优化（可选）
    ↓
Phase 7: 清理与配置化
    ↓
最终验收
```

### 每个 Phase 一句话说明

| Phase | 做什么 | 为什么要先做它 | 完成后的状态 |
|-------|--------|---------------|-------------|
| P0 | 创建 rpc/ 目录，定义 LSInstance 和 TrajectoryStep 类型 | 后续模块需要这些基础结构 | 有了目录和类型，可以开始实现具体模块 |
| P1 | 实现 LS 发现、RPC 客户端、工作区路由 | 必须先能发现 LS 并建立连接 | 可以发现 LS 并调用任意 RPC 方法 |
| P2 | 消息发送改用 RPC，CDP 作降级 | 消息发送是最高频操作，优先迁移收益最大 | 消息发送走 RPC，延迟降低到 <100ms |
| P3 | 状态检测用 RPC status，CDP 作补充 | 状态检测决定 UI 显示，RPC 更可靠 | 状态检测混合模式，可靠性提升 |
| P4 | 实现 50ms delta polling，替代 1s 快照 | 这是最大性能瓶颈，完成后带宽降低 80% | WebSocket 推送 JSON 步骤，延迟降低 20x |
| P5 | 前端解析 TrajectoryStep，兼容旧格式 | 后端数据格式变了，前端必须适配 | 前端同时支持新旧格式，UI 正常显示 |
| P6 | OpenAI API 底层切换到 RPC | 提升外部集成性能 | API 性能提升 50% |
| P7 | 删除冗余代码，添加配置开关 | 让架构更清晰、更易维护 | 代码精简，配置灵活 |

### 最重要的规则
**每个 Phase 完成后必须通过回归验证并 commit，才能进入下一个 Phase。**

---

## Phase 0: 准备工作

> 🗺️ **你在哪里**：当前代码库完全基于 CDP，无 RPC 相关代码
>
> **做完之后的状态**：有了 `rpc/` 目录和基础类型，可以开始实现具体模块

**本 Phase 的任务**：#1 ~ #5

**⚠️ 本 Phase 注意事项**：
- **类型定义要完整**：LSInstance 必须包含 `pid, httpsPort, httpPort, lspPort, csrfToken, workspaceId?, source` 所有字段
- **禁止操作**：不要修改现有文件，只新增
- **测试失败的常见原因**：忘记在 `packages/shared/src/index.ts` 导出新类型

---

## Phase 1: RPC 基础设施

> 🗺️ **你在哪里**：Phase 0 完成，有了目录和类型定义，但还没有任何实际功能
>
> **做完之后的状态**：可以发现运行中的 LS，调用任意 RPC 方法，自动路由到正确工作区

**本 Phase 的任务**：#6 ~ #15

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：porta 使用 `.js` 后缀（ESM），本项目不需要，必须全部移除
- **禁止操作**：不要修改 porta 原文件，只复制到本项目后修改
- **隐藏依赖**：`discovery.ts` 依赖 `platform/` 目录，必须一起复制
- **测试失败的常见原因**：
  - 忘记启动 AG 实例（集成测试需要）
  - daemon 文件不存在（`~/.gemini/antigravity/daemon/` 目录为空）
  - CSRF token 过期（重启 AG 会生成新 token）

---

## Phase 2: 消息发送迁移

> 🗺️ **你在哪里**：Phase 1 完成，可以发现 LS 并调用 RPC，但业务逻辑还在用 CDP
>
> **做完之后的状态**：用户发送消息走 RPC，CDP 仅作降级，延迟从 500ms 降到 <100ms

**本 Phase 的任务**：#16 ~ #21

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：`SendUserCascadeMessage` 的 body 格式必须是 `{ cascadeId, userMessage: { parts: [{ text }] } }`，不是直接传字符串
- **禁止操作**：不要删除 `cdp/inject.ts`，降级需要用
- **隐藏依赖**：必须先调用 `rpcForConversation` 获取正确的 LS 实例，不能用 `rpc.call()` 直接调用
- **测试失败的常见原因**：
  - 忘记传 `cascadeId` 参数
  - `userMessage.parts` 格式错误
  - 没有等待 RPC 调用完成就返回

---

## Phase 3: 状态检测迁移

> 🗺️ **你在哪里**：Phase 2 完成，消息发送已用 RPC，但状态检测还在用 DOM 启发式
>
> **做完之后的状态**：状态检测混合模式（RPC 粗粒度 + CDP 细粒度），可靠性提升

**本 Phase 的任务**：#22 ~ #27

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：`GetCascadeTrajectory` 需要传 `{ cascadeId }` 参数，不是空对象
- **禁止操作**：不要删除 DOM 检测逻辑（L50-120），混合模式需要保留
- **隐藏依赖**：RPC 状态是粗粒度的（IDLE/RUNNING/ERROR），细粒度状态（THINKING/APPROVAL_PENDING）仍需 CDP
- **测试失败的常见原因**：
  - 状态映射错误（如 RUNNING 映射到 IDLE）
  - 没有处理 RPC 超时（应该回退到 CDP）
  - 状态更新频率过高（应该缓存 RPC 结果）

---

## Phase 4: WebSocket Delta Polling

> 🗺️ **你在哪里**：Phase 3 完成，消息发送和状态检测已用 RPC，但步骤数据还在用 1s HTML 快照
>
> **做完之后的状态**：WebSocket 推送结构化 JSON 步骤（2-10KB），50ms 轮询，前端渲染 TrajectoryStep[]

**本 Phase 的任务**：#28 ~ #36

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：重叠窗口计算错误，`fetchOffset` 必须是 `Math.max(minFetchOffset, lastStepCount - 20)`，不能小于 `minFetchOffset`
- **禁止操作**：不要删除 `loop/snapshot.ts`，UI 镜像功能还需要（Phase 7 才可选化）
- **隐藏依赖**：
  - `conversationSignals` 必须在 REST 和 WS 之间共享（单例）
  - `minFetchOffset` 用于跳过损坏步骤，初始值 0，遇到错误后递增
- **测试失败的常见原因**：
  - 忘记调用 `conversationSignals.emit("activate")` 导致一直 IDLE
  - 重叠窗口过大（>50）导致性能问题
  - 没有处理步骤损坏错误（4MB 超限、UTF-8 无效）

---

## Phase 5: 前端适配

> 🗺️ **你在哪里**：Phase 4 完成，后端已推送 `steps` 消息，但前端还在解析 `snapshot_update`
>
> **做完之后的状态**：前端同时支持旧 `snapshot_update` 和新 `steps` 消息，可以渲染 TrajectoryStep[]

**本 Phase 的任务**：#37 ~ #42

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：步骤合并时，`offset=10, steps=[a,b,c]` 表示索引 10-12，不是 10-13
- **禁止操作**：不要删除 Shadow DOM 渲染逻辑，兼容性需要
- **测试失败的常见原因**：
  - 步骤顺序错误（没有按 offset 排序）
  - 重叠步骤没有替换（应该用新数据覆盖旧数据）

---

## Phase 6: OpenAI API 优化（可选）

> 🗺️ **你在哪里**：Phase 5 完成，核心功能已迁移到 RPC，但 OpenAI API 还在用 CDP 提取响应
>
> **做完之后的状态**：`/v1/chat/completions` 底层用 RPC，延迟降低 50%

**本 Phase 的任务**：#43 ~ #47

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：`PLANNER_RESPONSE` 步骤可能有多个，需要按顺序拼接 `content.text`
- **禁止操作**：不要删除 CDP 降级逻辑
- **测试失败的常见原因**：流式响应没有正确处理增量（应该只发送新增文本）

---

## Phase 7: 清理与配置化

> 🗺️ **你在哪里**：Phase 6 完成，所有功能已迁移，但代码还有冗余
>
> **做完之后的状态**：代码精简，配置灵活，可以通过 `config.json` 控制 RPC/CDP 模式

**本 Phase 的任务**：#48 ~ #54

**⚠️ 本 Phase 注意事项**：
- **最容易出错的点**：删除 `discovery.ts` 后，确保没有其他文件 import 它
- **禁止操作**：不要删除 `cdp/` 目录，降级需要
- **测试失败的常见原因**：配置项拼写错误导致不生效

---

## 常见问题

### Q1: 为什么要保留 CDP，不能完全用 RPC 吗？
A: CDP 有两个不可替代的功能：(1) UI 镜像（Shadow DOM 渲染），RPC 无法提供完整 UI 视图；(2) 降级回退，RPC 不可达时保证基本功能。

### Q2: 什么时候用 `rpc.call()` vs `rpcForConversation()`？
A: `rpc.call()` 用于无对话上下文的调用（如 `GetWorkspaceInfos`）；`rpcForConversation()` 用于对话相关调用，会自动路由到正确的 LS。

### Q3: 为什么写操作禁止 try-all？
A: 多个 LS 可能加载同一个磁盘 `.pb` 文件，try-all 会导致写入错误的 LS，造成数据不一致。

### Q4: 重叠窗口为什么是 20？
A: 经验值，覆盖大部分并发工具调用场景（<10 个），同时不会造成太大性能开销。可通过配置调整。

### Q5: 步骤损坏是什么情况？
A: LS 返回的步骤数据可能超过 4MB protobuf 限制，或包含无效 UTF-8。遇到时注入占位步骤，跳过损坏数据。

### Q6: 为什么 ACTIVE 模式要等 5s 才能去激活？
A: LS 在收到用户操作后可能短暂报告 IDLE 状态，5s 保护期防止过早去激活。

### Q7: 前端如何知道用哪种格式渲染？
A: 根据收到的 WebSocket 消息类型：`snapshot_update` → Shadow DOM，`steps` → TrajectoryStep 列表。

### Q8: 如何调试 RPC 调用失败？
A: 检查日志中的 RPC 错误码（`unauthenticated`, `unavailable`, `unknown`），对应不同的失败原因。
