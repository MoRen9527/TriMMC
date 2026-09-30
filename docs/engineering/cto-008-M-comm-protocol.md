# CTO-008-M: TriMMC ↔ TriRLC 通信协议设计

| 属性       | 值                                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| 状态       | 设计完成 / 待实现                                                                |
| 版本       | v1.0.0                                                                           |
| 作者       | 小全执笔，小柯验证，小狄审核                                                     |
| 依赖       | `agent-core` 已就绪，`cto-008-c-shared-core` (C1/C2/C3) 完成                     |
| 最后更新   | 2026-04-28                                                                       |

## 1. 协议目标

本协议定义 **TriMMC（中央调度）** 与 **TriRLC（本地执行）** 之间的通信规约，支持三种运行模式的无缝切换：

| 模式                    | 适用场景                         | 核心行为                                          |
| ----------------------- | -------------------------------- | ------------------------------------------------- |
| **在线 ACN 代理**       | TriMMC 可达时                     | TriRLC 透明代理请求到 TriMMC，零本地智能            |
| **离线 localbus 升主**  | TriMMC 不可达时                   | TriRLC 降级为本机 Agent 引擎，独立执行              |
| **恢复 merge/冲突仲裁** | 离线→在线切换时                  | 将离线期间产生的事件/结果回放给 TriMMC，冲突时仲裁  |

---

## 2. 现状基线（已实现）

### 2.1 TriMMC 侧 (`TriMMC/src/server/app.ts`)

- **`GET /healthz`** — 返回 `{ ok: true, service: "trimc" }`
- **`GET /hello`** — 模型可用性探测，返回模型 greeting
- **`POST /internal/v1/chat`** — 单轮对话（简单模型调用）
- **`POST /internal/v1/agent`** — **核心入口**，参数：
  ```json
  {
    "model": "deepseek-v4-pro",
    "systemPrompt": "…",
    "messages": [{ "role": "user", "content": "…" }],
    "maxTurns": 25,
    "contract": { "agent": "ceo-chief-of-staff" },
    "tier": "main",
    "cwd": "/path/to/workspace"
  }
  ```
  - 支持 `?stream=true` (SSE) 和 JSON 模式
  - 支持 pipeline 组装（Soul Loader → Memory Injector → Context Builder → Tool Gater）当 `contract` 存在时
  - 兼容 legacy raw 模式（无 contract 时直接 agentLoop）

### 2.2 TriRLC 侧 (`TriRLC/src/server/app.ts`)

- **`GET /healthz`** — 返回 `{ ok: true, service: "trilc", trimc: "connected"|"degraded" }`
- **`POST /internal/v1/agent`** — 与 TriMMC 同签名的代理入口：
  - **connected 状态**：透明 proxy 到 TriMMC，pipe 响应流
  - **degraded 状态**：本地 agentLoop 直接执行，SSE/JSON 双模式
- `ConnectionManager` 已实现三态切换（`connected` → `degraded` ↔ `local`），配置：
  - `failThreshold = 3`（连续 3 次失败 → degraded）
  - `recoverThreshold = 2`（连续 2 次成功 → connected）
  - 健康检查间隔可配置（默认 10s）

---

## 3. 扩展协议设计

### 3.1 在线 ACN 代理（已有 + 增强）

当前透明 proxy 已工作，需增强以下点：

#### 3.1.1 请求头注入

TriRLC 代理到 TriMMC 时，注入 TriRLC 侧元数据：

```http
POST /internal/v1/agent?stream=true HTTP/1.1
X-TriRLC-Node-ID: {hostname}-{pid}
X-TriRLC-Version: 1.0.0
X-TriRLC-Connection-ID: {uuid}
Content-Type: application/json
```

- `X-TriRLC-Node-ID`：唯一标识本地节点（TriMMC 据此追踪多台 TriRLC）
- `X-TriRLC-Connection-ID`：本次连接会话 ID，用于恢复时回放
- `X-TriRLC-Version`：协议版本，TriMMC 据此判断兼容性

#### 3.1.2 Agent 响应元数据

