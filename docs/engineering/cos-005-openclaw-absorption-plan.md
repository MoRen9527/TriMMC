# COS-005: openclaw 吸收链规划 — 守护进程与定时任务

> 状态：APPROVED（COS-005 交付，CTO 小狄，2026-07-16）
> 吸收源：`reference/openclaw-v2026.3.28`
> 目标模块：TriMMC（后端服务层）
> 前置依赖：CTO-003（Claude Code 吸收 Tier 1 ✅）、CTO-008-C（共享核心 ✅）

---

## 1. 吸收范围界定

### 1.1 应吸收（in scope）

| 源目录 | 功能 | 吸收理由 |
|--------|------|----------|
| `src/cron/` | CronService — 定时任务调度引擎 | CEO 明确要求"周工作平移这类定时任务"；当前 TriMMC 无任何定时调度能力 |
| `src/cron/heartbeat-policy.ts` | 心跳投递策略（心跳 OK 摘要，跳过纯心跳投递） | 作为 TriMMC 任务执行心跳的基础策略 |
| `src/cron/schedule.ts` | Cron 表达式解析 + 缓存（基于 croner） | 调度核心，不依赖 openclaw 特有 channel |
| `src/process/supervisor/` | ProcessSupervisor — 受管子进程生命周期 | TriMMC sub-agent spawning 已有 supervisor 概念，可增强 |
| `src/infra/backoff.ts` | 退避重试工具 | 通用基础设施，调度任务执行失败重试需要 |
| `src/cron/store.ts` + `store.test.ts` | Job 持久化存储层 | 任务数据需要在 TriMMC 重启后保留 |
| `src/cron/types.ts` | CronJob / CronJobCreate / CronSchedule 类型 | 调度系统的类型契约 |
| `src/cron/stagger.ts` | 错峰调度工具 | 避免多个定时任务在同一时刻触发导致资源尖刺 |

### 1.2 应参考（不直接吸收，作为设计参考）

| 源目录 | 功能 | 处理方式 |
|--------|------|----------|
| `src/daemon/` | 跨平台服务管理（launchd/systemd/schtasks） | 设计参考；K8s deployment 已覆盖服务生命周期，单机场景吸收 daemon 概念但不直接移植 |
| `src/entry.respawn.ts` | 进程崩溃自动重启 | 设计参考；K8s restartPolicy + liveness probe 已覆盖 |
| `src/process/command-queue.ts` | 通道命令队列（lane-based） | 仅参考 lane 设计模式；TriMMC 已有自己的 agent-loop lane 抽象 |
| `src/process/kill-tree.ts` | 进程树终止 | 参考实现；triLC local execution 需要 |
| `src/polls.ts` | 社交投票（Telegram/Discord） | **不吸收** — 这是 social channel 功能，与定时任务无关 |

### 1.3 不吸收

| 源文件 | 理由 |
|--------|------|
| `src/cron/isolated-agent/` | 依赖 openclaw channel/agent runtime，不可脱离 |
| `src/cron/delivery.ts` | 依赖 openclaw 消息投递通道 |
| `src/cron/service/delivery*.ts` | 同上 |
| `src/cron/session-reaper.ts` | 依赖 openclaw session 管理 |
| `src/daemon/launchd.ts` / `systemd.ts` / `schtasks.ts` | K8s 已覆盖生产部署；后续单机部署时才按需吸收 |

---

## 2. 现状差距分析

### 2.1 TriMMC 已有能力

| 能力 | 当前实现 | 成熟度 |
|------|----------|--------|
| HTTP 服务器（Express/Node） | `src/server/` | L2 — 可运行 |
| Agent Loop | `src/agent-loop/loop.ts` | L3 — 已通过 smoke test |
| Sub-agent 管理 | `src/agent-loop/sub-agent/` | L2 — 基本 spawn 能力 |
| IPD 案例心跳 | `src/heartbeat/` (Python) | L1 — 仅 IPD 案例卡顿检测 |
| Pipeline 装配 | `src/pipeline/` | L2 — build/test pipeline |
| Healthz 端点 | `/healthz:8710` (K8s probes) | L3 — 生产可用 |
| K8s 部署 | `k8s/trimc/` (5 manifests) | L3 — APPROVED |

