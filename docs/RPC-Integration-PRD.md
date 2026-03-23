# antigravity-pilot RPC 层集成 PRD

> PRD Version: 1.0.0 | Date: 2026-03-23 | Status: Draft

---

## ⚡ 读前必看 — 给执行者的全局地图

### 一句话概括
将 antigravity-pilot 从"CDP DOM 抓取"架构升级为"RPC + CDP 混合"架构，用结构化 API 替代脆弱的 HTML 解析，降低 80% 带宽、提升 20x 响应速度、支持多工作区。

### 拆之前 vs 拆之后（ASCII 图）

```
【当前架构 - CDP Only】

用户发送消息
    ↓
REST API
    ↓
cdp/inject.ts (147行)
找编辑器 → 注入文本 → 点击按钮
    ↓
等待 300ms
    ↓
loop/snapshot.ts (155行)
每 1s 调用 captureHTML() → 返回完整 HTML (50-200KB)
    ↓
monitor/phase.ts (330行)
DOM 启发式检测状态（找按钮、spinner）
    ↓
WebSocket 广播 snapshot_update
    ↓
前端 Shadow DOM 渲染

痛点：
- 选择器脆弱（AG 更新后失效）
- 高带宽（完整 HTML）
- 高延迟（1s 轮询）
- 单工作区假设
```

```
【目标架构 - RPC Primary】

用户发送消息
    ↓
REST API
    ↓
rpc/client.ts (新增 ~310行)
SendUserCascadeMessage RPC → 立即返回
    ↓
rpc/ws-poller.ts (新增 ~580行)
50ms 轮询 GetCascadeTrajectorySteps → 返回 JSON delta (2-10KB)
    ↓
结构化 status 字段（无需 DOM 解析）
    ↓
WebSocket 广播 steps 消息
    ↓
前端渲染 TrajectoryStep[]

收益：
- 跨版本稳定（RPC API 变化慢）
- 低带宽（JSON delta）
- 低延迟（50ms 轮询）
- 多工作区路由
```

### Phase 执行顺序（依赖链图）

```
Phase 0: 准备工作（创建目录、类型定义）
    ↓
Phase 1: RPC 基础设施
    ├─ 1A: LS 发现（daemon + 进程扫描）
    ├─ 1B: RPC 客户端（双协议回退）
    └─ 1C: 工作区路由（affinity 缓存）
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
```

### 每个 Phase 一句话说明

| Phase | 名称 | 一句话 | 预计耗时 |
|-------|------|--------|----------|
| 0 | 准备工作 | 创建 `rpc/` 目录，定义共享类型 | 0.5 天 |
| 1 | RPC 基础设施 | 实现 LS 发现、RPC 客户端、工作区路由 | 5 天 |
| 2 | 消息发送迁移 | `POST /message` 改用 RPC，CDP 作降级 | 2 天 |
| 3 | 状态检测迁移 | 用 RPC `status` 字段替代部分 DOM 检测 | 2 天 |
| 4 | Delta Polling | 实现 50ms 轮询状态机，替代 1s 快照 | 4 天 |
| 5 | 前端适配 | 前端解析 `TrajectoryStep[]`，兼容旧格式 | 3 天 |
| 6 | OpenAI API 优化 | `/v1/chat/completions` 底层切换到 RPC | 2 天 |
| 7 | 清理与配置化 | 移除冗余代码，添加配置开关 | 2 天 |

**总计**: ~20.5 天（约 4 周）

### 最重要的一条规则

**🚨 写操作（SendMessage, Revert, Delete）必须有明确的 workspaceId，禁止 try-all 回退**

原因：多 LS 实例可能加载同一个磁盘 `.pb` 文件，try-all 会导致写入错误的 LS。

### 关键概念科普

| 概念 | 通俗解释 | 你会在哪里遇到 |
|------|----------|----------------|
| **LS (Language Server)** | Antigravity 的后端服务，每个工作区一个实例 | Phase 1 发现逻辑 |
| **Connect RPC** | Antigravity 的 HTTP API，格式：`POST /exa.language_server_pb.LanguageServerService/{方法名}` | Phase 1 RPC 客户端 |
| **Cascade** | Antigravity 中的"对话"（conversation） | 所有 Phase |
| **Trajectory** | 对话的执行轨迹，由多个 Step 组成 | Phase 4 轮询逻辑 |
| **Step** | 单个执行步骤（用户输入、工具调用、响应等） | Phase 4-5 |
| **Affinity** | 对话与工作区的绑定关系，用于路由 | Phase 1C |
| **Delta Polling** | 只获取新增数据的轮询方式（offset + 新步骤） | Phase 4 |
| **Overlap Window** | 重取最后 N 步以捕获状态变化（LS 无步骤级通知） | Phase 4 |
| **CSRF Token** | LS 的认证令牌，从 daemon 文件或进程参数获取 | Phase 1A |
| **Daemon File** | LS 写入的发现文件：`~/.gemini/antigravity/daemon/ls_*.json` | Phase 1A |

---

## 1. 背景与动机

### 1.1 现状

**代码规模**（antigravity-pilot）:
- Server: 37 个 `.ts` 文件，6,808 行
- Web: 32 个 `.ts/.tsx` 文件
- Shared: 7 个 `.ts` 文件
- Tests: 159 个测试文件

**关键模块**:
```
packages/server/src/
├── cdp/              # 7 个文件，CDP 连接、注入、元数据
├── loop/             # 2 个文件，发现循环 + 快照循环
├── capture/          # 2 个文件，HTML/CSS 捕获脚本
├── monitor/          # 1 个文件，阶段检测（330 行）
├── api/              # 9 个文件，REST 端点
├── autoaction/       # 1 个文件，自动 Accept/Retry
└── ws/               # 1 个文件，WebSocket 广播
```

**核心流程**:
1. **发现**: `loop/discovery.ts` (198行) 每 10s 轮询 CDP 端口 9000-9003 的 `/json/list`
2. **快照**: `loop/snapshot.ts` (155行) 每 1s 调用 `captureHTML()` → 返回完整 HTML
3. **消息发送**: `cdp/inject.ts` (147行) 找 contenteditable → 注入文本 → 点击按钮
4. **状态检测**: `monitor/phase.ts` (330行) DOM 启发式（找按钮、spinner）
5. **响应提取**: `api/openai-compat.ts` (398行) 从 DOM 克隆、过滤噪音、diff 基线

