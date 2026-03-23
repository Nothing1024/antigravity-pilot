# PRD: Antigravity Pilot RPC 层集成

**项目**: antigravity-pilot
**版本**: v4.0.0
**作者**: 架构改进团队
**日期**: 2026-03-23
**状态**: 草案待讨论

---

## 📋 执行摘要

### 核心目标
将 porta 项目的 **Connect RPC 通信能力**整合到 antigravity-pilot，形成 **RPC + CDP 混合架构**，大幅提升可靠性、降低带宽、增强多工作区支持。

### 当前痛点
| 问题 | 影响 | 严重度 |
|------|------|--------|
| CDP DOM 抓取脆弱 | AG 更新后选择器失效 | 🔴 高 |
| 1s 全量 HTML 快照 | 高带宽、低效 | 🟡 中 |
| 启发式状态检测 | 误判、延迟 | 🟡 中 |
| 单工作区假设 | 多 LS 实例无法路由 | 🟡 中 |
| 消息注入不可靠 | contenteditable 注入偶尔失败 | 🟡 中 |

### 解决方案
引入 **Antigravity Language Server 的 Connect RPC API**（`exa.language_server_pb.LanguageServerService`），将核心功能从 CDP 层迁移到 RPC 层：

- ✅ **消息发送** → `SendUserCascadeMessage` RPC（替代 CDP 注入）
- ✅ **状态检测** → 结构化 `status` 字段（替代 DOM 启发式）
- ✅ **步骤获取** → `GetCascadeTrajectorySteps` delta polling（替代 HTML 快照）
- ✅ **对话管理** → `GetAllCascadeTrajectories`、`StartCascade`、`DeleteCascadeTrajectory`
- ✅ **多工作区路由** → 工作区感知的 affinity 缓存
- ⚠️ **CDP 保留** → UI 镜像、可视化渲染、降级回退

### 预期收益
| 维度 | 改进 | 量化指标 |
|------|------|----------|
| 可靠性 | RPC API 变化慢，版本弹性强 | 跨 AG 版本兼容性 >95% |
| 带宽 | JSON delta vs 完整 HTML | 降低 80-90% |
| 响应速度 | 50ms 轮询 vs 1s 快照 | 延迟降低 20x |
| 多工作区 | 自动路由到正确 LS | 支持 N 个并发工作区 |
| 开发效率 | 结构化数据，无需 DOM 解析 | 代码复杂度降低 40% |

---

## 🎯 项目范围

### Phase 1: RPC 基础设施（P0）
**目标**: 建立 LS 发现 + RPC 客户端基础能力

**交付物**:
1. LS 实例发现模块（daemon 文件 + 进程扫描）
2. Connect RPC 客户端（HTTP/HTTPS 双协议，自签名证书支持）
3. 工作区路由与 affinity 缓存
4. 传输层回退（HTTPS → HTTP 自动切换）

**不包含**: 业务逻辑迁移，CDP 层改动

### Phase 2: 核心功能迁移（P1）
**目标**: 消息发送、状态检测、步骤获取走 RPC

**交付物**:
1. 消息发送 API 切换到 `SendUserCascadeMessage`
2. 状态检测使用 `GetCascadeTrajectory.status`
3. WebSocket delta polling（50ms 活跃轮询 + 5s 空闲心跳）
4. 步骤数据结构化（TrajectoryStep 类型）

**不包含**: OpenAI 兼容 API 改造，CDP 完全移除

### Phase 3: API 层优化（P2）
**目标**: OpenAI 兼容 API 底层切换到 RPC

**交付物**:
1. `/v1/chat/completions` 使用 RPC 获取响应文本
2. 流式响应基于 step delta
3. 完成检测使用 `status` 字段

**不包含**: 前端 UI 改造

### Phase 4: 架构整洁化（P3）
**目标**: CDP 降级为可视化层 + 回退机制

**交付物**:
1. CDP 仅用于 Shadow DOM 镜像渲染
2. RPC 不可达时自动降级到 CDP
3. 配置开关控制 RPC/CDP 模式

**不包含**: 完全移除 CDP（保留作为备份）

---

## 📊 当前架构分析

### antigravity-pilot 现状
**代码规模**:
- Server: 37 文件，6,808 行 TypeScript
- Web: 32 文件（.ts + .tsx）
- Shared: 7 文件
- Tests: 159 文件