TriMMC 在非流式 JSON 响应中附加元数据：

```json
{
  "ok": true,
  "turns": "completed",
  "sessionId": "tri-20260428-a1b2c3d4",
  "nodeId": "DESKTOP-ABC-12345",
  "events": [...]
}
```

- `sessionId`：TriMMC 侧分配的全局唯一会话 ID
- `nodeId`：回射 TriRLC 发送的 Node-ID

---

### 3.2 离线 localbus 事件队列

#### 3.2.1 架构

当 TriRLC 进入 `degraded` 状态后：

```
                    ┌─────────────┐
  本地 AgentLoop ──►│  Event Queue │──► 持久化到本地 SQLite
                    └─────────────┘
                          │
              (TriMMC 恢复后) replay
                          │
                          ▼
                    ┌─────────────┐
                    │   TriMMC     │
                    │  /internal/ │
                    │  v1/events/ │
                    │  replay     │
                    └─────────────┘
```

#### 3.2.2 事件队列数据模型

每个事件携带足够的上下文以便 TriMMC 侧重放：

```typescript
interface QueuedEvent {
  /** 全局唯一事件 ID */
  eventId: string; // "tri-20260428-a1b2c3d4-e001"
  /** 关联的 connectionId */
  connectionId: string;
  /** 事件类型 */
  type: "agent_run" | "task_complete" | "tool_call" | "state_change";
  /** 事件发生时的 wall clock */
  timestamp: number; // epoch ms
  /** 事件序号（单连接内单调递增） */
  sequenceNumber: number;
  /** 载荷 */
  payload: unknown;
}
```

#### 3.2.3 持久化

- 后端：本地 SQLite（`$TRILC_DATADIR/event-queue.db`）
- 表结构：

```sql
CREATE TABLE event_queue (
  event_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  seq_no INTEGER NOT NULL,
  payload TEXT NOT NULL,        -- JSON
  status TEXT DEFAULT 'pending', -- pending | replaying | replayed | failed
  retries INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_queue_status ON event_queue(status);
CREATE INDEX idx_queue_conn ON event_queue(connection_id, seq_no);
```

---

### 3.3 恢复 merge / 冲突仲裁

#### 3.3.1 恢复触发

当 `ConnectionManager` 从 `degraded` 恢复到 `connected` 时：

1. 暂停新请求代理（还在等待的请求继续走本地）
2. 开始事件队列回放
3. 回放完成后恢复透明代理模式

#### 3.3.2 TriMMC 侧新增端点

```http
POST /internal/v1/events/replay
Content-Type: application/json

{
  "nodeId": "DESKTOP-ABC-12345",
  "connectionId": "uuid-xxx",
  "events": [
    { "eventId": "...", "type": "agent_run", "timestamp": 1714300000000, "seqNo": 1, "payload": {...} },
    { "eventId": "...", "type": "task_complete", "timestamp": 1714300001000, "seqNo": 2, "payload": {...} }
  ]
}
```

响应：

```json
{
  "ok": true,
  "accepted": 2,
  "conflicts": [],
  "lastSeqNo": 2
}
```

#### 3.3.3 冲突仲裁策略

当 TriMMC 发现离线期间有冲突时（如同一 taskId 同时被 TriMMC 分配给了其他在线 TriRLC 节点）：

| 冲突类型               | 仲裁策略                             | 触发条件                                         |
| ---------------------- | ------------------------------------ | ------------------------------------------------ |
| **任务双重分配**       | TriMMC 侧 winner-takes-last           | 同一 taskId 在离线期间被分配给了其他在线节点      |
| **状态版本落后**       | TriMMC 侧 apply-offline-changes       | 离线节点的状态版本号 < TriMMC 当前版本号           |
| **工具调用幂等冲突**   | TriMMC 侧标记为 `already_executed`    | 同一幂等键的工具调用已由其他节点执行              |
| **无冲突**             | TriMMC 侧直接合并                     | 离线期间无其他节点操作同一资源                    |

**冲突响应格式**：

