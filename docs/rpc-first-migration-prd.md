# Antigravity Pilot RPC-First 架构迁移 PRD

> PRD Version: 0.1.0 | Date: 2026-04-04 | Status: Draft

---

## ⚡ 读前必看 — 给执行者的全局地图

### 一句话概括

将 Antigravity Pilot 的会话管理、消息流、前端渲染从 **CDP DOM 黑客 + RPC 混合架构** 迁移到 **RPC-First + CDP 可选增强**，参照 `porta` 项目的已验证方案。

### 拆之前 vs 拆之后

```
拆之前（当前）:
┌─────────────────────────────────────────────┐
│  @ag/server                                 │
│  ┌──────────┐  ┌─────────────┐              │
│  │ CDP 模块  │←→│ CascadeMap  │ (hash↔UUID) │
│  │ (75 调用) │  │ (fragile)   │              │
│  └──────┬───┘  └──────┬──────┘              │
│         │             │                      │
│  session.ts        cascade.ts                │
│  (510行 DOM脚本)  (22行 cdp ref)             │
│         │             │                      │
│  interaction.ts    ws-poller.ts              │
│  (840行 CDP交互)  (637行 手动protobuf)       │
└─────────────────────────────────────────────┘
  问题: 会话找不到/切换失败/消息卡死/状态不准

拆之后（目标）:
┌─────────────────────────────────────────────┐
│  @ag/server                                 │
│  ┌──────────────────────────┐               │
│  │ RPC 核心 (所有业务逻辑)  │               │
│  │ conversations.ts (NEW)   │               │
│  │ ws-poller.ts (重构)      │               │
│  │ step-recovery.ts (NEW)   │               │
│  │ message-tracker.ts (NEW) │               │
│  │ metadata.ts (NEW)        │               │
│  └──────────────────────────┘               │
│  ┌──────────┐                               │
│  │ CDP Lite │ (仅: 截图/点击/样式注入)      │
│  │ (可选)   │                               │
│  └──────────┘                               │
└─────────────────────────────────────────────┘
  结果: 会话可靠发现/消息不卡死/状态精确
```