**核心模块**:
```
packages/server/src/
├── cdp/              # CDP 连接、注入、元数据提取
├── loop/             # 发现循环（10s）、快照循环（1s）
├── capture/          # HTML/CSS 捕获脚本
├── monitor/          # 阶段检测、响应文本提取
├── api/              # REST 端点（9 个路由）
├── autoaction/       # 自动 Accept/Retry
└── ws/               # WebSocket 广播
```

**关键流程**:
1. **发现**: 轮询 CDP 端口 9000-9003 的 `/json/list`
2. **快照**: 每 1s 注入 `captureHTML()` 脚本，hash diff 后广播
3. **消息发送**: 找到 contenteditable → 注入文本 → 模拟点击发送按钮
4. **状态检测**: DOM 启发式（找按钮、spinner、feedback 按钮）
5. **响应提取**: 从 DOM 克隆、过滤 UI 噪音、diff 基线

**痛点**:
- `captureHTML()` 返回完整 HTML（平均 50-200KB）
- 选择器脆弱（AG 更新后 `.chat-input` 可能改名）
- 阶段检测延迟（1s 轮询间隔）
- 无多工作区支持（假设单 IDE 实例）

### porta 参考架构
**代码规模**:
- Proxy: 5,481 行 TypeScript（核心 RPC 实现）
- 关键模块: discovery (419行), rpc (311行), routing (332行), ws (577行)

**核心能力**:
1. **LS 发现**: daemon 文件 (`~/.gemini/antigravity/daemon/ls_*.json`) + 进程扫描
2. **RPC 客户端**: 原生 `node:http/https`，支持自签名证书，双协议回退
3. **工作区路由**: affinity 缓存（cascadeId → workspaceId），多 LS 实例自动路由
4. **Delta polling**: 50ms 活跃轮询 + 5s 空闲心跳，20 步重叠窗口捕获状态变化
5. **消息去重**: clientMessageId 追踪，pending → confirmed 生命周期
6. **Mutation 序列化**: 每对话 Promise 链，保证顺序一致性

**RPC 方法**（10 个）:
| 方法 | 用途 | 读/写 |
|------|------|-------|
| `GetWorkspaceInfos` | 工作区信息 | R |
| `GetAllCascadeTrajectories` | 对话列表 | R |
| `GetCascadeTrajectory` | 对话状态 | R |
| `GetCascadeTrajectorySteps` | 步骤数据 | R |
| `GetCascadeModelConfigData` | 模型列表 | R |
| `StartCascade` | 创建对话 | W |
| `SendUserCascadeMessage` | 发送消息 | W |
| `CancelCascadeInvocation` | 停止执行 | W |
| `DeleteCascadeTrajectory` | 删除对话 | W |
| `RevertToCascadeStep` | 回退步骤 | W |

**关键设计**:
- 服务前缀: `exa.language_server_pb.LanguageServerService`
- CSRF 令牌: `x-codeium-csrf-token` 头
- 传输层: HTTPS 优先，TLS 错误时回退 HTTP
- 工作区 ID 格式: `file_/path/to/workspace` → `file___path_to_workspace`
- 归一化: 小写 + `:` → `_3a`（处理 Windows 盘符）

---

## 🏗️ 目标架构设计

### 分层架构
```
┌─────────────────────────────────────────────────────────┐
│                  antigravity-pilot v4.0                  │
├──────────────────────┬──────────────────────────────────┤
│   RPC 层 (新增)       │      CDP 层 (精简/降级)           │
│                      │                                  │
│ • LS 发现与路由       │ • Shadow DOM 镜像（可选）         │
│ • 对话 CRUD          │ • Simplify 模式（GPU 优化）       │
│ • 消息发送/停止       │ • 降级回退（RPC 不可达时）         │
│ • 步骤流式获取        │                                  │
│ • 状态检测           │                                  │
│ • 文件权限/命令批准   │                                  │
│ • 模型切换           │                                  │
│ • 多工作区支持        │                                  │
└──────────────────────┴──────────────────────────────────┘
         ↓                           ↓
   Antigravity LS              Electron CDP
   (HTTP/HTTPS RPC)            (WebSocket 9000-9003)
```

### 模块映射