**CDP 依赖统计**:
- `captureHTML` 被调用：4 处（snapshot.ts, session.ts, interaction.ts x2）
- `injectMessage` 被调用：2 处（openai-compat.ts, interaction.ts）
- API 层 CDP 依赖：5 个 import

### 1.2 痛点

1. **选择器脆弱性**：`cdp/inject.ts` L14-53 使用 5 个 contenteditable 选择器回退，AG 更新后可能全部失效
2. **高带宽消耗**：每次快照返回完整 HTML（50-200KB），1s 轮询 = 150KB/s
3. **高延迟**：状态更新延迟 1s（快照间隔），消息发送需等待 300ms 清理
4. **单工作区假设**：`loop/discovery.ts` 假设单 IDE 实例，无法路由到正确的 LS
5. **启发式不可靠**：`monitor/phase.ts` L50-120 通过 DOM 类名检测状态，AG UI 改版即失效
6. **功能缺失**：无对话创建、删除、步骤回退 API

### 1.3 目标

**目标目录结构**:
```
packages/server/src/
├── rpc/                    # 新增：RPC 层
│   ├── discovery.ts        # LS 发现（~420 行，参考 porta）
│   ├── client.ts           # RPC 客户端（~310 行）
│   ├── routing.ts          # 工作区路由（~330 行）
│   ├── ws-poller.ts        # Delta polling（~580 行）
│   ├── fallback.ts         # CDP 降级策略（~100 行）
│   └── types.ts            # RPC 类型定义（~50 行）
├── cdp/                    # 保留：降级 + UI 镜像
│   ├── connection.ts       # 保留
│   ├── inject.ts           # 保留（降级用）
│   ├── simplify.ts         # 保留（GPU 优化）
│   └── metadata.ts         # 保留
├── loop/
│   ├── discovery.ts        # 删除（RPC 发现替代）
│   └── snapshot.ts         # 精简（可选功能）
├── monitor/
│   └── phase.ts            # 精简（混合模式）
└── api/
    ├── interaction.ts      # 修改（RPC 优先）
    └── openai-compat.ts    # 修改（RPC 底层）
```

**核心原则**:
1. **RPC 优先，CDP 降级**：所有核心功能优先使用 RPC，CDP 仅作降级和 UI 镜像
2. **工作区安全**：写操作必须有明确 workspaceId，禁止 try-all
3. **渐进迁移**：每个 Phase 独立可测，不破坏现有功能
4. **配置化**：通过 `config.json` 控制 RPC/CDP 模式
5. **保留降级**：RPC 不可达时自动回退到 CDP

---

## 2. 设计原则

1. **KISS 优先**：不过度设计，直接复用 porta 的成熟实现
2. **类型安全**：所有 RPC 调用有明确类型定义
3. **错误透明**：RPC 失败时清晰日志，自动降级
4. **测试驱动**：每个模块有单元测试，每个 Phase 有集成测试
5. **向后兼容**：前端同时支持旧 `snapshot_update` 和新 `steps` 消息

---

## 3. 模块架构设计

### 3.1 依赖关系总图

```
┌─────────────────────────────────────────────┐
│           REST API Layer                     │
│  (api/interaction.ts, api/openai-compat.ts) │
└──────────────┬──────────────────────────────┘
               ↓
┌──────────────┴──────────────────────────────┐
│         RPC Layer (新增)                     │
│  ┌──────────────┐  ┌──────────────┐         │
│  │ rpc/routing  │→ │ rpc/client   │         │
│  │ (affinity)   │  │ (HTTP call)  │         │
│  └──────┬───────┘  └──────┬───────┘         │
│         ↓                  ↓                 │
│  ┌──────────────────────────────┐           │
│  │     rpc/discovery            │           │
│  │  (daemon + process scan)     │           │
│  └──────────────────────────────┘           │
└─────────────────────────────────────────────┘
               ↓
┌──────────────┴──────────────────────────────┐
│      Antigravity Language Server            │
│   (Connect RPC: exa.language_server_pb...)  │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│         WebSocket Layer                      │
│  ┌──────────────────────────────┐           │
│  │   rpc/ws-poller              │           │
│  │  (50ms delta polling)        │           │
│  └──────┬───────────────────────┘           │
│         ↓                                    │
│  ┌──────────────────────────────┐           │
│  │   ws/broadcast               │           │
│  │  (推送 steps 消息)            │           │
│  └──────────────────────────────┘           │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│      CDP Layer (降级 + UI 镜像)              │
│  ┌──────────────┐  ┌──────────────┐         │
│  │ cdp/inject   │  │ cdp/simplify │         │
│  │ (降级用)      │  │ (GPU 优化)    │         │
│  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────┘
```

### 3.2 rpc/discovery.ts - LS 实例发现

**职责**: 发现运行中的 Antigravity Language Server 实例

**来源文件迁移表**:

| 原路径 | 迁移内容 | 说明 |
|--------|----------|------|
| porta/packages/proxy/src/discovery.ts | 完整复制 L1-418 | 核心发现逻辑 |
| porta/packages/proxy/src/platform/ | 完整复制整个目录 | OS 特定进程扫描 |
| 无 | 新增 | 本项目无对应实现 |

**关键改造**:
```typescript
// 新增类型定义
export interface LSInstance {
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

**目录结构**:
```
packages/server/src/rpc/
├── discovery.ts          # 主发现逻辑（~420 行）
├── platform/
│   ├── index.ts          # 平台选择器
│   ├── types.ts          # PlatformAdapter 接口
│   ├── darwin.ts         # macOS 实现
│   ├── linux.ts          # Linux 实现
│   ├── win32.ts          # Windows 实现
│   └── shared.ts         # 共享解析器（~210 行）
└── transport-hints.ts    # 传输协议记忆（~40 行）
```

### 3.3 rpc/client.ts - RPC 客户端

**职责**: 封装 Connect RPC 调用，处理双协议回退

**来源文件迁移表**:

| 原路径 | 迁移内容 | 说明 |
|--------|----------|------|
| porta/packages/proxy/src/rpc.ts | 完整复制 L1-310 | RPC 客户端核心 |
| 无 | 新增 | 本项目无对应实现 |

**关键改造**:
```typescript
// RPC 客户端接口
export class RPCClient {
  constructor(private readonly discovery: LSDiscovery) {}