### Phase 执行顺序（依赖链）

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
(基础设施)  (会话API)  (消息流)    (前端)     (CDP降级)
```

### 每个 Phase 一句话说明

| Phase | 名称 | 做什么 | 预估工时 |
|-------|------|--------|---------|
| 0 | 基础设施 | 移植 Porta 的 4 个辅助模块到 server | 0.5 天 |
| 1 | 会话管理 RPC 化 | 新建 conversations API，替代 CDP DOM 脚本 | 1-2 天 |
| 2 | 消息流优化 | 重构 ws-poller，加入 step-recovery | 1-2 天 |
| 3 | 前端 RPC 化 | 重写 Sidebar/ChatPanel 使用 RPC 数据源 | 2-3 天 |
| 4 | CDP 降级 | CDP 标记为可选增强，废弃 session.ts | 0.5 天 |

### 最重要的一条规则

**每个 Phase 必须保持现有功能完整可用** — 不能出现 "先拆后建" 导致中间状态不可用的情况。所有新 API 是 **增量添加**，前端逐步切换数据源。

### 关键概念科普

| 概念 | 含义 |
|------|------|
| **LS (Language Server)** | Antigravity IDE 内置的 gRPC 服务，提供 `GetAllCascadeTrajectories`、`GetCascadeTrajectorySteps` 等 RPC |
| **CDP (Chrome DevTools Protocol)** | 连接 IDE 的 Electron 窗口，执行 JS 脚本操纵 DOM |
| **CascadeMap** | 当前将 CDP 窗口 hash 映射到 RPC UUID 的桥接层 |
| **Trajectory / Steps** | LS 中一次对话的全部步骤（用户输入/AI响应/工具调用等） |
| **Warm-up** | 触发 LS 从磁盘 `.pb` 文件加载会话到内存的技术 |
| **Step Recovery** | 跳过 LS 无法序列化的步骤（>4MB / UTF-8 损坏）的容错机制 |

---

## 1. 背景与动机

### 1.1 现状

项目总规模：**52 个服务端 TS 文件（~10,800 行）**，**37 个前端 TS/TSX 文件（~7,200 行）**，全项目 **~17,979 行**。

核心模块行数：

| 模块 | 文件 | 行数 | CDP 调用数 |
|------|------|------|-----------|
| RPC 层 | `rpc/*.ts` | 1,819 | 0 |
| API 路由 | `api/*.ts` | 3,700 | 75 |
| CDP 层 | `cdp/*.ts` | 1,092 | ~10 |
| Store 层 | `store/*.ts` | 317 | 0 |
| 前端 hooks | `hooks/*.ts` | 773 | 0 |
| 前端 stores | `stores/*.ts` | 334 | 0 |

CDP 调用分布：`interaction.ts` 20 处、`session.ts` 14 处、`cascade.ts` 12 处、`autoaction/index.ts` 7 处。

### 1.2 痛点

1. **会话发现不可靠** — `session.ts` L23-92 用 CSS 选择器猜测 DOM 结构，IDE 版本更新即断裂
2. **会话切换靠点击** — `session.ts` L222-266 用 `el.click()` + `setTimeout(500ms)`，高失败率
3. **ID 映射脆弱** — `cascadeMap.ts` L109 靠窗口标题推断 workspace，多窗口场景错配
4. **消息卡死/丢失** — `ws-poller.ts` L222-309 手动解析 protobuf oneof，无错误恢复
5. **侧边栏状态不准** — `cascadeStore.ts` 只含 CDP 窗口，看不到历史/磁盘会话
6. **新建会话靠 CDP** — `interaction.ts` L746-770 点击 DOM 按钮，不稳定
7. **模型切换靠 CDP** — `session.ts` L339-436 点击下拉菜单，3 步 CDP 调用容易失败

### 1.3 目标

**核心原则**：
1. 会话 CRUD 全部通过 LS RPC — 不依赖 DOM 结构
2. 消息流添加容错 — 不因单步损坏而卡死
3. CDP 降级为可选增强 — 仅用于截图/样式/点击透传
4. 渐进式迁移 — 每个 Phase 独立可交付

---

## 2. 设计原则

1. **RPC 优先** — 任何能用 LS RPC 实现的功能，不用 CDP
2. **容错不阻塞** — 单步损坏跳过，不卡死整个会话
3. **增量切换** — 新旧 API 并存，前端逐步迁移
4. **参照验证** — 每个模块参照 Porta 的已验证实现
5. **最小表面** — 只移植 Porta 中解决已知问题的模块，不搬运无关功能

---

## 3. 模块架构设计

### 3.1 依赖关系总图

```
@ag/server
├── rpc/
│   ├── discovery.ts       (现有, 保留)
│   ├── client.ts          (现有, 保留)
│   ├── routing.ts         (现有, 增强)
│   ├── ws-poller.ts       (现有, 重构 Phase 2)
│   ├── step-recovery.ts   (新建 Phase 0, 来自 Porta)
│   ├── metadata.ts        (新建 Phase 0, 来自 Porta)
│   ├── message-tracker.ts (新建 Phase 0, 来自 Porta)
│   ├── conversation-mutations.ts (新建 Phase 0, 来自 Porta)
│   └── signals.ts         (现有, 保留)
├── api/
│   ├── conversations.ts   (新建 Phase 1, 来自 Porta)
│   ├── cascade.ts         (现有, Phase 4 清理)
│   ├── session.ts         (现有, Phase 4 废弃)
│   ├── interaction.ts     (现有, Phase 4 部分清理)
│   └── ...                (其余保留)
└── cdp/                   (Phase 4: 标记为可选)
```

### 3.2 新模块详情

| 模块 | 来源 (Porta) | 行数 | 改动要点 |
|------|-------------|------|---------|
| `rpc/step-recovery.ts` | `step-recovery.ts` | 76 | import 路径改为 `./client` |
| `rpc/metadata.ts` | `metadata.ts` | 56 | `ideName` → `"antigravity-pilot"` |
| `rpc/conversation-mutations.ts` | `conversation-mutations.ts` | 29 | 无改动，直接复制 |
| `rpc/message-tracker.ts` | `message-tracker.ts` | 162 | import 路径适配 |
| `api/conversations.ts` | `routes/conversations.ts` | 635 | Hono→Express 语法转换 |

---

## 4. 执行计划

### Phase 0: 基础设施

> **🗺️ 你在哪里**：项目初始状态，所有功能通过 CDP+RPC 混合工作
>
> **为什么现在做这个**：Phase 1-2 依赖这些辅助模块——就像建房子前先浇地基
>
> **做完之后的状态**：4 个 Porta 辅助模块已移植到 `packages/server/src/rpc/`，但尚未被任何代码引用

**目标**：移植 Porta 的 4 个基础模块

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 0.1 | 复制 step-recovery | 从 `porta/packages/proxy/src/step-recovery.ts` 复制到 `packages/server/src/rpc/step-recovery.ts`，将 `import { RPCError } from "./rpc.js"` 改为 `import { RPCError } from "./client"`，将 `import ... from "./routing.js"` 改为 `from "./routing"`，同理 discovery | `npx tsc --noEmit` 无报错 |
| 0.2 | 复制 metadata | 从 Porta `metadata.ts` 复制到 `packages/server/src/rpc/metadata.ts`，`ideName` 改为 `"antigravity-pilot"` | 同上 |
| 0.3 | 复制 conversation-mutations | 直接复制到 `packages/server/src/rpc/conversation-mutations.ts` | 同上 |
| 0.4 | 复制 message-tracker | 复制并修正 import 路径 | 同上 |
| 0.5 | 确认 RPCError | 检查 `rpc/client.ts` 是否导出 `RPCError` 类，若无则从 Porta `rpc.ts` 提取 | grep 确认 export |

**交付标准**：`pnpm --filter @ag/server exec tsc --noEmit` 通过

> **⚠️ Phase 0 注意事项**：
> - **最容易出错**：Porta 用 `.js` 后缀（ESM），Pilot 不需要后缀
> - **禁止操作**：不要修改现有文件 — 这些模块在 Phase 0 无人引用
> - **RPCError 检查**：`grep -n "export.*RPCError" packages/server/src/rpc/client.ts`

---

### Phase 1: 会话管理 RPC 化

> **🗺️ 你在哪里**：Phase 0 完成，辅助模块就位
>
> **为什么现在做这个**：会话发现和切换不可靠是所有痛点的根源
>
> **做完之后的状态**：`GET/POST /api/conversations` 等完整 REST API 可用

**目标**：新建 `api/conversations.ts`

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 1.1 | 创建路由文件 | 参照 Porta `routes/conversations.ts` L111-635，新建 `packages/server/src/api/conversations.ts`，用 Express Router 格式。实现：`GET /api/conversations`（含磁盘扫描+warm-up）、`GET /api/conversations/:id`、`GET /api/conversations/:id/steps`（含 step-recovery L271-332）、`POST /api/conversations`（StartCascade）、`POST /api/conversations/:id/messages`（SendUserCascadeMessage）、`POST /api/conversations/:id/stop` | `curl localhost:3456/api/conversations` 返回 JSON |
| 1.2 | 注册路由 | `index.ts` L60-63 之后添加 conversations 路由 import | 启动无报错 |
| 1.3 | 增强 routing.ts | 从 Porta `routing.ts` L86-168 移植 `discoverOwnerInstance` 函数（如缺少） | conversations 的 steps 端点正确路由 |

**交付标准**：新旧 API 并存，`/api/conversations` 和 `/api/conversations/history` 都可用

> **⚠️ Phase 1 注意事项**：
> - **Hono→Express 转换**：`c.req.param("id")` → `req.params.id`，`c.json(data)` → `res.json(data)`，`c.json(data, 201)` → `res.status(201).json(data)`
> - **禁止操作**：不要删除 `cascade.ts` L56-119 的 `/api/conversations/history`
> - **磁盘路径**：确认 `~/.gemini/antigravity/conversations/` 存在：`ls ~/.gemini/antigravity/conversations/*.pb | head -5`

---

### Phase 2: 消息流优化

> **🗺️ 你在哪里**：Phase 1 完成，会话 API 可用
>
> **为什么现在做这个**：消息卡死是第二大痛点
>
> **做完之后的状态**：ws-poller 遇到损坏步骤时跳过而非卡死

**目标**：集成 step-recovery 到 ws-poller

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 2.1 | 引入 step-recovery | `ws-poller.ts` 顶部添加 import，在 `fetchAndPush` 的 catch 块（约 L400-430）添加 oversized/UTF-8 检测和跳过逻辑 | 日志可见 `Skipping corrupted` 而非挂起 |
| 2.2 | 引入 message-tracker | 导入 `messageTracker`，步骤推送时调用 `annotateSteps()` | 发送后前端可见 `_pending` |
| 2.3 | 引入 conversation-mutations | 发送消息路由中包装 `runConversationMutation` 防止并发写入 | 快速连续发送不导致乱序 |

**交付标准**：ws-poller 在遇到损坏步骤时跳过并继续

> **⚠️ Phase 2 注意事项**：
> - **最容易出错**：修改 `fetchAndPush` catch 块时注意不打破外层 try-catch 结构
> - **禁止操作**：不要改变 WS 消息格式 `{ type: "steps", steps, offset }` — 前端依赖它
> - **测试**：制造一个很长的对话，观察是否卡死

---

### Phase 3: 前端 RPC 化

> **🗺️ 你在哪里**：服务端 RPC API 完整
>
> **为什么现在做这个**：前端仍在用 CDP 数据源
>
> **做完之后的状态**：Sidebar 显示完整会话列表，ChatPanel 不依赖 cascadeStore

**目标**：前端迁移到 RPC 数据源

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 3.1 | 新建 useConversations hook | `packages/web/src/hooks/useConversations.ts`，调用 `GET /api/conversations` | hook 返回包含磁盘历史会话的列表 |
| 3.2 | ChatPanel 切换数据源 | `ChatPanel.tsx` L419-446 改用新 API | 会话下拉框显示完整列表 |
| 3.3 | 新建/发消息走 RPC | 前端调用 `POST /api/conversations` 和 `POST /api/conversations/:id/messages` | 无 CDP 也能新建和发消息 |
| 3.4 | 停止走 RPC | 调用 `POST /api/conversations/:id/stop` | 停止在无 CDP 时可用 |

**交付标准**：核心功能（查看/切换/新建/发送/停止）全部通过 RPC

> **⚠️ Phase 3 注意事项**：
> - **类型适配**：新 API 返回 `trajectorySummaries` (Porta格式) vs 现有 `ConvSummary` — 需要映射
> - **禁止操作**：不要删除 `ChatViewport` (Shadow DOM) — Phase 4 处理
> - **回归测试**：`grep -rn "useCascadeStore" packages/web/` 列出所有引用逐个处理

---

### Phase 4: CDP 降级

> **🗺️ 你在哪里**：前端已使用 RPC 数据源
>
> **为什么现在做这个**：收尾 — 清理不再需要的 CDP 依赖
>
> **做完之后的状态**：CDP 标记为可选，`session.ts` 废弃

| 步骤 | 任务 | 具体操作 | 怎么验证做对了 |
|------|------|----------|---------------|
| 4.1 | session.ts 标记废弃 | 顶部加 `@deprecated` 注释，启动时 `console.warn` | 启动看到 deprecation 警告 |
| 4.2 | config 添加 cdp.optional | `config.ts` 增加 `cdp.optional` 布尔开关 | `cdp.optional: true` 时服务正常 |
| 4.3 | CDP API 添加可用性检查 | `cascade.ts` L181-408 的 CDP API 在不可用时返回 503 | CDP 关闭时返回 503 而非 500 |
| 4.4 | 更新 README | 标注 RPC-First 为默认模式 | README 反映新架构 |

**交付标准**：`cdp.optional: true` 时系统完整运行（除截图/文件预览外）

> **⚠️ Phase 4 注意事项**：
> - **autoaction 依赖**：`autoaction/index.ts` (206行) 的 auto-accept 靠 CDP 点击 — 需用 `HandleCascadeUserInteraction` RPC 替代
> - **禁止操作**：不要删除 `session.ts` — 标记废弃即可

---

## 5. 测试策略

每个 Phase 完成后执行：

```bash
# 类型检查
pnpm --filter @ag/server exec tsc --noEmit

# 服务启动
pnpm --filter @ag/server dev

# 会话列表 (Phase 1+)
curl -s http://localhost:3456/api/conversations | jq '.trajectorySummaries | keys | length'

# 历史兼容
curl -s http://localhost:3456/api/conversations/history | jq '.conversations | length'
```

---

## 6. 风险与缓解

| 风险 | 等级 | Phase | 出了问题的表现 | 怎么处理 |
|------|------|-------|--------------|---------|
| RPCError 类型不兼容 | 中 | 0 | tsc 编译失败 | 从 Porta `rpc.ts` 提取 RPCError 类 |
| Hono→Express 遗漏 | 中 | 1 | 路由返回 undefined | 逐行对照检查 |
| ws-poller 回归 | 高 | 2 | 前端不再收到消息 | 仅在 catch 块添加 recovery |
| cascadeStore 下游多 | 高 | 3 | 前端组件崩溃 | grep 列出所有引用 |
| autoaction CDP 依赖 | 中 | 4 | auto-accept 失效 | 用 HandleCascadeUserInteraction RPC |

---

## 7. 成功指标

| 指标 | 目标值 | 度量方式 |
|------|--------|---------|
| 会话发现成功率 | 100% | `/api/conversations` 返回数 ≥ LS 内存 + 磁盘 |
| 会话切换延迟 | <100ms | 切换到步骤加载完成时间 |
| 消息卡死次数 | 0 | ws-poller 日志 |
| CDP 不可用功能完整率 | ≥90% | 仅截图/文件预览不可用 |

---

## 8. 不在本期范围

- Porta 的 search/files/workspaces 路由
- 前端完全重写为 Porta 风格 UI
- OpenAI 兼容 API / Push 通知改动

---

## 9. 术语表

| 术语 | 通俗解释 | 在哪里遇到 |
|------|---------|-----------|
| LS RPC | 对 IDE Language Server 的远程调用 | 全程 |
| step-recovery | 跳过损坏步骤的容错 | Phase 0/2 |
| warm-up | LS 预加载磁盘会话 | Phase 1 |
| conversation-mutations | 写操作串行锁 | Phase 0/1 |
| message-tracker | 消息乐观 UI 标注 | Phase 0/2 |
| CascadeMap | CDP hash↔UUID 映射(将弱化) | Phase 3/4 |

---

## 10. FAQ

**Q1: Porta 代码可以直接复制？** A: Phase 0 的 4 模块可近乎直接复制。Phase 1 需 Hono→Express 转换。

**Q2: 现有前端会崩溃吗？** A: 不会。新 API 是增量添加，现有 API 保持不变。

**Q3: CDP 关掉后丢什么？** A: 截图、Shadow DOM 镜像、样式注入、文件预览、点击透传。

**Q4: autoaction 能用 RPC？** A: 可以。Porta `conversations.ts` L510-600 的 `HandleCascadeUserInteraction` 支持。

**Q5: LS 没启动怎么办？** A: 返回空列表 + 磁盘扫描结果（状态 UNLOADED）。

**Q6: warm-up 有负载风险？** A: 无。用 `stepOffset: 999999` 只触发加载，返回 ~28 bytes，有 60s TTL。

**Q7: 为什么不直接 fork Porta？** A: Pilot 有 Porta 没有的功能：密码认证、PWA、OpenAI API、auto actions。

**Q8: Phase 可以跳过？** A: Phase 0 必须先做。Phase 1/2 可并行。Phase 3 依赖 1/2，Phase 4 依赖 3。
