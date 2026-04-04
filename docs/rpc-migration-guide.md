# RPC-First 架构迁移 执行指南

## 全局地图

### 一句话概括

将 Antigravity Pilot 的会话管理（发现/切换/新建）和消息流从 CDP DOM 黑客迁移到 LS RPC 直连，参照 Porta 已验证方案，共 24 条任务，分 5 个 Phase。

### Phase 依赖链

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
(基础设施)   (会话API)   (消息流)    (前端)     (CDP降级)
  #1-#6       #7-#9      #10-#13    #14-#19    #20-#24
```

### 每个 Phase 一句话说明

| Phase | 做什么 | 为什么先做它 | 完成后的状态 |
|-------|--------|-------------|-------------|
| P0 (6 条) | 移植 Porta 4 个辅助模块 | Phase 1-2 的代码依赖这些模块 | 4 个新 .ts 文件在 rpc/，无人引用 |
| P1 (3 条) | 新建 conversations REST API | 会话发现不可靠是最大痛点 | /api/conversations 可用，与旧 API 并存 |
| P2 (4 条) | ws-poller 集成 step-recovery | 消息卡死是第二大痛点 | 损坏步骤被跳过而非卡死 |
| P3 (6 条) | 前端 8 个文件从 cascadeStore 迁移到 RPC | 前端仍用 CDP 数据源 | Sidebar/ChatPanel 显示完整会话列表 |
| P4 (5 条) | CDP 标记可选，session.ts 废弃 | 收尾清理 | cdp.optional: true 时系统正常运行 |

### 最重要的规则

**每个 Phase 必须通过回归验证 + git commit 后才能进入下一个 Phase**。不允许跨 Phase 并行。

---

## Phase 0: 基础设施

> 🗺️ 你在哪里：项目初始状态，所有功能通过 CDP+RPC 混合工作
> 做完之后的状态：4 个 Porta 辅助模块已移植到 `packages/server/src/rpc/`，但**尚未被任何代码引用**

本 Phase 的任务：#1 ~ #6

### 核心操作

从 Porta 复制 4 个文件到 Pilot：

| 源文件 (Porta) | 目标文件 (Pilot) | 行数 | 需改动 |
|----------------|-----------------|------|--------|
| `proxy/src/step-recovery.ts` | `server/src/rpc/step-recovery.ts` | 76 | 3 处 import 路径去 `.js` 后缀 |
| `proxy/src/metadata.ts` | `server/src/rpc/metadata.ts` | 56 | `ideName` 改为 `antigravity-pilot` |
| `proxy/src/conversation-mutations.ts` | `server/src/rpc/conversation-mutations.ts` | 29 | 无改动 |
| `proxy/src/message-tracker.ts` | `server/src/rpc/message-tracker.ts` | 162 | 无改动 |

**⚠️ 本 Phase 注意事项**：
- **最容易出错**：Porta 的 import 用 `.js` 后缀（ESM 规范），Pilot 不需要。step-recovery.ts 有 3 处需要修正：`./rpc.js` → `./client`，`./routing.js` → `./routing`，`./discovery.js` → `./discovery`
- **禁止操作**：不要修改任何现有文件——这些新模块在 Phase 0 无人引用，改了现有文件只会引入风险
- **RPCError 已确认**：`packages/server/src/rpc/client.ts` L306 已导出 `RPCError` 类 ✅
- **metadata/conversation-mutations/message-tracker 零外部依赖**：直接复制即可

---

## Phase 1: 会话管理 RPC 化

> 🗺️ 你在哪里：Phase 0 完成，4 个辅助模块就位但无人引用
> 做完之后的状态：`GET/POST /api/conversations` 等完整 REST API 可用，与旧 `/api/conversations/history` 并存

本 Phase 的任务：#7 ~ #9

### 核心操作

新建 1 个文件 `api/conversations.ts`（~635 行），修改 1 个文件 `index.ts`（加 3 行）。

参照源：`porta/packages/proxy/src/routes/conversations.ts`

### Hono → Express 语法转换速查表

| Porta (Hono) | Pilot (Express) |
|-------------|----------------|
| `c.req.param("id")` | `req.params.id` |
| `c.req.query("offset")` | `req.query.offset` |
| `c.json(data)` | `res.json(data)` |
| `c.json(data, 201)` | `res.status(201).json(data)` |
| `c.text("msg", 404)` | `res.status(404).send("msg")` |
| `c.req.raw.json()` | `req.body` (Express 有 json middleware) |
| `app.get("/path", ...)` | `router.get("/path", ...)` |

**⚠️ 本 Phase 注意事项**：
- **禁止删除旧 API**：`cascade.ts` L56-119 的 `/api/conversations/history` 必须保留——前端当前依赖它
- **磁盘会话路径**：`metadata.ts` 中 `CONVERSATIONS_DIR` = `~/.gemini/antigravity/conversations/`（已确认存在 .pb 文件）
- **discoverOwnerInstance 已存在**：Pilot 的 `routing.ts` L71 已有该函数 ✅ 不需要额外移植
- **共 31 处 Hono 语法需转换**——逐行对照，不要批量替换

---

## Phase 2: 消息流优化

> 🗺️ 你在哪里：Phase 1 完成，conversations API 可用
> 做完之后的状态：ws-poller 遇到损坏步骤时跳过而非卡死，消息发送有串行锁

本 Phase 的任务：#10 ~ #13

### 核心操作

修改 1 个文件 `ws-poller.ts`（添加 import + 改 catch 块），修改 1 个文件 `conversations.ts`（包装 mutations）。

### ws-poller.ts catch 块位置

```
L440:  } catch (err) {     ← 这是主 catch 块，在这里添加 step-recovery
L459:  } catch {            ← enrichment catch，不动
L477:  } catch {            ← 不动
L537:  } catch {            ← 不动
L584:  } catch {            ← 不动
L615:  } catch {}           ← 不动
```

**⚠️ 本 Phase 注意事项**：
- **最容易出错**：ws-poller.ts 有 6 个 catch 块，只改 L440 的主 catch
- **禁止操作**：不要改变 WS 消息格式 `{ type: "steps", steps, offset }` —— 前端 `useStepsStream.ts` (171 行) 直接解析这个格式
- **测试方法**：找一个步数较多的长对话，确认加载不卡死

---

## Phase 3: 前端 RPC 化

> 🗺️ 你在哪里：服务端 RPC API 完整（conversations + step-recovery + mutations）
> 做完之后的状态：前端核心功能（查看/切换/新建/发送/停止）全部通过 RPC，Sidebar 显示完整会话列表

本 Phase 的任务：#14 ~ #19

### 核心操作

新建 1 个文件 `useConversations.ts`，修改 6 个前端文件。

### useCascadeStore 引用清单（23 处，8 个文件）

| 文件 | 引用行 | 迁移方式 |
|------|--------|---------|
| `cascadeStore.ts` | L24 (定义) | 保留——store 本身不删除 |
| `ChatPanel.tsx` | L7, L419 | #15 迁移 |
| `CascadeList.tsx` | L6, L48-50 | #18 迁移 |
| `AppShell.tsx` | L7, L40-41 | #18 迁移 |
| `ChatView.tsx` | L3, L24-25 | #18 迁移 |
| `App.tsx` | L13, L28 | #18 迁移 |
| `MessageInput.tsx` | L7, L59 | #16 迁移 |
| `DrawerActions.tsx` | L5, L21 | #16 迁移 |
| `useWebSocket.ts` | L5, L11/29/44 | 暂保留——负责实时推送 |

**⚠️ 本 Phase 注意事项**：
- **类型适配**：新 API 返回 `{ trajectorySummaries: Record<string, {...}> }`，需在 `useConversations.ts` 中转换为数组格式
- **禁止操作**：不要删除 `ChatViewport`（Shadow DOM 镜像）——它的 CDP 依赖在 Phase 4 处理
- **useWebSocket.ts 保留**：它的 cascadeStore 引用负责 WS 实时推送（L11: setCascades, L29: setQuota, L44: setPhase），Phase 4+ 再清理
- **回归测试**：迁移一个文件后立即 tsc 验证，不要等全部改完

---

## Phase 4: CDP 降级

> 🗺️ 你在哪里：前端已使用 RPC 数据源，核心功能不依赖 CDP
> 做完之后的状态：CDP 标记为可选增强，`cdp.optional: true` 时系统正常运行（除截图/文件预览外）

本 Phase 的任务：#20 ~ #24

### 核心操作

修改 4 个文件（session.ts, config.ts, cascade.ts, README.md），新增 1 个配置项。

### CDP 功能保留清单

| CDP 功能 | 保留/废弃 | 原因 |
|---------|----------|------|
| 截图 (capture/html.ts) | 保留 | 无 RPC 替代 |
| 样式注入 (cdp/simplify.ts) | 保留 | 无 RPC 替代 |
| 点击透传 (interaction.ts /click) | 保留 | 无 RPC 替代 |
| 文件预览 (cascade.ts /active-file) | 保留 + 503 守卫 | 无 RPC 替代 |
| 会话发现 (session.ts) | 废弃 | 已被 /api/conversations 替代 |
| 会话切换 (session.ts /switch) | 废弃 | 已被 /api/conversations 替代 |
| 模型选择 (session.ts /model) | 废弃 | 可通过 RPC 参数传递 |
| Auto-accept (autoaction/index.ts) | 需 RPC 替代 | 用 HandleCascadeUserInteraction |

**⚠️ 本 Phase 注意事项**：
- **autoaction 依赖**：`autoaction/index.ts` (206 行) 的 auto-accept 目前通过 CDP 点击按钮实现（L97-121，5 处 cdp.call）。需要用 `HandleCascadeUserInteraction` RPC 替代，但这个改造比较大，可以作为后续优化单独处理
- **禁止操作**：不要删除 `session.ts` —— 标记 `@deprecated` 即可
- **CdpConfig 当前字段**：`enabled: boolean; enableSnapshot: boolean; ports: number[]`（L73-77），添加 `optional: boolean` 即可

---

## 常见问题

### Q1: 我怎么知道 LS 是否在运行？
运行 `curl -s localhost:3456/api/status | jq .`，检查是否有 LS instance 信息。或者 `ls ~/.gemini/daemon/` 查看 daemon 文件。

### Q2: 复制 Porta 文件时 import 报错怎么办？
检查 3 点：①是否去掉了 `.js` 后缀 ②`RPCError` 是否从 `./client` 导入（不是 `./rpc`）③`LSInstance` 类型是否从 `./discovery` 导入。

### Q3: conversations API 返回空列表？
可能原因：①LS 未启动（`getInstances()` 返回空）②磁盘路径不对（检查 `~/.gemini/antigravity/conversations/`）。空列表不应报错，应返回 `{ trajectorySummaries: {} }`。

### Q4: 前端迁移后会话列表为空？
检查 `useConversations` hook 的 fetch URL 是否正确（`/api/conversations` 不是 `/api/conversations/history`），以及返回数据格式的转换是否正确（`Record<string, ...>` → 数组）。

### Q5: ws-poller 改了 catch 块后消息不来了？
最可能原因是 catch 块的新代码抛出了未捕获异常。在 step-recovery 逻辑外层再包一层 try-catch，失败时 fallback 到原来的行为。

### Q6: cdp.optional: true 后服务崩溃？
检查 `cdp/discovery.ts` 是否在 `optional: true` 时跳过了 CDP 连接。启动流程中 `discover()` 函数（index.ts L200）不应在 CDP 关闭时报错。

### Q7: autoaction 的 auto-accept 在 CDP 关闭后失效？
预期行为——Phase 4 不改 autoaction。如需 RPC 替代，参照 Porta `conversations.ts` L510-600 的 `HandleCascadeUserInteraction`，作为后续任务处理。

### Q8: Phase 1 和 Phase 2 可以并行吗？
理论上可以（它们都只依赖 Phase 0），但建议串行——Phase 2 的 `conversations.ts` 修改（#12）依赖 Phase 1 创建的文件。