| 功能 | 当前实现 | 目标实现 | 优先级 |
|------|---------|---------|--------|
| **LS 发现** | CDP `/json/list` 轮询 | daemon 文件 + 进程扫描 | P0 |
| **消息发送** | `cdp/inject.ts` (147行) | `SendUserCascadeMessage` RPC | P1 |
| **状态检测** | `monitor/phase.ts` (331行) | `GetCascadeTrajectory.status` | P1 |
| **步骤获取** | `captureHTML()` 快照 | `GetCascadeTrajectorySteps` delta | P1 |
| **响应提取** | DOM 克隆 + 过滤 | Step.content 字段 | P2 |
| **对话列表** | CDP 元数据提取 | `GetAllCascadeTrajectories` | P1 |
| **对话创建** | 手动注入 | `StartCascade` | P2 |
| **对话删除** | 不支持 | `DeleteCascadeTrajectory` | P2 |
| **步骤回退** | 不支持 | `RevertToCascadeStep` | P2 |
| **UI 镜像** | `capture/html.ts` (155行) | 保留（可选功能） | P3 |
| **自动操作** | `autoaction/` CDP 点击 | 保留（CDP 专属） | P3 |

---

## 🔧 技术实现细节

### Phase 1: RPC 基础设施

#### 1.1 LS 实例发现
**新增文件**: `packages/server/src/rpc/discovery.ts` (~420 行)

**核心逻辑**:
```typescript
interface LSInstance {
  pid: number;
  httpsPort: number;
  httpPort: number;
  lspPort: number;
  csrfToken: string;
  workspaceId?: string;
  source: "daemon" | "process";
}

// 双路径发现
async function discoverInstances(): Promise<LSInstance[]> {
  const daemon = await discoverFromDaemon();    // ~/.gemini/antigravity/daemon/ls_*.json
  const process = await discoverFromProcess();  // ps + lsof/ss/netstat
  return enrichReachableInstances(merge(daemon, process));
}
```

**Daemon 文件格式**:
```json
{
  "pid": 12345,
  "httpsPort": 43210,
  "httpPort": 43211,
  "lspPort": 43212,
  "csrfToken": "abc123..."
}
```

**进程扫描**:
- Darwin: `ps -axo pid=,args=` + `lsof -nP -iTCP -sTCP:LISTEN`
- Linux: `ps` + `/proc/{pid}/comm` + `ss -tlnp`
- Win32: PowerShell `Get-CimInstance Win32_Process` + `netstat -ano`

**RPC 端口探测**:
- 候选端口列表 → 并发 `GetWorkspaceInfos` 探测
- 1.5s 超时，HTTPS 优先，TLS 错误时回退 HTTP
- 返回首个响应成功的端口

**缓存策略**:
- TTL: 10s（可配置）
- 失败时自动刷新（`invalidate()`）
- 代际标记防止竞态

#### 1.2 RPC 客户端
**新增文件**: `packages/server/src/rpc/client.ts` (~310 行)

**核心接口**:
```typescript
class RPCClient {
  async call<T>(method: string, body: object, instance?: LSInstance): Promise<T>
  async streamRaw(method: string, body: object, instance?: LSInstance): Promise<ReadableStream>
}
```

**传输层回退**:
```typescript
// 优先级: 上次成功协议 > HTTPS > HTTP
const order = getTransportOrder(instance); // ["https", "http"] or ["http", "https"]
for (const protocol of order) {
  try {
    const result = await attempt(protocol);
    rememberSuccessfulTransport(instance, protocol);
    return result;
  } catch (err) {
    if (!isTlsProtocolError(err)) break; // 非协议错误，不重试
  }
}
```

**TLS 错误检测**:
- `EPROTO`, `ECONNRESET`
- `"packet length too long"`, `"wrong version number"`

**请求格式**:
```http
POST /exa.language_server_pb.LanguageServerService/GetCascadeTrajectory HTTP/1.1
Host: 127.0.0.1:43210
Content-Type: application/json
x-codeium-csrf-token: abc123...

{"cascadeId": "..."}
```

**错误映射**:
- `401/403` → `unauthenticated` → 刷新发现缓存
- `503` → `unavailable` → 重试其他实例
- 其他 → `unknown`

#### 1.3 工作区路由
**新增文件**: `packages/server/src/rpc/routing.ts` (~330 行)

**Affinity 缓存**:
```typescript
const conversationAffinity = new Map<string, string>(); // cascadeId → workspaceId
```