### 2.2 TriMMC 缺失能力

| 缺失能力 | 影响 | 吸收优先级 |
|----------|------|------------|
| **定时任务调度** | 无法自动执行周度平移、每日收口等周期性任务 | **P0** |
| **Job 执行引擎** | 任务无法被调度、执行、重试、记录结果 | **P0** |
| **Job 持久化** | 重启后任务列表丢失 | **P0** |
| **受管子进程监管** | sub-agent 执行缺少统一的生命周期管理 | P1 |
| **退避/重试机制** | 任务失败后无自动重试 | P1 |
| **守护进程管理** | 仅在 K8s 环境可管理；单机开发/测试需手动启停 | P2 |

---

## 3. 吸收架构设计

### 3.1 目标架构

```
┌─────────────────────────────────────────────────┐
│                    TriMMC Server                   │
│  ┌───────────────┐  ┌─────────────────────────┐  │
│  │ Agent Loop    │  │  Task Scheduler (NEW)    │  │
│  │ (CTO-008-C)   │  │  ┌─────────────────┐    │  │
│  │               │  │  │ Cron Engine     │    │  │
│  │ sub-agent ────┼──┼─→│ (schedule/parse)│    │  │
│  │ spawn         │  │  └────────┬────────┘    │  │
│  │               │  │           ↓              │  │
│  │               │  │  ┌─────────────────┐    │  │
│  │               │  │  │ Job Store       │    │  │
│  │               │  │  │ (SQLite/JSON)   │    │  │
│  │               │  │  └────────┬────────┘    │  │
│  │               │  │           ↓              │  │
│  │               │  │  ┌─────────────────┐    │  │
│  │ ◄─────────────┼──┼──│ Job Executor    │    │  │
│  │               │  │  │ (task-controller)│    │  │
│  │               │  │  └────────┬────────┘    │  │
│  └───────────────┘  │           ↓              │  │
│                     │  ┌─────────────────┐    │  │
│  ┌──────────────┐   │  │ Backoff/Retry   │    │  │
│  │ Heartbeat    │   │  │ (absorbed from  │    │  │
│  │ (IPD cases)  │   │  │  openclaw infra)│    │  │
│  └──────────────┘   │  └─────────────────┘    │  │
│                     └─────────────────────────┘  │
│  ┌──────────────────────────────────────────┐    │
│  │  Process Supervisor (NEW)                │    │
│  │  - Managed spawn/cancel/kill             │    │
│  │  - Timeout enforcement                   │    │
│  │  - Scope-based lifecycle management      │    │
│  │  - Run registry (history)                │    │
│  └──────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

### 3.2 模块落点

| 吸收模块 | TriMMC 落点 | 说明 |
|----------|-----------|------|
| Cron Engine | `src/scheduler/cron-engine.ts` | 基于 croner 的表达式解析 + 下次触发时间计算 |
| Job Store | `src/scheduler/job-store.ts` | 任务持久化（当前阶段用 JSON 文件，后续迁移 SQLite） |
| Job Executor | `src/scheduler/job-executor.ts` | 触发任务 → 执行 → 记录结果 → 重试 |
| Backoff | `src/scheduler/backoff.ts` | 退避策略（固定/指数/抖动） |
| Stagger | `src/scheduler/stagger.ts` | 错峰调度 |
| Heartbeat Policy | `src/scheduler/heartbeat-policy.ts` | 任务执行心跳判定 |
| Process Supervisor | `src/process-supervisor/` | 受管子进程管理（增强 sub-agent spawn） |

### 3.3 现有模块整合

- **`src/agent-loop/sub-agent/spawn.ts`** → 接入 Process Supervisor 的 `spawn()` 方法
- **`src/task-controller/`** → 接入 Job Executor 作为任务执行的统一入口
- **`src/heartbeat/`（Python）** → 保持 IPD 案例检测职责不变；新增 TS 侧 `src/scheduler/heartbeat-policy.ts` 负责任务执行心跳

---

## 4. 实现阶段

### Phase 1: 调度核心（P0，预计 3-4h）

**目标**：TriMMC 具备定时任务调度能力，支持"周度平移"类周期性任务。

| 步骤 | 内容 | 吸收源文件 | 产出 |
|------|------|-----------|------|
| P1.1 | Cron 表达式解析 + 下次触发时间计算 | `cron/schedule.ts` | `src/scheduler/cron-engine.ts` |
| P1.2 | Job 类型定义（CronJob, CronSchedule） | `cron/types.ts`, `types-shared.ts` | `src/scheduler/types.ts` |
| P1.3 | Job Store 持久化（JSON 文件，含迁移逻辑） | `cron/store.ts`, `store-migration.ts` | `src/scheduler/job-store.ts` |
| P1.4 | Job Executor 核心（调度循环 + 执行 + 记录） | `cron/service/timer.ts`, `cron/service/jobs.ts` | `src/scheduler/job-executor.ts` |
| P1.5 | Stagger 错峰调度 | `cron/stagger.ts` | `src/scheduler/stagger.ts` |
| P1.6 | 单元测试（schedule 解析、store 读写、executor 触发） | 吸收源测试 | `src/scheduler/__tests__/` |

**门禁**：
- [ ] cron 表达式解析正确（覆盖 5/10/30 分钟，每日，每周，每月）
- [ ] Job 可通过 CLI/API 创建、列出、删除
- [ ] Job 到时间后自动触发，触发后状态正确记录
- [ ] 重启后 Job 列表不丢失
- [ ] `pnpm test -- src/scheduler/` 全部通过

### Phase 2: 执行可靠性（P1，预计 2-3h）

**目标**：任务执行具备退避重试、心跳监控和错误处理能力。

| 步骤 | 内容 | 吸收源文件 | 产出 |
|------|------|-----------|------|
| P2.1 | Backoff 退避工具（固定/指数/抖动） | `infra/backoff.ts` | `src/scheduler/backoff.ts` |
| P2.2 | Heartbeat Policy（心跳 OK 判定 + 跳过纯心跳投递） | `cron/heartbeat-policy.ts` | `src/scheduler/heartbeat-policy.ts` |
| P2.3 | Job 执行重试集成（失败 → backoff → 重试 → 最终失败告警） | — | 增强 `job-executor.ts` |
| P2.4 | 集成测试（调度 → 执行失败 → 重试 → 成功 / 最终失败） | — | `src/scheduler/__tests__/integration.test.ts` |

**门禁**：
- [ ] 任务失败后按 backoff 策略自动重试
- [ ] 超过最大重试次数后标记 FAILED 并记录
- [ ] Heartbeat 策略正确判定"跳过"vs"投递"
- [ ] 集成测试覆盖完整调度→重试→终态链路

### Phase 3: 进程监督（P1，预计 2-3h）

**目标**：受管子进程具备统一的生命周期管理和超时控制。

| 步骤 | 内容 | 吸收源文件 | 产出 |
|------|------|-----------|------|
| P3.1 | ProcessSupervisor 核心（spawn/cancel/kill/scope） | `process/supervisor/supervisor.ts` | `src/process-supervisor/supervisor.ts` |
| P3.2 | Run Registry（进程执行记录） | `process/supervisor/registry.ts` | `src/process-supervisor/registry.ts` |
| P3.3 | 超时策略（overall-timeout + no-output-timeout） | `process/supervisor/supervisor.ts` | 集成到 supervisor |
| P3.4 | sub-agent spawn 接入 supervisor | — | 修改 `src/agent-loop/sub-agent/spawn.ts` |
| P3.5 | 单元测试 | 吸收源测试 | `src/process-supervisor/__tests__/` |

**门禁**：
- [ ] supervisor 可 spawn 子进程、cancel、kill
- [ ] scope 级别的批量取消正常
- [ ] 超时检测正确触发
- [ ] sub-agent 通过 supervisor spawn，行为与当前一致
- [ ] 不影响现有 CTO-008-C 测试（11 tests）

### Phase 4: 服务管理（P2，预计 1-2h）

**目标**：单机开发/测试场景的守护进程管理（K8s 生产已覆盖）。

| 步骤 | 内容 | 吸收源文件 | 产出 |
|------|------|-----------|------|
| P4.1 | 抽象 service manager 接口（start/stop/restart/status） | `daemon/service.ts` pattern | `src/daemon/service-manager.ts` |
| P4.2 | Windows 单机支持（schtasks，作为 K8s 补充） | `daemon/schtasks.ts` (参考) | `src/daemon/windows-service.ts` |
| P4.3 | CLI 命令：`triMC service start/stop/status` | — | `src/cli/service.ts` |

**门禁**：
- [ ] Windows 单机 `triMC service start` 可启动 TriMMC 后台进程
- [ ] `triMC service stop` 优雅终止
- [ ] K8s 部署不受影响

---

## 5. 总预计工时与里程碑

| 阶段 | 预计工时 | 累计 | 里程碑说明 |
|------|----------|------|-----------|
| Phase 1 | 3-4h | 4h | 定时任务调度能力就绪 |
| Phase 2 | 2-3h | 7h | 执行可靠性就绪 |
| Phase 3 | 2-3h | 10h | 进程监督就绪 |
| Phase 4 | 1-2h | 12h | 单机服务管理就绪 |

**里程碑 1（P0 ready）**：Phase 1 完成 → 可创建"周度平移"cron job，TriMMC 自动在每周一触发平移

**里程碑 2（P1 ready）**：Phase 1+2+3 完成 → 定时任务具备生产级可靠性（重试 + 监督 + 心跳）

**里程碑 3（完整）**：Phase 1-4 完成 → TriMMC 可脱离 K8s 在单机以守护进程方式运行

---

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| openclaw cron 模块深度依赖其 channel/gateway runtime | 中 | Phase 1 只吸收 schedule/store/timer 核心，不触碰 isolated-agent/delivery |
| croner 库与 TriMMC 依赖兼容性 | 低 | croner 是纯 cron 解析库，零依赖；已在 openclaw 生产环境验证 |
| 现有 sub-agent spawn 接入 supervisor 后行为变化 | 中 | Phase 3 改动点最小化，先并行跑逐步切换 |
| 单机 service 管理与 K8s 双轨维护 | 低 | 抽象 service-manager 接口，K8s 和单机是同一接口的不同实现 |

---

## 7. 决策记录

| 决策 | 结论 | 依据 |
|------|------|------|
| 是否吸收 daemon 全套（launchd/systemd/schtasks） | 不直接吸收，仅参考 | K8s 已覆盖生产环境服务生命周期 |
| 是否吸收 delivery 模块 | 不吸收 | 依赖 openclaw 消息通道，TriMMC 无此通道 |
| 任务存储方案 | 先用 JSON 文件，后续迁 SQLite | 最小 MVP 原则；JSON 文件符合当前阶段 |
| cron 库选择 | 使用 croner（与 openclaw 一致） | openclaw 已验证，npm 周下载量 50万+ |
| heartbeat 模块归属 | Python 侧不变（IPD 案例检测）；新增 TS 侧（任务执行心跳） | 职责分离，不混合 |

---

## 8. 关联文档

- CTO-003 Claude Code 吸收 Tier 1: `TriCompany/docs/engineering/cto-003-claude-code-absorption.md`
- CTO-008-C 共享核心: `TriMMC/docs/engineering/cto-008-C-shared-core.md`
- CTO-008-M 通信协议: `TriMMC/docs/engineering/cto-008-M-comm-protocol.md`
- TriMMC code-state: `TriMMC/docs/registry/code-state.md`
- 吸收源: `TriMetaverse/reference/openclaw-v2026.3.28/src/cron/`, `src/process/supervisor/`, `src/infra/backoff.ts`