```json
{
  "ok": true,
  "accepted": 1,
  "conflicts": [
    {
      "eventId": "tri-...-e003",
      "type": "task_complete",
      "resolution": "rejected_duplicate",
      "reason": "taskId xyz was reassigned to node-B while node-A was offline",
      "currentOwner": "node-B"
    }
  ],
  "lastSeqNo": 3
}
```

#### 3.3.4 离线窗口上限

- 事件队列最大保留 **1 小时** 的离线事件（可配置 `TRILC_QUEUE_TTL_MINUTES`）
- 超过 TTL 的未回放事件标记为 `expired`，写入日志后丢弃
- 离线超过 6 小时的三态切换到 `local`（手动恢复）

---

### 3.4 localbus（本地消息总线）

#### 3.4.1 设计动机

当前 TriRLC ↔ TriMMC 仅通过 HTTP 通信；在离线模式下需要一种**进程内+本机 IPC**机制来：

- 发布/订阅本地状态变更（`task:started`、`task:succeeded`、`task:failed`）
- 本地模块间解耦（planner ↔ daemon ↔ local-node）
- 待恢复后批量上传状态变更到 TriMMC

#### 3.4.2 实现方案

**Phase 1（当前阶段）**：`EventEmitter` 内存总线

```typescript
// TriRLC/src/localbus/bus.ts
import { EventEmitter } from "node:events";

export type LocalBusEvent =
  | { type: "task:queued"; taskId: string }
  | { type: "task:running"; taskId: string }
  | { type: "task:succeeded"; taskId: string; result: unknown }
  | { type: "task:failed"; taskId: string; error: string }
  | { type: "node:connected" }
  | { type: "node:degraded" }
  | { type: "node:local" }
  | { type: "agent:event"; event: AgentEvent };

// Singleton bus shared by daemon, planner, and event-queue
export const localBus = new EventEmitter<{ event: [LocalBusEvent] }>();
```

- 优势：零依赖，性能高，毫秒级订阅/发布
- 局限：进程内通信，不跨进程（当前阶段足够）

**Phase 2（TriMMC 正式宿主后）**：升级为 Unix Domain Socket / Named Pipe：

```
TriRLC (app process) ──UDS──► TriRLC (localbus daemon) ──HTTP──► TriMMC
```

- 支持多个 TriRLC 子进程共享同一 localbus
- 与 TriMMC 侧的 `TRISTACISS_BASE_URL` 和 `OPENCLOW_GATEWAY_URL` 对齐

---

### 3.5 心跳增强

#### 3.5.1 当前心跳

- TriRLC `ConnectionManager.checkHealth()`：GET TriMMC `/healthz`，每 10s
- 仅检查可达性，不携带任何元数据

#### 3.5.2 增强心跳

```http
POST /internal/v1/heartbeat
Content-Type: application/json

{
  "nodeId": "DESKTOP-ABC-12345",
  "state": "connected",
  "queueSize": 0,
  "uptimeSeconds": 3600,
  "agentCoreVersion": "0.14.0"
}
```

TriMMC 响应：

```json
{
  "ok": true,
  "serverTime": 1714300000000,
  "nodeId": "DESKTOP-ABC-12345",
  "commands": []
}
```

- `commands`：TriMMC 可下发的指令队列（如 `replay_now`、`switch_connection`、`shutdown`、`drain_queue`）
- 心跳间隔：`10s`（活跃时）、`30s`（空闲时，通过 `heartbeat_ack` 动态协商）

---

## 4. 端点全景

| 端点                              | 方法  | 提供方  | 用途                       | 状态       |
| --------------------------------- | ----- | ------- | -------------------------- | ---------- |
| `/healthz`                        | GET   | 双方    | 健康检查                   | ✅ 已实现  |
| `/internal/v1/agent`              | POST  | TriMMC   | Agent 执行（pipeline 模式）| ✅ 已实现  |
| `/internal/v1/agent`              | POST  | TriRLC   | Agent 代理/本地回退        | ✅ 已实现  |
| `/internal/v1/chat`               | POST  | TriMMC   | 单轮对话                   | ✅ 已实现  |
| `/internal/v1/tasks`              | POST  | TriMMC   | 任务提交                   | ✅ 骨架    |
| `/internal/v1/heartbeat`          | POST  | TriMMC   | 增强心跳                   | 📋 已设计 |
| `/internal/v1/events/replay`      | POST  | TriMMC   | 离线事件回放               | 📋 已设计 |