**路由策略**:
```
1. 显式指定实例 → 直接使用
2. Affinity 缓存命中 → 使用缓存的 workspaceId 匹配 LS
3. 缓存未命中 → discoverOwnerInstance():
   a. 查询所有 LS 的 GetAllCascadeTrajectories
   b. 找到包含该 cascadeId 的 LS
   c. 优先使用 workspace 元数据匹配
   d. 回退: RUNNING 状态 > stepCount 最高
4. (仅读操作) Try-all: 尝试所有 LS（磁盘 .pb 文件）
```

**工作区 ID 归一化**:
```typescript
function normalizeWorkspaceId(id: string): string {
  return id.replace(/:/g, "_3a").toLowerCase();
}
// "file_E:_Work_novels" → "file_e_3a_work_novels"
// "file_e_3A_Work_novels" → "file_e_3a_work_novels"
```

**写安全**:
- Mutation RPC（SendMessage, Revert, Delete）**禁止** try-all
- 必须有明确的 workspace 元数据才能写入
- 防止误路由到错误的 LS

---

### Phase 2: 核心功能迁移

#### 2.1 消息发送 API
**修改文件**: `packages/server/src/api/interaction.ts`

**当前实现** (CDP):
```typescript
// 1. 找到 contenteditable 编辑器（5 个选择器回退）
// 2. 清空现有内容（Range API + execCommand）
// 3. 注入文本（execCommand("insertText")）
// 4. 找到发送按钮并点击（或按 Enter）
// 5. 等待 300ms 清理残留
```

**目标实现** (RPC):
```typescript
POST /api/cascades/:id/message
{
  "content": "用户消息",
  "clientMessageId": "uuid-v4"  // 可选，用于去重
}

// 后端调用
await rpcForConversation("SendUserCascadeMessage", cascadeId, {
  cascadeId,
  userMessage: { parts: [{ text: content }] }
});
```

**优势**:
- 无需 DOM 选择器（跨版本稳定）
- 无需等待 UI 渲染
- 支持 clientMessageId 去重

**降级策略**:
- RPC 失败 → 回退到 CDP 注入
- 配置开关: `config.rpc.preferRpcForMessages`

#### 2.2 状态检测
**修改文件**: `packages/server/src/monitor/phase.ts`

**当前实现** (DOM 启发式):
```typescript
// 检测 DOM 元素存在性
- Stop button → GENERATING
- Accept/Reject buttons → APPROVAL_PENDING
- Feedback buttons (👍👎) → COMPLETED
- Loading spinner → THINKING
- Error banner → ERROR
```

**目标实现** (RPC):
```typescript
const { status, numTotalSteps } = await rpcForConversation(
  "GetCascadeTrajectory",
  cascadeId,
  { cascadeId }
);

// 状态映射
CASCADE_RUN_STATUS_IDLE → ResponsePhase.IDLE
CASCADE_RUN_STATUS_RUNNING → ResponsePhase.GENERATING
CASCADE_RUN_STATUS_ERROR → ResponsePhase.ERROR
CASCADE_RUN_STATUS_UNLOADED → ResponsePhase.IDLE
```

**混合模式**:
- RPC 提供粗粒度状态（IDLE/RUNNING/ERROR）
- CDP 提供细粒度状态（THINKING/GENERATING/APPROVAL_PENDING）
- 优先使用 RPC，CDP 作为补充

#### 2.3 WebSocket Delta Polling
**新增文件**: `packages/server/src/rpc/ws-poller.ts` (~580 行)

**状态机**:
```
IDLE (5s 心跳)
  ↓ 检测到 RUNNING 或新步骤
ACTIVE (50ms 轮询)
  ↓ 3 次空轮询 + 终止状态
IDLE
```

**激活触发**:
- REST 信号（SendMessage, StartCascade, Revert）
- 心跳检测到 `status === "CASCADE_RUN_STATUS_RUNNING"`
- 心跳检测到 `numTotalSteps > lastStepCount`

**去激活条件**:
- 连续 3 次轮询无新步骤
- 状态为终止态（IDLE/ERROR/UNLOADED）
- 距离激活信号 >5s（防止过早去激活）