  async call<T>(method: string, body: object, instance?: LSInstance): Promise<T> {
    // 1. 获取 LS 实例
    // 2. 尝试 HTTPS，TLS 错误时回退 HTTP
    // 3. 401/403 → 刷新发现缓存
    // 4. 返回 JSON 响应
  }
}

// 请求格式
POST /exa.language_server_pb.LanguageServerService/{method}
Headers:
  Content-Type: application/json
  x-codeium-csrf-token: {csrfToken}
Body: {JSON payload}
```

### 3.4 rpc/routing.ts - 工作区路由

**职责**: 将 RPC 调用路由到正确的 LS 实例

**来源文件迁移表**:

| 原路径 | 迁移内容 | 说明 |
|--------|----------|------|
| porta/packages/proxy/src/routing.ts | 完整复制 L1-331 | 路由逻辑 |
| 无 | 新增 | 本项目无对应实现 |

**关键改造**:
```typescript
// Affinity 缓存
const conversationAffinity = new Map<string, string>(); // cascadeId → workspaceId

// 路由策略
async function rpcForConversation<T>(
  method: string,
  cascadeId: string,
  body: object,
  pinnedInstance?: LSInstance,
  readOnly = false  // 写操作必须 false
): Promise<T>

// 工作区 ID 归一化（处理 Windows 盘符）
function normalizeWorkspaceId(id: string): string {
  return id.replace(/:/g, "_3a").toLowerCase();
}
```

### 3.5 rpc/ws-poller.ts - Delta Polling

**职责**: WebSocket 增量轮询，替代 1s HTML 快照

**来源文件迁移表**:

| 原路径 | 迁移内容 | 说明 |
|--------|----------|------|
| porta/packages/proxy/src/ws.ts | 核心逻辑参考 L1-576 | 状态机 + 轮询 |
| packages/server/src/loop/snapshot.ts | 删除 L50-120 | 快照循环逻辑 |

**关键改造**:
```typescript
// 状态机
type PollState = "idle" | "active";

// IDLE: 5s 心跳
// ACTIVE: 50ms 轮询，20 步重叠窗口

// 激活触发
- REST 信号（SendMessage, StartCascade）
- 心跳检测到 status === "CASCADE_RUN_STATUS_RUNNING"
- 心跳检测到 numTotalSteps > lastStepCount