---

## 5. 实现计划

### 5.1 优先级拆分

| 步骤 | 内容                                           | 估时   | 负责人     |
| ---- | ---------------------------------------------- | ------ | ---------- |
| M.1  | 事件队列 (`event-queue.ts` + SQLite 持久化)    | 2h     | 小全       |
| M.2  | 恢复 replay 端点 (`/internal/v1/events/replay`)| 1.5h   | 小全       |
| M.3  | localbus 内存总线 (`localbus/bus.ts`)          | 1h     | 小全       |
| M.4  | 增强心跳 (`/internal/v1/heartbeat` + commands) | 1.5h   | 小全       |
| M.5  | 冲突仲裁逻辑 (TriMMC 侧)                        | 2h     | 小柯       |
| M.6  | 集成测试（在线→离线→恢复全流程）               | 2h     | 小柯       |
| M.7  | 代码审查 + code-state.md 更新                  | 1h     | 小狄       |

**预估总时：11h**

### 5.2 依赖关系

```
M.1 (事件队列) ──┬──► M.2 (replay 端点) ──► M.5 (冲突仲裁) ──► M.6 (集成测试) ──► M.7 (审核)
                │
                └──► M.3 (localbus) ──┘
                │
                └──► M.4 (增强心跳) ──┘
```

- M.1、M.3、M.4 可并行
- M.2 依赖 M.1
- M.5 依赖 M.2
- M.6 依赖 M.1-M.5
- M.7 依赖 M.6

---

## 6. 兼容性说明

- **TriRLC 单机模式**：即使 TriMMC 永不可达，TriRLC 仍可通过 `agentLoop` 本地执行——不依赖协议实现
- **新旧协议共存**：TriRLC 注入的 `X-TriRLC-Version` 头允许 TriMMC 降级响应
- **队列格式版本**：`event_queue` 表预留 `schema_version` 列用于未来迁移
- **向后兼容**：所有新增端点为附加，不修改现有 `/healthz` 和 `/internal/v1/agent` 行为

---

## 7. 风险与缓解

| 风险                         | 概率 | 影响 | 缓解措施                                       |
| ---------------------------- | ---- | ---- | ---------------------------------------------- |
| 离线事件队列膨胀             | 中   | 低   | TTL 1h + 硬上限 10k 事件 → 触发告警             |
| 冲突仲裁逻辑复杂度过高       | 低   | 中   | 先实现最简单的 winnner-takes-last，后续迭代     |
| SQLite 写入阻塞主循环        | 低   | 中   | 异步 WAL 模式 + batch insert                    |
| 恢复 replay 期间 TriMMC 再次断连 | 中   | 中   | 断点续传：replay 返回 `lastSeqNo`，续传未完成的  |

---

## 8. 附录：ConnectionManager 生命周期

```
     ┌──────────┐
     │   start  │
     └────┬─────┘
          ▼
   ┌────────────┐   N consecutive failures    ┌───────────┐
   │ connected  │ ──────────────────────────► │ degraded  │
   └────────────┘                             └─────┬─────┘
          ▲                                         │
          │          N consecutive successes        │
          └─────────────────────────────────────────┘
                                                     │
                                          (离线 > 6h)
                                                     │
                                                     ▼
                                              ┌──────────┐
                                              │  local   │ (需手动恢复)
                                              └──────────┘
```

- `connected → degraded`：`failThreshold` 次连续失败（默认 3）
- `degraded → connected`：`recoverThreshold` 次连续成功（默认 2） + 事件队列回放完成
- `degraded → local`：离线超过 `offlineLimitMinutes`（默认 360min）
- `local → connected`：仅手动 `POST /admin/reconnect`