**重叠窗口**:
```typescript
const fetchOffset = Math.max(
  minFetchOffset,
  lastStepCount - OVERLAP  // OVERLAP = 20
);
```
- 捕获步骤状态原地变化（PENDING → WAITING → RUNNING → COMPLETED）
- LS 不提供步骤级变更通知，只能暴力重取

**步骤恢复**:
- 检测 4MB protobuf 超限错误 → 注入占位步骤
- 检测 UTF-8 无效错误 → 二分查找下一个有效偏移

#### 2.4 步骤数据结构
**新增文件**: `packages/shared/src/types/trajectory.ts`

**TrajectoryStep 类型**:
```typescript
interface TrajectoryStep {
  stepId: string;
  type: string;  // CORTEX_STEP_TYPE_USER_INPUT, TOOL_USE, PLANNER_RESPONSE, etc.
  status: string;  // PENDING, WAITING, RUNNING, COMPLETED, ERROR
  content?: {
    text?: string;
    toolUse?: { name: string; input: object };
    toolResult?: { output: string; error?: string };
  };
  timestamp?: string;
  clientMessageId?: string;  // 客户端消息 ID（去重用）
  _corrupted?: boolean;  // 占位步骤标记
}
```

**消息去重**:
```typescript
class MessageTracker {
  private pending = new Map<string, { cascadeId: string; ttl: number }>();
  private confirmed = new Map<string, number>();  // clientMessageId → stepIndex

  annotateSteps(cascadeId: string, offset: number, steps: unknown[]): unknown[] {
    // 匹配 CORTEX_STEP_TYPE_USER_INPUT 步骤到 pending 消息
    // pending → confirmed，TTL 10min → 2min
  }
}
```

---

### Phase 3: API 层优化

#### 3.1 OpenAI 兼容 API 改造
**修改文件**: `packages/server/src/api/openai-compat.ts`

**当前流程** (CDP):
```
1. injectMessage() → CDP 注入
2. 等待 1.5s 让消息渲染
3. 捕获基线文本（CHAT_TEXT_SCRIPT）
4. 轮询 500ms，diff 基线获取增量
5. 检测完成：终止阶段 + 4-6 次稳定轮询
```

**目标流程** (RPC):
```
1. SendUserCascadeMessage RPC
2. 立即获取 stepCount 基线
3. Delta polling 获取新步骤
4. 提取 PLANNER_RESPONSE 步骤的 content.text
5. 检测完成：status 终止 + 无新步骤
```

**流式响应**:
```typescript
// SSE 格式
data: {"choices":[{"delta":{"content":"增量文本"}}]}

// 完成检测
if (status === "CASCADE_RUN_STATUS_IDLE" && emptyPolls >= 3) {
  data: {"choices":[{"finish_reason":"stop"}]}
  data: [DONE]
}
```

**优势**:
- 无需 DOM 文本提取（跨版本稳定）
- 增量更精确（步骤级 diff）
- 延迟更低（50ms vs 500ms）

---

### Phase 4: 架构整洁化

#### 4.1 CDP 降级策略
**新增文件**: `packages/server/src/rpc/fallback.ts`

**降级触发条件**:
- RPC 发现失败（无 LS 实例）
- RPC 调用超时（3s）
- RPC 返回 `unavailable` 错误

**降级行为**:
```typescript
async function sendMessageWithFallback(cascadeId: string, content: string) {
  try {
    await rpcForConversation("SendUserCascadeMessage", cascadeId, { ... });
  } catch (err) {
    if (shouldFallbackToCDP(err)) {
      console.warn("[fallback] RPC failed, using CDP injection");
      await injectMessage(cascadeId, content);  // 原 CDP 逻辑
    } else {
      throw err;
    }
  }
}
```

**配置开关**:
```json
{
  "rpc": {
    "enabled": true,
    "fallbackToCDP": true,
    "preferRpcForMessages": true,
    "preferRpcForStatus": true
  }
}
```

#### 4.2 UI 镜像可选化
**修改文件**: `packages/server/src/loop/snapshot.ts`

**配置**:
```json
{
  "cdp": {
    "enableSnapshot": false,  // 关闭 HTML 快照
    "enableSimplify": true     // 保留 GPU 优化
  }
}
```

**行为**:
- `enableSnapshot: false` → 停止快照循环，不广播 `snapshot_update`
- 前端 Shadow DOM 渲染禁用
- 仅保留 RPC 数据流

---

## 📐 数据流对比