// 去激活条件
- 连续 3 次空轮询 + 终止状态 + 距激活 >5s
```

---

## 4. 执行计划

### Phase 0: 准备工作

> **🗺️ 你在哪里**：当前代码库完全基于 CDP，无 RPC 相关代码
>
> **为什么现在做这个**：就像盖房子前要打地基，先创建目录结构和类型定义，后续模块才有地方放
>
> **做完之后的状态**：有了 `rpc/` 目录和基础类型，可以开始实现具体模块

**目标**：创建目录结构，定义共享类型

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 0.1 | 创建 RPC 目录 | `mkdir -p packages/server/src/rpc/platform` | `ls packages/server/src/rpc` 显示目录存在 |
| 0.2 | 定义 LSInstance 类型 | 创建 `packages/server/src/rpc/types.ts`，复制 porta 的 LSInstance 定义（porta/packages/proxy/src/discovery.ts L25-34） | `grep "interface LSInstance" packages/server/src/rpc/types.ts` 有输出 |
| 0.3 | 定义 TrajectoryStep 类型 | 在 `packages/shared/src/types/trajectory.ts` 定义 Step 类型（参考 porta 的 step 结构） | TypeScript 编译通过 |
| 0.4 | 更新 package.json | 确认 `@ag/server` 的 `dependencies` 包含 `@ag/shared` | `grep "@ag/shared" packages/server/package.json` 有输出 |

**交付标准**：
- [ ] `packages/server/src/rpc/` 目录存在
- [ ] `packages/server/src/rpc/types.ts` 定义了 `LSInstance` 接口
- [ ] `packages/shared/src/types/trajectory.ts` 定义了 `TrajectoryStep` 接口
- [ ] `pnpm build` 编译通过

> **⚠️ Phase 0 注意事项**：
> - **类型定义要完整**：LSInstance 必须包含 `pid, httpsPort, httpPort, lspPort, csrfToken, workspaceId?, source`
> - **禁止操作**：不要修改现有文件，只新增
> - **测试失败的常见原因**：忘记在 `packages/shared/src/index.ts` 导出新类型

---

### Phase 1: RPC 基础设施

> **🗺️ 你在哪里**：Phase 0 完成，有了目录和类型定义，但还没有任何实际功能
>
> **为什么现在做这个**：就像修路前要先勘测地形，必须先能发现 LS 实例、建立连接、正确路由，后续功能才能工作
>
> **做完之后的状态**：可以发现运行中的 LS，调用任意 RPC 方法，自动路由到正确工作区

**目标**：实现 LS 发现、RPC 客户端、工作区路由

#### Phase 1A: LS 发现

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 1A.1 | 复制平台适配器 | 从 porta 复制整个 `packages/proxy/src/platform/` 目录到 `packages/server/src/rpc/platform/` | `ls packages/server/src/rpc/platform/*.ts` 显示 5 个文件 |
| 1A.2 | 复制 transport-hints | 从 porta 复制 `packages/proxy/src/transport-hints.ts` 到 `packages/server/src/rpc/transport-hints.ts` | `wc -l packages/server/src/rpc/transport-hints.ts` 显示 ~41 行 |
| 1A.3 | 复制 discovery 主逻辑 | 从 porta 复制 `packages/proxy/src/discovery.ts` 到 `packages/server/src/rpc/discovery.ts` | `wc -l packages/server/src/rpc/discovery.ts` 显示 ~418 行 |
| 1A.4 | 修改 import 路径 | 在 `discovery.ts` 中，将 `from "./platform/index.js"` 改为 `from "./platform/index"` （移除 .js 后缀） | `grep "from \"./platform/index\"" packages/server/src/rpc/discovery.ts` 有输出 |
| 1A.5 | 测试发现功能 | 创建测试文件 `packages/server/src/rpc/__tests__/discovery.test.ts`，测试 `discoverInstances()` | `pnpm test discovery.test.ts` 通过 |

#### Phase 1B: RPC 客户端

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 1B.1 | 复制 RPC 客户端 | 从 porta 复制 `packages/proxy/src/rpc.ts` 到 `packages/server/src/rpc/client.ts` | `wc -l packages/server/src/rpc/client.ts` 显示 ~310 行 |
| 1B.2 | 修改类名 | 将文件中的 `export class RPCClient` 保持不变，但确保导入了 `LSDiscovery` | `grep "class RPCClient" packages/server/src/rpc/client.ts` 有输出 |
| 1B.3 | 修改 import | 将 `from "./discovery.js"` 改为 `from "./discovery"`，`from "./transport-hints.js"` 改为 `from "./transport-hints"` | TypeScript 编译通过 |
| 1B.4 | 测试 RPC 调用 | 创建 `packages/server/src/rpc/__tests__/client.test.ts`，mock HTTP 响应测试 `call()` 方法 | `pnpm test client.test.ts` 通过 |

#### Phase 1C: 工作区路由

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 1C.1 | 复制路由逻辑 | 从 porta 复制 `packages/proxy/src/routing.ts` 到 `packages/server/src/rpc/routing.ts` | `wc -l packages/server/src/rpc/routing.ts` 显示 ~331 行 |
| 1C.2 | 修改 import | 将所有 `.js` 后缀移除，确保导入 `discovery`, `client` | TypeScript 编译通过 |
| 1C.3 | 导出单例 | 确保文件导出 `export const discovery = new LSDiscovery()` 和 `export const rpc = new RPCClient(discovery)` | `grep "export const discovery" packages/server/src/rpc/routing.ts` 有输出 |
| 1C.4 | 测试路由 | 创建 `packages/server/src/rpc/__tests__/routing.test.ts`，测试 affinity 缓存和归一化逻辑 | `pnpm test routing.test.ts` 通过 |
| 1C.5 | 集成测试 | 启动真实 AG 实例，调用 `rpcForConversation("GetAllCascadeTrajectories", ...)` | 返回对话列表 JSON |

**交付标准**：
- [ ] `packages/server/src/rpc/discovery.ts` 存在且可编译
- [ ] `packages/server/src/rpc/client.ts` 存在且可编译
- [ ] `packages/server/src/rpc/routing.ts` 存在且可编译
- [ ] 单元测试覆盖率 >70%
- [ ] 集成测试：能发现 LS 并调用 `GetWorkspaceInfos`

> **⚠️ Phase 1 注意事项**：
> - **最容易出错的点**：porta 使用 `.js` 后缀（ESM），本项目不需要，必须全部移除
> - **禁止操作**：不要修改 porta 原文件，只复制到本项目后修改
> - **隐藏依赖**：`discovery.ts` 依赖 `platform/` 目录，必须一起复制
> - **测试失败的常见原因**：
>   - 忘记启动 AG 实例（集成测试需要）
>   - daemon 文件不存在（`~/.gemini/antigravity/daemon/` 目录为空）
>   - CSRF token 过期（重启 AG 会生成新 token）

---

### Phase 2: 消息发送迁移

> **🗺️ 你在哪里**：Phase 1 完成，可以发现 LS 并调用 RPC，但业务逻辑还在用 CDP
>
> **为什么现在做这个**：消息发送是最高频操作，也是 CDP 最脆弱的地方（选择器易失效），优先迁移收益最大
>
> **做完之后的状态**：用户发送消息走 RPC，CDP 仅作降级，延迟从 500ms 降到 <100ms

**目标**：`POST /api/cascades/:id/message` 改用 RPC，CDP 作降级

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 2.1 | 创建降级模块 | 创建 `packages/server/src/rpc/fallback.ts`，实现 `sendMessageWithFallback()` 函数 | 文件存在 |
| 2.2 | 修改 interaction.ts | 在 `packages/server/src/api/interaction.ts` L29，将 `await injectMessage(c.cdp, req.body.message)` 改为调用 `sendMessageWithFallback()` | `grep "sendMessageWithFallback" packages/server/src/api/interaction.ts` 有输出 |
| 2.3 | 实现 RPC 发送 | 在 `fallback.ts` 中，调用 `rpcForConversation("SendUserCascadeMessage", cascadeId, { cascadeId, userMessage: { parts: [{ text: content }] } })` | TypeScript 编译通过 |
| 2.4 | 实现 CDP 降级 | 在 `fallback.ts` 中，catch RPC 错误后调用原 `injectMessage()` | 代码逻辑正确 |
| 2.5 | 添加配置开关 | 在 `packages/server/src/config.ts` 添加 `rpc.preferRpcForMessages: boolean` 配置项 | `grep "preferRpcForMessages" packages/server/src/config.ts` 有输出 |
| 2.6 | 测试 RPC 路径 | 启动 AG，发送消息，检查日志是否显示 "Using RPC for message" | 日志有输出 |
| 2.7 | 测试降级路径 | 停止 LS，发送消息，检查日志是否显示 "Fallback to CDP" | 日志有输出且消息成功发送 |

**交付标准**：
- [ ] `packages/server/src/rpc/fallback.ts` 实现完整
- [ ] `packages/server/src/api/interaction.ts` 调用 RPC 优先
- [ ] 配置项 `rpc.preferRpcForMessages` 生效
- [ ] 测试：RPC 成功时不调用 CDP
- [ ] 测试：RPC 失败时自动降级到 CDP

> **⚠️ Phase 2 注意事项**：
> - **最容易出错的点**：`SendUserCascadeMessage` 的 body 格式必须是 `{ cascadeId, userMessage: { parts: [{ text }] } }`，不是直接传字符串
> - **禁止操作**：不要删除 `cdp/inject.ts`，降级需要用
> - **隐藏依赖**：必须先调用 `rpcForConversation` 获取正确的 LS 实例，不能用 `rpc.call()` 直接调用
> - **测试失败的常见原因**：
>   - 忘记传 `cascadeId` 参数
>   - `userMessage.parts` 格式错误
>   - 没有等待 RPC 调用完成就返回

---

### Phase 3: 状态检测迁移

> **🗺️ 你在哪里**：Phase 2 完成，消息发送已用 RPC，但状态检测还在用 DOM 启发式
>
> **为什么现在做这个**：状态检测决定 UI 显示（loading/完成/错误），DOM 启发式不可靠，RPC 的 `status` 字段是权威来源
>
> **做完之后的状态**：状态检测混合模式（RPC 粗粒度 + CDP 细粒度），可靠性提升

**目标**：用 RPC `status` 字段替代部分 DOM 检测

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 3.1 | 添加 RPC 状态查询 | 在 `packages/server/src/monitor/phase.ts` 顶部导入 `rpcForConversation`，添加 `async function getRpcStatus(cascadeId: string)` 函数 | 函数存在 |
| 3.2 | 实现状态映射 | 在 `getRpcStatus()` 中调用 `GetCascadeTrajectory`，将返回的 `status` 映射到 `ResponsePhase` 枚举 | 映射逻辑正确 |
| 3.3 | 修改 updatePhases | 在 `packages/server/src/monitor/phase.ts` L280 的 `updatePhases()` 函数中，先调用 `getRpcStatus()`，如果成功则使用 RPC 状态，失败则回退到 DOM 检测 | 代码逻辑正确 |
| 3.4 | 添加混合模式日志 | 在状态更新时记录来源（RPC 或 CDP） | 日志显示 "Status from RPC" 或 "Status from CDP" |
| 3.5 | 测试 RPC 状态 | 启动 AG，发送消息，检查状态变化是否来自 RPC | 日志显示 "Status from RPC" |
| 3.6 | 测试 CDP 降级 | 停止 LS，检查状态检测是否回退到 DOM | 日志显示 "Status from CDP" 且状态正确 |

**状态映射表**:
```
CASCADE_RUN_STATUS_IDLE       → ResponsePhase.IDLE
CASCADE_RUN_STATUS_RUNNING    → ResponsePhase.GENERATING
CASCADE_RUN_STATUS_ERROR      → ResponsePhase.ERROR
CASCADE_RUN_STATUS_UNLOADED   → ResponsePhase.IDLE
```

**交付标准**：
- [ ] `packages/server/src/monitor/phase.ts` 实现混合模式
- [ ] RPC 状态优先，CDP 作降级
- [ ] 测试：RPC 可达时使用 RPC 状态
- [ ] 测试：RPC 不可达时使用 CDP 状态

> **⚠️ Phase 3 注意事项**：
> - **最容易出错的点**：`GetCascadeTrajectory` 需要传 `{ cascadeId }` 参数，不是空对象
> - **禁止操作**：不要删除 DOM 检测逻辑（L50-120），混合模式需要保留
> - **隐藏依赖**：RPC 状态是粗粒度的（IDLE/RUNNING/ERROR），细粒度状态（THINKING/APPROVAL_PENDING）仍需 CDP
> - **测试失败的常见原因**：
>   - 状态映射错误（如 RUNNING 映射到 IDLE）
>   - 没有处理 RPC 超时（应该回退到 CDP）
>   - 状态更新频率过高（应该缓存 RPC 结果）

---

### Phase 4: WebSocket Delta Polling

> **🗺️ 你在哪里**：Phase 3 完成，消息发送和状态检测已用 RPC，但步骤数据还在用 1s HTML 快照
>
> **为什么现在做这个**：这是最大的性能瓶颈（150KB/s 带宽），也是架构改造的核心，完成后带宽降低 80%、延迟降低 20x
>
> **做完之后的状态**：WebSocket 推送结构化 JSON 步骤（2-10KB），50ms 轮询，前端渲染 TrajectoryStep[]

**目标**：实现 50ms 轮询状态机，替代 1s 快照

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 4.1 | 创建 ws-poller 模块 | 创建 `packages/server/src/rpc/ws-poller.ts`，从 porta 复制 `packages/proxy/src/ws.ts` L1-576 的核心逻辑 | 文件存在，~580 行 |
| 4.2 | 修改 import | 将 porta 的 import 改为本项目路径，移除 `.js` 后缀 | TypeScript 编译通过 |
| 4.3 | 实现状态机 | 保留 `type PollState = "idle" | "active"`，实现 `enterActive()` 和 `enterIdle()` 函数 | 状态机逻辑正确 |
| 4.4 | 实现 fetchAndPush | 实现 `fetchAndPush(withOverlap: boolean)` 函数，调用 `GetCascadeTrajectorySteps` RPC | 函数返回步骤数组 |
| 4.5 | 实现重叠窗口 | 在 ACTIVE 模式下，`fetchOffset = lastStepCount - 20`（重取最后 20 步） | 计算逻辑正确 |
| 4.6 | 实现激活信号 | 创建 `packages/server/src/rpc/signals.ts`，导出 `conversationSignals` EventEmitter | 文件存在 |
| 4.7 | 连接 REST → WS | 在 `packages/server/src/api/interaction.ts` 的消息发送成功后，调用 `conversationSignals.emit("activate", cascadeId)` | 代码存在 |
| 4.8 | 修改 WebSocket 路由 | 在 `packages/server/src/index.ts` 中，将 WebSocket 升级逻辑改为调用 `setupWebSocket()` | WebSocket 连接成功 |
| 4.9 | 测试 IDLE 模式 | 连接 WebSocket，不发送消息，检查是否每 5s 收到心跳 | 收到 `{"type":"status","running":false}` |
| 4.10 | 测试 ACTIVE 模式 | 发送消息，检查是否立即进入 ACTIVE 模式（50ms 轮询） | 收到 `{"type":"status","running":true}` 和 `{"type":"steps",...}` |
| 4.11 | 测试去激活 | 等待消息完成，检查是否自动回到 IDLE | 收到 `{"type":"status","running":false}` |

**WebSocket 消息格式**:
```typescript
// 就绪消息
{"type":"ready","stepCount":10}

// 状态消息
{"type":"status","running":true}

// 步骤消息
{"type":"steps","offset":10,"steps":[{...},{...}]}
```

**交付标准**：
- [ ] `packages/server/src/rpc/ws-poller.ts` 实现完整
- [ ] `packages/server/src/rpc/signals.ts` 实现完整
- [ ] WebSocket 状态机正常工作（IDLE ↔ ACTIVE）
- [ ] 测试：ACTIVE 模式 50ms 轮询
- [ ] 测试：IDLE 模式 5s 心跳
- [ ] 测试：重叠窗口捕获状态变化

> **⚠️ Phase 4 注意事项**：
> - **最容易出错的点**：重叠窗口计算错误，`fetchOffset` 必须是 `Math.max(minFetchOffset, lastStepCount - 20)`，不能小于 `minFetchOffset`
> - **禁止操作**：不要删除 `loop/snapshot.ts`，UI 镜像功能还需要（Phase 7 才可选化）
> - **隐藏依赖**：
>   - `conversationSignals` 必须在 REST 和 WS 之间共享（单例）
>   - `minFetchOffset` 用于跳过损坏步骤，初始值 0，遇到错误后递增
> - **测试失败的常见原因**：
>   - 忘记调用 `conversationSignals.emit("activate")` 导致一直 IDLE
>   - 重叠窗口过大（>50）导致性能问题
>   - 没有处理步骤损坏错误（4MB 超限、UTF-8 无效）

---

### Phase 5: 前端适配

> **🗺️ 你在哪里**：Phase 4 完成，后端已推送 `steps` 消息，但前端还在解析 `snapshot_update`
>
> **为什么现在做这个**：后端数据格式变了，前端必须适配才能显示，这是打通全链路的最后一步
>
> **做完之后的状态**：前端同时支持旧 `snapshot_update` 和新 `steps` 消息，可以渲染 TrajectoryStep[]

**目标**：前端解析 `TrajectoryStep[]`，兼容旧格式

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 5.1 | 定义前端类型 | 在 `packages/web/src/types/index.ts` 导入 `@ag/shared` 的 `TrajectoryStep` 类型 | TypeScript 编译通过 |
| 5.2 | 修改 WebSocket hook | 在 `packages/web/src/hooks/useStepsStream.ts` 中，添加对 `{"type":"steps"}` 消息的处理 | 代码存在 |
| 5.3 | 实现步骤合并 | 维护 `steps` 数组，收到新消息时根据 `offset` 合并（替换重叠部分） | 合并逻辑正确 |
| 5.4 | 渲染 TrajectoryStep | 在 `packages/web/src/components/ChatPanel.tsx` 中，将 `TrajectoryStep[]` 转换为可渲染的消息格式 | UI 正常显示 |
| 5.5 | 保留旧格式兼容 | 保留对 `snapshot_update` 的处理，根据配置选择渲染方式 | 两种格式都能正常显示 |
| 5.6 | 测试新格式 | 启动前端，发送消息，检查是否显示步骤内容 | UI 显示正确 |
| 5.7 | 测试旧格式 | 关闭 RPC，检查是否回退到 Shadow DOM 渲染 | UI 显示正确 |

**交付标准**：
- [ ] `packages/web/src/hooks/useStepsStream.ts` 处理 `steps` 消息
- [ ] `packages/web/src/components/ChatPanel.tsx` 渲染 `TrajectoryStep[]`
- [ ] 测试：新格式正常显示
- [ ] 测试：旧格式兼容

> **⚠️ Phase 5 注意事项**：
> - **最容易出错的点**：步骤合并时，`offset=10, steps=[a,b,c]` 表示索引 10-12，不是 10-13
> - **禁止操作**：不要删除 Shadow DOM 渲染逻辑，兼容性需要
> - **测试失败的常见原因**：
>   - 步骤顺序错误（没有按 offset 排序）
>   - 重叠步骤没有替换（应该用新数据覆盖旧数据）

---

### Phase 6: OpenAI API 优化（可选）

> **🗺️ 你在哪里**：Phase 5 完成，核心功能已迁移到 RPC，但 OpenAI API 还在用 CDP 提取响应
>
> **为什么现在做这个**：OpenAI API 是外部集成的关键接口，用 RPC 可以提升性能和可靠性
>
> **做完之后的状态**：`/v1/chat/completions` 底层用 RPC，延迟降低 50%

**目标**：`/v1/chat/completions` 底层切换到 RPC

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 6.1 | 修改消息发送 | 在 `packages/server/src/api/openai-compat.ts` L164，将 `injectMessage()` 改为 `sendMessageWithFallback()` | 代码修改完成 |
| 6.2 | 修改响应提取 | 删除 L152 的 `CHAT_TEXT_SCRIPT` 调用，改为轮询 `GetCascadeTrajectorySteps` 提取 `PLANNER_RESPONSE` 步骤的 `content.text` | 代码逻辑正确 |
| 6.3 | 修改完成检测 | 将 L200+ 的 DOM 稳定性检测改为 RPC `status` 检测 | 完成检测正确 |
| 6.4 | 测试流式响应 | 调用 `/v1/chat/completions?stream=true`，检查是否正常流式返回 | SSE 流正常 |
| 6.5 | 测试非流式 | 调用 `/v1/chat/completions`，检查是否返回完整响应 | JSON 响应正确 |

**交付标准**：
- [ ] `packages/server/src/api/openai-compat.ts` 使用 RPC
- [ ] 测试：流式响应正常
- [ ] 测试：非流式响应正常
- [ ] 性能：延迟降低 >30%

> **⚠️ Phase 6 注意事项**：
> - **最容易出错的点**：`PLANNER_RESPONSE` 步骤可能有多个，需要按顺序拼接 `content.text`
> - **禁止操作**：不要删除 CDP 降级逻辑
> - **测试失败的常见原因**：流式响应没有正确处理增量（应该只发送新增文本）

---

### Phase 7: 清理与配置化

> **🗺️ 你在哪里**：Phase 6 完成，所有功能已迁移，但代码还有冗余
>
> **为什么现在做这个**：清理冗余代码，添加配置开关，让架构更清晰、更易维护
>
> **做完之后的状态**：代码精简，配置灵活，可以通过 `config.json` 控制 RPC/CDP 模式

**目标**：移除冗余代码，添加配置开关

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 7.1 | 删除旧发现逻辑 | 删除 `packages/server/src/loop/discovery.ts` | 文件不存在 |
| 7.2 | 精简快照循环 | 在 `packages/server/src/loop/snapshot.ts` 中，添加 `if (!config.cdp.enableSnapshot) return` 检查 | 代码存在 |
| 7.3 | 添加配置项 | 在 `packages/server/src/config.ts` 添加完整的 `rpc` 和 `cdp` 配置块 | 配置项存在 |
| 7.4 | 更新 README | 在 `README.md` 中添加 RPC 配置说明 | 文档更新 |
| 7.5 | 测试纯 RPC 模式 | 设置 `cdp.enableSnapshot: false`，检查是否正常工作 | 功能正常 |
| 7.6 | 测试纯 CDP 模式 | 设置 `rpc.enabled: false`，检查是否回退到 CDP | 功能正常 |

**配置示例**:
```json
{
  "rpc": {
    "enabled": true,
    "fallbackToCDP": true,
    "discoveryInterval": 10000,
    "activePollInterval": 50,
    "idlePollInterval": 5000
  },
  "cdp": {
    "enabled": true,
    "enableSnapshot": false,
    "ports": [9000, 9001, 9002, 9003]
  }
}
```

**交付标准**：
- [ ] `packages/server/src/loop/discovery.ts` 已删除
- [ ] 配置项完整且生效
- [ ] 测试：纯 RPC 模式正常
- [ ] 测试：纯 CDP 模式正常
- [ ] 文档更新

> **⚠️ Phase 7 注意事项**：
> - **最容易出错的点**：删除 `discovery.ts` 后，确保没有其他文件 import 它
> - **禁止操作**：不要删除 `cdp/` 目录，降级需要
> - **测试失败的常见原因**：配置项拼写错误导致不生效

---

## 5. 测试策略

### 测试归属规划

| 模块 | 单元测试 | 集成测试 | E2E 测试 |
|------|----------|----------|----------|
| rpc/discovery | ✅ Mock daemon 文件 | ✅ 真实 LS | ❌ |
| rpc/client | ✅ Mock HTTP 响应 | ✅ 真实 RPC 调用 | ❌ |
| rpc/routing | ✅ Affinity 缓存逻辑 | ✅ 多 LS 路由 | ❌ |
| rpc/ws-poller | ✅ 状态机转换 | ✅ 真实轮询 | ❌ |
| api/interaction | ❌ | ✅ 消息发送 | ✅ 完整流程 |
| api/openai-compat | ❌ | ✅ 流式响应 | ✅ OpenAI SDK |

### 每个 Phase 的测试检查点

**Phase 0**:
```bash
pnpm build  # 编译通过
grep "interface LSInstance" packages/server/src/rpc/types.ts  # 类型存在
```

**Phase 1**:
```bash
pnpm test packages/server/src/rpc/__tests__/discovery.test.ts
pnpm test packages/server/src/rpc/__tests__/client.test.ts
pnpm test packages/server/src/rpc/__tests__/routing.test.ts
# 集成测试：启动 AG，运行 node scripts/test-rpc-discovery.js
```

**Phase 2**:
```bash
# 启动服务器
pnpm dev:server
# 发送消息
curl -X POST http://localhost:3563/api/cascades/{id}/message -d '{"message":"test"}'
# 检查日志是否显示 "Using RPC for message"
```

**Phase 3**:
```bash
# 发送消息，检查状态变化
# 日志应显示 "Status from RPC: RUNNING"
```

**Phase 4**:
```bash
# 连接 WebSocket
wscat -c ws://localhost:3563/api/conversations/{id}/ws
# 应收到 {"type":"ready","stepCount":N}
# 发送消息后应收到 {"type":"status","running":true}
```

**Phase 5**:
```bash
pnpm dev:web
# 浏览器打开，发送消息，检查 UI 是否显示步骤
```

**Phase 6**:
```bash
curl -X POST http://localhost:3563/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test"}],"stream":true}'
# 应返回 SSE 流
```

**Phase 7**:
```bash
# 修改 config.json，设置 cdp.enableSnapshot: false
pnpm dev:server
# 检查日志是否显示 "Snapshot disabled"
```

### 回归验证清单

每个 Phase 完成后执行：

- [ ] `pnpm build` 编译通过
- [ ] `pnpm test` 所有测试通过
- [ ] 启动 AG 实例，服务器能发现 LS
- [ ] 发送消息成功
- [ ] WebSocket 连接正常
- [ ] 前端 UI 正常显示
- [ ] OpenAI API 正常响应
- [ ] 日志无错误

---

## 6. 风险与缓解

| 风险 | 等级 | 会在哪个 Phase 遇到 | 出了问题的表现 | 怎么处理 |
|------|------|-------------------|---------------|----------|
| **RPC API 不稳定** | 高 | Phase 1-6 | RPC 调用返回 500 错误 | 保留 CDP 降级；版本检测；社区反馈 |
| **LS 发现失败** | 高 | Phase 1 | `discoverInstances()` 返回空数组 | 检查 daemon 文件是否存在；手动配置端口 |
| **工作区路由错误** | 高 | Phase 1C, 2 | 消息发送到错误的 LS | 强制 workspace 验证；affinity 缓存 TTL |
| **步骤数据损坏** | 中 | Phase 4 | WebSocket 推送停止 | 步骤恢复机制；占位步骤；前端软刷新 |
| **性能回退** | 中 | Phase 4 | 轮询占用 CPU >50% | 调整轮询间隔；限制并发连接 |
| **前端兼容性** | 中 | Phase 5 | UI 显示错误或空白 | 渐进式迁移；保留 CDP 兼容层 |
| **类型冲突** | 低 | Phase 0, 5 | TypeScript 编译错误 | 检查类型导出；避免重复定义 |
| **Import 路径错误** | 低 | Phase 1 | 运行时 Module not found | 移除 `.js` 后缀；检查相对路径 |

---

## 7. 成功指标

| 指标 | 目标值 | 度量方式 |
|------|--------|----------|
| 消息发送延迟 | <100ms (p95) | 时间戳 diff |
| 状态更新延迟 | <100ms (p95) | phase_change 事件间隔 |
| WebSocket 带宽 | <20KB/s | 网络监控 |
| 跨版本兼容性 | >95% | AG 版本测试矩阵 |
| RPC 成功率 | >99% | RPC 调用日志统计 |
| CDP 降级率 | <5% | 降级日志统计 |
| 单元测试覆盖率 | >80% | Jest coverage report |
| 集成测试通过率 | 100% | CI 结果 |

---

## 8. 不在本期范围

- ❌ 完全移除 CDP（保留作为降级和 UI 镜像）
- ❌ 前端 UI 重构（仅适配新数据格式）
- ❌ 多用户权限管理
- ❌ 数据库持久化（仍使用内存 Map）
- ❌ 集群部署支持
- ❌ 性能监控面板
- ❌ 自动化 E2E 测试（手动测试为主）

---

## 9. 术语表（按遭遇顺序）

| 术语 | 通俗解释 | 你会在哪里遇到 |
|------|----------|----------------|
| **LSInstance** | 一个运行中的 Antigravity Language Server 实例，包含端口、PID、token 等信息 | Phase 0 类型定义 |
| **TrajectoryStep** | 对话中的一个步骤，可以是用户输入、工具调用、AI 响应等 | Phase 0 类型定义 |
| **Daemon File** | LS 启动时写入的发现文件，路径：`~/.gemini/antigravity/daemon/ls_*.json` | Phase 1A 发现逻辑 |
| **CSRF Token** | LS 的认证令牌，每次启动生成，用于 RPC 调用认证 | Phase 1A 发现逻辑 |
| **Connect RPC** | Antigravity 的 HTTP API，URL 格式：`POST /exa.language_server_pb.LanguageServerService/{方法}` | Phase 1B RPC 客户端 |
| **Transport Fallback** | 传输层回退，HTTPS 失败时自动尝试 HTTP | Phase 1B RPC 客户端 |
| **Affinity Cache** | 对话与工作区的绑定关系缓存，用于快速路由 | Phase 1C 路由逻辑 |
| **Workspace ID** | 工作区标识符，格式：`file___path_to_workspace`（路径中的 `/` 替换为 `_`） | Phase 1C 路由逻辑 |
| **Try-All Fallback** | 尝试所有 LS 实例，仅用于读操作，写操作禁止 | Phase 1C 路由逻辑 |
| **Cascade** | Antigravity 中的"对话"（conversation） | Phase 2 消息发送 |
| **SendUserCascadeMessage** | RPC 方法，用于发送用户消息 | Phase 2 消息发送 |
| **ResponsePhase** | 响应阶段枚举（IDLE, THINKING, GENERATING, COMPLETED, ERROR 等） | Phase 3 状态检测 |
| **Delta Polling** | 增量轮询，只获取新增数据（通过 offset 参数） | Phase 4 轮询逻辑 |
| **Overlap Window** | 重叠窗口，重取最后 N 步以捕获状态变化（默认 20） | Phase 4 轮询逻辑 |
| **Poll State** | 轮询状态，IDLE（5s 心跳）或 ACTIVE（50ms 轮询） | Phase 4 轮询逻辑 |
| **Conversation Signals** | 跨模块事件总线，用于 REST → WebSocket 激活通知 | Phase 4 轮询逻辑 |
| **Step Offset** | 步骤偏移量，表示从第几个步骤开始获取 | Phase 4 轮询逻辑 |
| **minFetchOffset** | 最小获取偏移量，用于跳过损坏步骤 | Phase 4 步骤恢复 |

---

## 10. 给执行者的常见问题（FAQ）

**Q1: 为什么要保留 CDP，不能完全用 RPC 吗？**
A: CDP 有两个不可替代的功能：(1) UI 镜像（Shadow DOM 渲染），RPC 无法提供完整 UI 视图；(2) 降级回退，RPC 不可达时保证基本功能。

**Q2: 什么时候用 `rpc.call()` vs `rpcForConversation()`？**
A: `rpc.call()` 用于无对话上下文的调用（如 `GetWorkspaceInfos`）；`rpcForConversation()` 用于对话相关调用，会自动路由到正确的 LS。

**Q3: 为什么写操作禁止 try-all？**
A: 多个 LS 可能加载同一个磁盘 `.pb` 文件，try-all 会导致写入错误的 LS，造成数据不一致。

**Q4: 重叠窗口为什么是 20？**
A: 经验值，覆盖大部分并发工具调用场景（<10 个），同时不会造成太大性能开销。可通过配置调整。

**Q5: 步骤损坏是什么情况？**
A: LS 返回的步骤数据可能超过 4MB protobuf 限制，或包含无效 UTF-8。遇到时注入占位步骤，跳过损坏数据。

**Q6: 为什么 ACTIVE 模式要等 5s 才能去激活？**
A: LS 在收到用户操作后可能短暂报告 IDLE 状态，5s 保护期防止过早去激活。

**Q7: 前端如何知道用哪种格式渲染？**
A: 根据收到的 WebSocket 消息类型：`snapshot_update` → Shadow DOM，`steps` → TrajectoryStep 列表。

**Q8: 如何调试 RPC 调用失败？**
A: 检查日志中的 RPC 错误码（`unauthenticated`, `unavailable`, `unknown`），对应不同的失败原因。

---

**文档版本**: v1.0.0
**最后更新**: 2026-03-23
**预计工期**: 20.5 天（约 4 周）
**审阅者**: 待定
**批准者**: 待定
