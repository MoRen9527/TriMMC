# CTO-008-C: TriMMC/TriRLC 共享核心抽象方案

版本：V1.0
日期：2026-07-15
状态：FINAL（CEO 已确认）
作者：CTO 小狄

## 1. 分析结论

### 当前状态

| 维度 | TriMMC | TriRLC | 差距 |
|------|-------|-------|------|
| 文件数 | 42 files (17 modules) | 10 files (9 modules) | **4.2:1** |
| agent-loop | Phase 2 完整实现（while-true + streaming + 3-tier error recovery + permissions-engine + sub-agent spawn） | **无** | **致命缺口** |
| model client | `trimodel` 依赖 | **无模型依赖** | **致命缺口** |
| contracts | AgentContract v1 + resolver + TaskEnvelope | NodeRegistration only | **严重缺口** |
| tools | 6 个 built-in tools（read_file / write_file / edit_file / shell_exec / glob_search / task） | **无** | **致命缺口** |
| 成熟度 | Phase 2 全量完成 70/70 tests pass | 占位 stub | — |

**结论**：TriRLC 当前不是"共享核心后差异化"，而是**根本没有 agent 能力**。CTO-008-C 的本质是把 TriMMC 已验证的 agent-loop 核心抽象为独立包，让 TriRLC 从零实现改为"导入共享核心 + 本地适配"。

---

## 2. 共享面 vs 差异面

### 共享面（应提取到 `@trimetaverse/agent-core`）

| 模块 | TriMMC 现状 | 共享理由 | 风险 |
|------|-----------|----------|------|
| `agent-loop/loop.ts` | ~300 行 async generator | 核心 while-true + streaming + error recovery，TriRLC 离线退化必须用到 | 与 TriMMC 内部模块（context-builder / prompt-cache / tool-gater）耦合需解耦为注入接口 |
| `agent-loop/tools.ts` | registry 模式（register + getToolDefinitions + executeTool） | 提供工具注册抽象；具体 6 个 tool 不纳入共享包，由消费方注入 | 低 — registry 模式已是干净抽象 |
| `agent-loop/permissions.ts` | tier 体系（main / subagent / coordinator） | 离线退化时 TriRLC 也需要 tier 限制 | 低 |
| `agent-loop/permissions-engine/` | 4 文件（decision-pipeline / rule-parser / safety-check / types） | 离线模式下仍需权限控制 | 低 — 已模块化 |
| `agent-loop/sub-agent/` | 4 文件（built-in / spawn / tools-resolve / types） | 离线模式下 TriRLC 需自行 spawn 子代理 | 中 — spawnAgent 依赖 modelClient 需注入 |
| `contracts/` | AgentContract v1 + resolver + TaskEnvelope | TriRLC 完全缺失，通信协议（CTO-008-M）的前置依赖 | 低 |
| `types/`（部分） | permissions-engine/types.ts + sub-agent/types.ts | Tier/Permission 类型 | 低 |

### 差异面（各自保留）

**TriMMC 独有**（server/gateway 面）：
- `server/` — HTTP server + SSE endpoint
- `observability/` — 9 文件，benchmark + timeline + postgres
- `pipeline/` — assemble
- `policy-gate/` — shell 策略
- `prompt-cache/` — cache-control
- `context-builder/` — 上下文组装
- `soul-loader/` — soul 加载
- `memory-injector/` — 记忆注入
- `task-controller/` — 任务控制
- `node-bridge/` — OpenClaw 桥接
- `heartbeat/` — Python daemon
- `config/env.ts` — TriMMCEnv（server-oriented）

**TriRLC 独有**（local 面）：
- `local-node/` — 本地节点管理（7 行 stub，需在共享核心上重建）
- `context-adapter/` — 本地上下文适配
- `planner/` — 本地规划器（5 行 stub，需在共享核心上重建）
- `runtime/daemon.ts` — 本地守护进程（11 行 stub，需在共享核心上重建）
- `task-runtime/` — 本地任务状态
- `toolbus/` — 本地工具总线
- `wallet-upgrade/` — 钱包升级

---

## 3. 方案选型（已定案）

### 决策：TriMMC workspace 子包 `packages/agent-core`

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| **TriMMC workspace 子包** | ① 代码所有权 TriMMC（架构上游）② TriRLC 只引用子目录，不拉整个 TriMMC ③ `file:` 协议开发期零耦合 ④ PC 端打包时随 TriRLC bundle ⑤ 不新建仓库，不破坏独立仓架构 | TriRLC 开发时需 TriMMC 仓库在本地 — 但这是 CTO-008-M 通信协议的前置条件，本就必需 | ✅ **CEO 已确认** |
| 独立仓库 TriAgentCore | 独立版本号，跨仓平等 | ① 多一个仓库维护 ② TriMMC/TriRLC/TriAgentCore 三角依赖升级复杂 ③ 与 trimodel 的 `file:` 协议模式不一致 | ❌ |
| 放 TriRLC 仓库 | TriRLC 离线绝对独立 | 架构反向：服务器端 TriMMC 依赖本地端仓库，所有权错位 | ❌ |

### 物理布局

```
TriMMC/
├── packages/
│   └── agent-core/           ← 共享核心（npm workspace 子包）
│       ├── package.json       "name": "@trimetaverse/agent-core", "version": "0.1.0"
│       └── src/
│           ├── agent-loop/    loop.ts（解耦注入）+ tools.ts（registry 抽象）
│           ├── permissions/   permissions.ts + permissions-engine/
│           ├── sub-agent/     spawn.ts + types.ts
│           ├── contracts/     AgentContract v1 + resolver + TaskEnvelope
│           └── types/         共享类型
├── src/                       ← TriMMC 自身（server/observability/pipeline/...）
└── package.json               pnpm workspace root（子包: packages/agent-core）
├── TriRLC/
│   └── package.json           "devDependencies": { "@trimetaverse/agent-core": "file:../TriMMC/packages/agent-core" }
```