### 当前架构（CDP Only）
```
用户点击发送
  ↓
REST API: POST /api/cascades/:id/message
  ↓
cdp/inject.ts: 找编辑器 → 注入文本 → 点击按钮
  ↓
等待 300ms
  ↓
loop/snapshot.ts: 每 1s 调用 captureHTML()
  ↓
hash diff → 广播 snapshot_update (50-200KB)
  ↓
monitor/phase.ts: DOM 启发式检测阶段
  ↓
WebSocket → 前端
```

**延迟**: 消息发送 ~500ms，状态更新 ~1s，带宽 ~150KB/次

### 目标架构（RPC Primary）
```
用户点击发送
  ↓
REST API: POST /api/cascades/:id/message
  ↓
rpc/client.ts: SendUserCascadeMessage RPC
  ↓
立即返回（无需等待 UI）
  ↓
rpc/ws-poller.ts: 激活 ACTIVE 模式（50ms 轮询）
  ↓
GetCascadeTrajectorySteps delta (offset + 新步骤)
  ↓
广播 steps 消息 (~2-10KB JSON)
  ↓
WebSocket → 前端
```

**延迟**: 消息发送 ~50ms，状态更新 ~50ms，带宽 ~5KB/次

---

## 🎯 成功指标

### 性能指标
| 指标 | 当前 | 目标 | 测量方法 |
|------|------|------|----------|
| 消息发送延迟 | 500ms | <100ms | 时间戳 diff |
| 状态更新延迟 | 1000ms | <100ms | phase_change 事件间隔 |
| WebSocket 带宽 | 150KB/s | <20KB/s | 网络监控 |
| 跨版本兼容性 | 70% | >95% | AG 版本测试矩阵 |

### 功能指标
| 功能 | 当前 | 目标 |
|------|------|------|
| 多工作区支持 | ❌ | ✅ |
| 对话创建 | 手动注入 | RPC API |
| 对话删除 | ❌ | ✅ |
| 步骤回退 | ❌ | ✅ |
| 消息去重 | ❌ | ✅ |
| 步骤损坏恢复 | ❌ | ✅ |

### 代码质量
| 指标 | 当前 | 目标 |
|------|------|------|
| CDP 依赖模块 | 8 个 | 3 个（降级用） |
| DOM 选择器数量 | 15+ | 5（仅 UI 镜像） |
| 启发式逻辑行数 | 331 | <100 |
| 测试覆盖率 | 未知 | >80% |

---

## 🚧 实施计划

### Phase 1: RPC 基础设施（4 周）
**Week 1-2**: LS 发现 + RPC 客户端
- [ ] 实现 `rpc/discovery.ts`（daemon + 进程扫描）
- [ ] 实现 `rpc/client.ts`（双协议回退）
- [ ] 单元测试（模拟 LS 响应）
- [ ] 集成测试（真实 AG 实例）

**Week 3-4**: 工作区路由
- [ ] 实现 `rpc/routing.ts`（affinity 缓存）
- [ ] 工作区 ID 归一化
- [ ] 多 LS 实例测试
- [ ] 文档：RPC 架构设计

**交付物**:
- 3 个新模块（~1,060 行）
- 测试覆盖率 >80%
- 架构文档

### Phase 2: 核心功能迁移（6 周）
**Week 5-6**: 消息发送 + 状态检测
- [ ] 修改 `api/interaction.ts`（RPC 优先）
- [ ] 修改 `monitor/phase.ts`（混合模式）
- [ ] 降级策略实现
- [ ] A/B 测试（RPC vs CDP）

**Week 7-9**: WebSocket Delta Polling
- [ ] 实现 `rpc/ws-poller.ts`（状态机）
- [ ] 步骤数据结构定义
- [ ] 消息去重逻辑
- [ ] 步骤恢复机制
- [ ] 前端适配（解析 TrajectoryStep）

**Week 10**: 集成测试 + Bug 修复
- [ ] 端到端测试（发送 → 轮询 → 渲染）
- [ ] 压力测试（多对话并发）
- [ ] 边界情况（LS 重启、网络抖动）

**交付物**:
- 核心功能 RPC 化
- 前端兼容新数据格式
- 测试套件

### Phase 3: API 层优化（3 周）
**Week 11-12**: OpenAI 兼容 API
- [ ] 修改 `api/openai-compat.ts`（RPC 底层）
- [ ] 流式响应优化
- [ ] 完成检测逻辑
- [ ] 性能基准测试

**Week 13**: 文档 + 示例
- [ ] API 文档更新
- [ ] 示例代码（LangChain, OpenAI SDK）
- [ ] 迁移指南

**交付物**:
- OpenAI API 性能提升 5-10x
- 完整 API 文档

### Phase 4: 架构整洁化（2 周）
**Week 14**: CDP 降级 + 配置化
- [ ] 实现 `rpc/fallback.ts`
- [ ] 配置开关（`config.json`）
- [ ] UI 镜像可选化
- [ ] 性能对比报告

**Week 15**: 清理 + 发布
- [ ] 移除冗余 CDP 代码
- [ ] 代码审查
- [ ] 发布 v4.0.0-beta
- [ ] 用户反馈收集

**交付物**:
- 清洁架构
- Beta 版本发布

---

## ⚠️ 风险与缓解

### 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| **RPC API 不稳定** | 高 | 中 | 保留 CDP 降级；版本检测；社区反馈渠道 |
| **LS 发现失败** | 高 | 低 | 多路径发现（daemon + 进程）；手动配置端口 |
| **工作区路由错误** | 高 | 中 | 写操作强制 workspace 验证；affinity 缓存 TTL |
| **步骤数据损坏** | 中 | 低 | 步骤恢复机制；占位步骤；前端软刷新 |
| **性能回退** | 中 | 低 | 性能基准测试；A/B 对比；可配置轮询间隔 |
| **前端兼容性** | 中 | 中 | 渐进式迁移；保留 CDP 数据格式兼容层 |

### 业务风险

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| **用户迁移成本** | 中 | 高 | 自动迁移；配置向后兼容；详细文档 |
| **AG 版本碎片化** | 中 | 高 | 版本检测；降级策略；社区测试矩阵 |
| **开发周期延长** | 低 | 中 | 分阶段交付；MVP 优先；并行开发 |

---

## 🔍 测试策略

### 单元测试
**覆盖模块**:
- `rpc/discovery.ts`: 模拟 daemon 文件、进程输出
- `rpc/client.ts`: 模拟 HTTP 响应、TLS 错误
- `rpc/routing.ts`: affinity 缓存、归一化逻辑
- `rpc/ws-poller.ts`: 状态机转换、重叠窗口计算

**工具**: Jest + ts-jest

### 集成测试
**场景**:
1. 单 LS 实例：发送消息 → 轮询步骤 → 检测完成
2. 多 LS 实例：路由到正确工作区
3. LS 重启：发现刷新 → 重连
4. 网络抖动：重试 → 降级到 CDP
5. 步骤损坏：恢复 → 占位步骤

**工具**: Supertest + 真实 AG 实例

### 性能测试
**指标**:
- 消息发送延迟（p50, p95, p99）
- WebSocket 带宽（bytes/s）
- CPU 使用率（轮询开销）
- 内存使用（affinity 缓存）

**工具**: Artillery + Prometheus

### 兼容性测试
**AG 版本矩阵**:
- v1.100 - v1.106（旧路径）
- v1.107+（新路径）
- 最新 nightly

**测试用例**:
- RPC 端点可达性
- 步骤数据格式
- 工作区 ID 格式

---

## 📚 依赖与前置条件

### 外部依赖
- **Antigravity IDE**: 必须启动 Language Server（自动启动）
- **Node.js**: >=18（原生 fetch, node:test）
- **操作系统**: macOS, Linux, Windows（进程扫描适配）

### 内部依赖
- `@ag/shared`: 类型定义共享
- `express`: HTTP 服务器
- `ws`: WebSocket 服务器

### 新增依赖
无（使用 Node.js 原生 `node:http/https`）

---

## 🎓 学习与参考

### 参考实现
- **porta**: `/Users/nothing/workspace/antigravity/porta/packages/proxy/src/`
  - `discovery.ts` (419行): LS 发现逻辑
  - `rpc.ts` (311行): RPC 客户端
  - `routing.ts` (332行): 工作区路由
  - `ws.ts` (577行): Delta polling 状态机

### 关键文件
- **antigravity-pilot**:
  - `packages/server/src/cdp/inject.ts` (147行): 当前消息注入逻辑
  - `packages/server/src/monitor/phase.ts` (331行): 当前状态检测
  - `packages/server/src/loop/snapshot.ts` (156行): 当前快照循环