### 离线场景保证

- **`file:` 是编译时依赖**：TriRLC `npm install` / `pnpm install` 时将 agent-core 代码复制到 `node_modules`，构建时编译进 TriRLC bundle
- **运行时零网络依赖**：TriMMC 服务器崩了不影响 TriRLC 已 bundle 的 agent-loop 能力
- **类比**：TriRLC 将同样以 `"trimodel": "file:../TriModel"` 依赖模型客户端，无人担心 TriModel 挂了 TriRLC 就不能调模型
- **PC 端分发**：CTO-008-P 打包时 agent-core 随 TriRLC 一起 bundle 到安装包，不出现在用户可见的文件系统路径

### 实施路径

```
Phase C1: 创建 packages/agent-core（Week 1）
├── 在 TriMMC/ 内创建 packages/agent-core/
├── 从 TriMMC/src/agent-loop/ 提取共享模块
│   ├── loop.ts：解耦 context-builder/prompt-cache/tool-gater → AgentLoopDeps 注入接口
│   ├── tools.ts：保留 registry 模式，6 个具体 tool 迁出
│   ├── permissions.ts + permissions-engine/ → 完整迁移
│   ├── sub-agent/ → 完整迁移（spawnAgent 注入 modelClient）
│   ├── contracts/ → 完整迁移
│   └── types/ → 提取共享类型（permissions + sub-agent）
├── packages/agent-core/package.json: "name": "@trimetaverse/agent-core", "version": "0.1.0"
├── TriMMC/package.json → pnpm workspace root（packages: ["packages/*"]）
└── 70 个已有测试从 TriMMC 迁移到 agent-core，保持全绿

Phase C2: TriMMC 适配（Week 1-2）
├── TriMMC/src/agent-loop/loop.ts → re-export from @trimetaverse/agent-core
├── context-builder / prompt-cache / tool-gater 作为 AgentLoopDeps 注入实现
├── 6 个 built-in tools 保留在 TriMMC/src/agent-loop/tools.ts（通过 registry 注册）
└── 70 tests 保持全绿

Phase C3: TriRLC 适配（Week 2）
├── TriRLC/package.json: "devDependencies": { "@trimetaverse/agent-core": "file:../TriMMC/packages/agent-core", "trimodel": "file:../TriModel" }
├── local-node/node.ts → 基于 agentLoop() + AgentLoopDeps 实现
├── planner/planner.ts → 使用 sub-agent 系统
├── runtime/daemon.ts → agentLoop 驱动
└── 从零补齐 TriRLC 测试
```

### 解耦接口设计（agent-loop → 消费方注入）

当前 loop.ts 硬依赖 `context-builder`、`prompt-cache`、`tool-gater`。提取到 agent-core 时改为注入接口：

```typescript
// agent-core 内部
export interface AgentLoopDeps {
  buildContext?: (sources: ContextSources) => string;    // 原 context-builder
  cacheControl?: CacheControlProvider;                    // 原 prompt-cache
  toolPermission?: ToolPermissionChecker;                 // 原 tool-gater
}

// TriMMC 注入
agentLoop({ ..., deps: { buildContext, cacheControl, toolPermission } })

// TriRLC 注入（轻量/空实现）
agentLoop({ ..., deps: { buildContext: minimalContext } })
```

---

## 4. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| 解耦 context-builder / prompt-cache / tool-gater 破坏 TriMMC 70 个现有测试 | 中 | Phase C2 先 re-export 保持 API 兼容，再渐进迁移 |
| TriRLC 缺少 `trimodel` 依赖导致 `@trimetaverse/agent-core` 需要 model client 抽象 | 中 | 将 `createModelClient` 也作为注入依赖（类似 deps 模式） |
| agent-core 版本管理与 TriMMC/TriRLC 版本耦合 | 低 | `file:` 协议开发阶段零耦合；未来可切 npm registry |
| TriRLC 的 planner / local-node 重建工作量超出预期 | 中 | CTO-008-M（通信协议）同步进行，不阻塞 C 交付；TriRLC adapter 层面最小化 |

---

## 5. 决策记录

| 决策点 | 结论 | 状态 |
|--------|------|------|
| 选型 | npm package `@trimetaverse/agent-core` | ✅ **CEO 已确认** |
| 落点 | `TriMMC/packages/agent-core/`（workspace 子包） | ✅ **CEO 已确认** |
| 离线 | `file:` 编译时依赖，构建时 bundle，运行时零 TriMMC 网络依赖 | ✅ **CEO 已确认** |
| 优先级 | CTO-008-C 先于 CTO-008-M/S/P | ✅ 已对齐 |
| 范围 | 仅提取 agent-loop + contracts + types；tool 实现保留在各消费方 | ✅ **CTO APPROVE** |

---

## 6. 使用依据

- TriMMC/src/ 与 TriRLC/src/ 全量文件对比（42 vs 10 files）
- TriMMC Phase 2 agent-loop 70/70 tests pass 状态
- TriRLC package.json：零运行时依赖（仅 devDependencies: tsx + typescript）
- CTO-008 v2 规格（OP-202607-W29-001.unresolved-items.md §CTO-008）
- `docs/三元宇宙架构与模块说明.md`：模块仓库独立原则
- business-state.md：TriMMC 为 agent runtime 与 interaction core