### 设计模式
- **发现模式**: 多路径发现 + 缓存 + TTL
- **回退模式**: 传输层回退（HTTPS → HTTP）
- **路由模式**: Affinity 缓存 + 动态发现
- **轮询模式**: 状态机（IDLE ↔ ACTIVE）
- **恢复模式**: 步骤损坏检测 + 占位符注入

---

## 📝 附录

### A. RPC 方法完整列表

| 方法 | 请求 | 响应 | 用途 |
|------|------|------|------|
| `GetWorkspaceInfos` | `{}` | `{workspaceInfos: [{workspaceUri}]}` | 工作区信息 |
| `GetAllCascadeTrajectories` | `{}` | `{trajectorySummaries: {[id]: {...}}}` | 对话列表 |
| `GetCascadeTrajectory` | `{cascadeId}` | `{status, numTotalSteps, workspaces}` | 对话状态 |
| `GetCascadeTrajectorySteps` | `{cascadeId, stepOffset}` | `{steps: [...]}` | 步骤数据 |
| `GetCascadeModelConfigData` | `{}` | `{models: [...]}` | 模型列表 |
| `StartCascade` | `{workspaceId, modelId}` | `{cascadeId}` | 创建对话 |
| `SendUserCascadeMessage` | `{cascadeId, userMessage}` | `{}` | 发送消息 |
| `CancelCascadeInvocation` | `{cascadeId}` | `{}` | 停止执行 |
| `DeleteCascadeTrajectory` | `{cascadeId}` | `{}` | 删除对话 |
| `RevertToCascadeStep` | `{cascadeId, stepId}` | `{}` | 回退步骤 |
| `HandleCascadeUserInteraction` | `{cascadeId, interaction}` | `{}` | 文件权限/命令批准 |

### B. 配置示例

```json
{
  "rpc": {
    "enabled": true,
    "fallbackToCDP": true,
    "discoveryInterval": 10000,
    "discoveryTTL": 10000,
    "preferRpcForMessages": true,
    "preferRpcForStatus": true,
    "activePollInterval": 50,
    "idlePollInterval": 5000,
    "overlapWindow": 20
  },
  "cdp": {
    "enabled": true,
    "enableSnapshot": false,
    "enableSimplify": true,
    "ports": [9000, 9001, 9002, 9003]
  }
}
```

### C. 术语表

| 术语 | 定义 |
|------|------|
| **LS** | Language Server，Antigravity 的后端服务 |
| **Connect RPC** | Antigravity 的 gRPC-like HTTP API |
| **Cascade** | Antigravity 中的对话（conversation） |
| **Trajectory** | 对话的执行轨迹（步骤序列） |
| **Step** | 单个执行步骤（用户输入、工具调用、响应等） |
| **Affinity** | 对话与工作区的绑定关系 |
| **Delta Polling** | 增量轮询（只获取新数据） |
| **Overlap Window** | 重叠窗口（重取最后 N 步以捕获状态变化） |
| **CSRF Token** | LS 的认证令牌 |
| **Daemon File** | LS 写入的发现文件（`~/.gemini/antigravity/daemon/ls_*.json`） |

---

## ✅ 验收标准

### Phase 1
- [ ] LS 发现成功率 >95%（单/多实例）
- [ ] RPC 调用成功率 >99%（正常网络）
- [ ] 传输层回退正常工作（HTTPS ↔ HTTP）
- [ ] 单元测试覆盖率 >80%

### Phase 2
- [ ] 消息发送延迟 <100ms（p95）
- [ ] 状态更新延迟 <100ms（p95）
- [ ] WebSocket 带宽降低 >80%
- [ ] 多工作区路由准确率 100%
- [ ] 步骤损坏恢复成功率 >95%

### Phase 3
- [ ] OpenAI API 延迟降低 >50%
- [ ] 流式响应稳定性 >99%
- [ ] API 文档完整（所有端点）

### Phase 4
- [ ] CDP 降级正常工作
- [ ] 配置开关生效
- [ ] 代码复杂度降低 >30%
- [ ] 用户反馈积极（Beta 测试）

---

**文档版本**: v1.0
**最后更新**: 2026-03-23
**审阅者**: 待定
**批准者**: 待定
