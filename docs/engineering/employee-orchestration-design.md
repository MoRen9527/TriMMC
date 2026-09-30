# TriMMC 员工编排层技术方案 V1.0

**Author**: CTO 小狄
**Date**: 2026-07-14
**Status**: 初版（待与 CPO 对齐产品范围）
**Reference**: CTO-002 (W29, due 2026-07-17)
**Dependencies**: TriMMC Phase 1 & 2（55 tests ✅）、Contract Resolver v0.2.0（17 tests ✅）

---

## 1. 设计目标

在 TriMMC 已有 agent-loop + contract resolver 基础上，补齐**员工编排层（Employee Orchestration Layer）**的架构设计。编排层负责：

1. **角色调度**：把任务按岗位契约分派给正确的 AI 员工
2. **能力路由**：根据员工技能清单、IO 契约和当前负载做路由决策
3. **成本控制**：按员工/任务等级做 token 预算、模型分层和速率限制

本方案不替代 TriMMC DESIGN.md 中已有的六层架构，而是在第 3 层（Orchestration Engine Layer）和第 2 层（Agent Runtime Layer）之间补充一个**员工编排子层**，充当 Coordinator 和员工实例之间的桥接。

---

## 2. 架构定位

```
TriMMC 六层架构（现有）              员工编排子层（新增）

┌──────────────────────────┐
│  Gateway / Entry Layer   │
├──────────────────────────┤
│  Agent Runtime Layer     │  ← Employee Lifecycle Manager
├──────────────────────────┤      ├─ Employee Registry
│  Orchestration Engine    │      ├─ Employee Scheduler
│  (Coordinator)           │  ←── ├─ Capability Router
├──────────────────────────┤      ├─ Cost Controller
│  Context Engine          │      └─ Employee Dispatch Proxy
├──────────────────────────┤
│  Inference Core          │
├──────────────────────────┤
│  Tool Bus & Model Adapter│
├──────────────────────────┤
│  Session & State Store   │
└──────────────────────────┘
```

### 2.1 定位原则

- **编排层不替代 Coordinator**：Coordinator 负责"任务怎么拆"，编排层负责"拆出来的活找谁干"
- **编排层不替代 Context Engine**：Context Engine 负责"给 agent 塞什么上下文"，编排层只负责"该启动哪个 agent"
- **编排层是 Agent Runtime 与 Orchestration Engine 之间的门禁**：所有员工派发必须经过能力路由+成本控制+负载检查
- **编排层不改变现有 contract resolver 协议**：`.contract.yaml` 的 Schema v1 不变，编排层只是消费方之一

---

## 3. 核心组件

### 3.1 Employee Registry（员工注册表）

**职责**：赛博公司全体员工的可调度视图，是编排层的唯一真源。

**数据来源**：
- `TriCompany/docs/registry/` — 员工 `.contract.yaml` 文件
- `TriCompany/.github/binding-profiles/` — 宿主 binding 事实
- `TriCompany/.github/source-agents/<employee>/` — 五件套源侧定义

**内存结构**（TypeScript 类型）：
```typescript
interface EmployeeRecord {
  employeeId: string;          // e.g. "chief-technology-officer"
  contract: AgentContract;     // from .contract.yaml (resolved)
  binding?: EmployeeBinding;   // from binding-profiles/
  status: EmployeeStatus;      // 'active' | 'standby' | 'offline'
  currentLoad: number;         // 当前活跃任务数
  maxConcurrentTasks: number;  // 最大并发任务数
  activeSkills: string[];      // 从 responsibilities + tools 推导
  costProfile: EmployeeCostProfile;
  reportingChain: string[];    // reports_to 链条 [self, ..., ceo]
}

interface EmployeeStatus {
  state: 'active' | 'standby' | 'offline' | 'onboarding' | 'suspended';
  since: string;               // ISO datetime
  reason?: string;
}

interface EmployeeCostProfile {
  dailyTokenBudget: number;
  modelTier: 'thinking' | 'balanced' | 'fast';
  maxCostPerTask: number;      // USD
  monthlyCostCap: number;      // USD
}
```

**实现路径**：
- Phase 1（本方案）：`EmployeeRegistry` 从文件系统加载所有已知 `.contract.yaml`，配上静态 `costProfile`
- Phase 2（后续）：从 TriMMC 运行时状态实时更新 `currentLoad`、`status`

---

### 3.2 Capability Router（能力路由器）

**职责**：根据任务需求匹配最合适的员工。

**路由算法**（三级匹配）：

```
第一级：IO Contract 匹配（硬约束）
  task.inputs ⊆ employee.io_contract.inputs  → 能力覆盖
  task.expected_outputs ⊆ employee.io_contract.outputs → 产出覆盖

第二级：决策权限匹配（软约束，加权）
  task.decision_type ∈ employee.decision_rights.approve → +10 分
  task.decision_type ∈ employee.decision_rights.freeze → +5 分
  task.decision_type ∈ employee.decision_rights.forbidden → 直接排除

第三级：负载+优先级匹配（调优）
  employee.currentLoad < employee.maxConcurrentTasks → 可分配
  按负载升序排列 → 优先分配给空闲员工
```

**路由决策输出**：
```typescript
interface RoutingDecision {
  matched: boolean;
  primary: EmployeeRecord;           // 最佳匹配
  alternatives: EmployeeRecord[];    // 备选（按评分降序）
  escalationPath: EmployeeRecord[];  // 升级链（沿 reports_to 上行）
  score: number;                     // 0-100
  matchDetails: {
    ioCoverage: number;              // IO 契约覆盖率 %
    authorityMatch: boolean;
    loadAvailable: boolean;
  };
}
```

**特殊规则**：
- Registry Agent（family='Registry'）不接受任务派发，只在被查询时响应
- `user_invocable: false` 的员工不能被 Coordinator 直接调度（只能由其上级派活）
- 跨 reporting chain 派活时自动升级到共同上级审批
- 新员工（status='onboarding'）只能接受由直属上级派发的培训任务

---

### 3.3 Employee Scheduler（员工调度器）

**职责**：执行调度决策，管理任务队列和员工状态转换。

**调度状态机**：
```
             ┌─────────┐
    task_in →│ QUEUED  │
             └────┬────┘
                  │ routing decision
          ┌───────┴───────┐
          ▼               ▼
    ┌──────────┐    ┌──────────┐
    │ASSIGNED  │    │ ESCALATED│
    └────┬─────┘    └────┬─────┘
         │               │
    ┌────┴────┐     ┌────┴────┐
    ▼         ▼     ▼         ▼
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│RUNNING│ │REJECT│ │ACCEPT│ │REJECT│
└──┬───┘ └──────┘ └──┬───┘ └──────┘
   │                 │
   ▼                 ▼
┌──────┐        ┌──────────┐
│ DONE │        │ SUB-TASK │ → 递归调度
└──────┘        └──────────┘
```

**并发控制**：
- 每员工 `maxConcurrentTasks`（默认 1，CTO/CPO 可设 2-3，worker 类可设 1）
- 全局并发上限：`TOTAL_CONCURRENT_TASKS`（默认 10，防止 token 爆炸）
- 优先级队列：`P0 抢占 > P1 正常 > P2 后台`

**超时与重试**：
- 默认任务超时：30 min（可配置）
- 超时后自动 `ESCALATE` 到上级
- 失败重试：最多 2 次（同员工），第 3 次自动切换备选员工

---

### 3.4 Cost Controller（成本控制器）

**职责**：按员工/任务等级控制 token 消耗和模型使用。

**三层预算体系**：

```
Layer 1: 公司级（TriMMC 全局）
  daily_budget:  USD 50（MVP 阶段硬上限）
  monthly_budget: USD 500
  overage_policy: 'freeze_except_p0'  ← 超支后只允许 P0 任务

Layer 2: 员工级（per EmployeeRecord）
  daily_token_budget: 按岗位设定
    CTO/CPO:      200K tokens/day
    TestEngineer: 100K tokens/day
    FullStackDev: 150K tokens/day
    其他:          50K tokens/day
  max_cost_per_task: USD 2.00

Layer 3: 任务级
  model_tier: 按任务 priority 选择
    P0 → 'thinking'（如 deepseek-v4-pro）
    P1 → 'balanced'（如 deepseek-v3）
    P2 → 'fast'（如 deepseek-v3-lite）
```

**模型分层策略**：
```typescript
interface ModelTierPolicy {
  tier: 'thinking' | 'balanced' | 'fast';
  maxTokensPerTurn: number;
  allowedModels: string[];
  defaultModel: string;
  fallbackChain: string[];  // 降级链
}

const MODEL_TIERS: Record<string, ModelTierPolicy> = {
  thinking: {
    tier: 'thinking',
    maxTokensPerTurn: 8192,
    allowedModels: ['deepseek-v4-pro', 'claude-sonnet-4-20250514'],
    defaultModel: 'deepseek-v4-pro',
    fallbackChain: ['deepseek-v3']
  },
  balanced: {
    tier: 'balanced',
    maxTokensPerTurn: 4096,
    allowedModels: ['deepseek-v3', 'gpt-4o'],
    defaultModel: 'deepseek-v3',
    fallbackChain: ['deepseek-v3-lite']
  },
  fast: {
    tier: 'fast',
    maxTokensPerTurn: 2048,
    allowedModels: ['deepseek-v3-lite'],
    defaultModel: 'deepseek-v3-lite',
    fallbackChain: []
  }
};
```

**成本追踪**：
- 每任务完成后记录 `{ employeeId, taskId, tokensConsumed, modelUsed, costUSD }`
- 每日 00:00 UTC+8 重置 daily counters
- 超预算事件 → 通知 COS（CEOChiefOfStaff）+ 冻结非 P0 任务

---

### 3.5 Employee Dispatch Proxy（员工派发代理）

**职责**：编排层对外的单一入口，封装注册→路由→调度→成本检查的完整链路。

```typescript
interface DispatchRequest {
  task: {
    type: string;               // 任务类型（映射到 io_contract.inputs）
    priority: 'P0' | 'P1' | 'P2';
    description: string;
    expectedOutputs: string[];  // 映射到 io_contract.outputs
    decisionType?: string;      // 是否需要 approve/freeze/escalate 权限
  };
  requester: string;            // 谁发的任务（employeeId）
  context?: {
    parentTaskId?: string;      // 父任务 ID（子任务场景）
    ipdPhase?: string;          // IPD 十阶段（可选）
    deadline?: string;          // ISO datetime
  };
}

interface DispatchResult {
  success: boolean;
  assignedTo?: string;          // employeeId
  escalationTo?: string;        // 升级目标 employeeId
  rejectionReason?: string;     // 拒绝原因（硬约束不满足）
  costEstimate?: {
    estimatedTokens: number;
    estimatedCostUSD: number;
    modelTier: string;
  };
  trace: DispatchTraceEntry[];
}
```

**派发流程**（6 步）：
```
1. TaskClassifier.classify(task)       → 提取 type, expectedOutputs, decisionType
2. EmployeeRegistry.getActive()        → 过滤 status='active' 的员工
3. CostController.preCheck(task, req)  → 预算检查（公司+员工+任务三层）
4. CapabilityRouter.route(task, pool)  → 三级匹配，产出 RoutingDecision
5. EmployeeScheduler.dispatch(decision) → 状态机转换，分配任务
6. CostController.reserve(task, emp)   → 预留 token 预算
```

---

## 4. 与既有系统的集成点

### 4.1 与 Agent Loop 的集成

当前 `agentLoop()` 通过 `task` tool 实现 sub-agent dispatch（Phase 2 done）。编排层**不是替代** `task` tool，而是作为它的后端引擎：

```
Coordinator agentLoop()
  → tool_call: task
  → EmployeeDispatchProxy.dispatch(request)
      → CapabilityRouter.route()
      → EmployeeScheduler.dispatch()
  → spawn sub-agent worker (复用 agentLoop)
  → worker 完成后汇报
```

### 4.2 与 Contract Resolver 的集成

`EmployeeRegistry` 初始化时调用 `resolveContracts(registryDir)` 加载所有合约。编排层是 contract resolver 的**主要消费者**：

| Contract 字段 | 编排层用途 |
|---|---|
| `io_contract.inputs` | CapabilityRouter 第一级硬约束 |
| `io_contract.outputs` | CapabilityRouter 第一级硬约束 |
| `decision_rights.*` | CapabilityRouter 第二级软约束 |
| `tools[].risk_level` | CostController 任务风险定价 |
| `collaborators.reports_to` | EmployeeScheduler escalation path |
| `identity.user_invocable` | EmployeeScheduler 调度资格 |
| `identity.family` | CapabilityRouter 排除 Registry agent |

### 4.3 与 TriCompany 员工体系的集成

- 员工上岗（`onboarding`）：由 CHO 审批 → `EmployeeRegistry` 注册新记录
- 员工下岗（`offline`）：由直属上级或 CHO 发起 → registry 标记 `suspended`
- 技能变更：更新 `.contract.yaml` → `EmployeeRegistry` 热重载

### 4.4 与 IPD 十阶段的集成

```
IPD Phase         →  编排层动作
DISCOVERY         →  调度 Research worker（TriDev agent）
DESIGN            →  调度 Architect worker（CTO agent）
IMPLEMENTATION    →  调度 Coding worker（小全/小柯）
TEST              →  调度 Test worker（小柯）
DEPLOY            →  调度 Deploy worker（TriDeployment agent）
REVIEW            →  调度 Review worker（CPO agent）
```

---

## 5. 分阶段实现计划

### Phase A（本周，对应 CTO-002 交付）：核心骨架

| 组件 | 实现范围 | 测试门禁 |
|---|---|---|
| `EmployeeRegistry` | 静态文件加载，所有已知 contract 解析 | 6 tests：load + resolve + status filter |
| `CapabilityRouter` | 三级匹配算法，RoutingDecision 输出 | 8 tests：perfect match / no match / partial / forbidden |
| `EmployeeScheduler` | 状态机核心，单员工队列 | 5 tests：assign / reject / escalate / 并发上限 |
| `CostController` | 三层预算检查，模型分层，预留机制 | 5 tests：budget check / overage freeze / tier select |
| `EmployeeDispatchProxy` | 6 步派发流程串联 | 3 tests：happy path / rejection / escalation |
| **总计** | — | **27 tests** |

**文件结构**：
```
TriMMC/src/orchestration/
  employee-registry.ts
  capability-router.ts
  employee-scheduler.ts
  cost-controller.ts
  dispatch-proxy.ts
  types.ts
  index.ts
```

### Phase B（下周）：运行时集成

- Agent loop `task` tool 接入 DispatchProxy
- 负载实时更新（agent start → currentLoad++，agent end → currentLoad--）
- 成本追踪持久化（JSONL 格式）
- 超预算事件 → COS 通知 hook

### Phase C（W31+）：生产加固

- 热重载（contract 变更无需重启）
- 跨 session 负载快照恢复
- 成本仪表盘数据源
- 全局并发池动态扩缩

---

## 6. 测试策略

| 层 | 测试类型 | 策略 |
|---|---|---|
| EmployeeRegistry | 单元 | Mock filesystem，验证所有 contract 加载 + 状态过滤 |
| CapabilityRouter | 单元 | 夹具：3 个不同角色的 contract，测试 8 种路由场景 |
| EmployeeScheduler | 单元 | 状态机转换 + 并发上限 + escalation chain |
| CostController | 单元 | 预算边界值（刚好用完/超额/日重置）|
| DispatchProxy | 集成 | 串联全链路，mock 下层但验证端到端 |
| E2E | 集成 | TriMMC server + 真实 contract + agent loop task dispatch |

---

## 7. 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Registry 存哪 | 内存 + 文件系统重载 | 当前无持久化 DB，Phase A 不引入新依赖 |
| 并发模型 | 单进程 Node.js 事件循环 | 与 TriMMC 一致，不引入 worker_threads |
| 升级链上限 | 最多 3 级（员工→上级→CEO） | 防止无限升级循环 |
| 成本超支策略 | `freeze_except_p0` | 安全优先，保留关键路径 |
| Contract 热重载 | Phase C | Phase A 用启动时一次性加载 |
| 跨员工通信 | 复用现有 agent-loop message 格式 | 不发明新协议，在 message 里塞 employee metadata |

---

## 8. 风险与缓解

| 风险 | 严重度 | 缓解 |
|---|---|---|
| 员工 contract 不全（当前仅 TestEngineer 有完整 contract） | 🔴 High | Phase A 同时补齐 CTO/CPO/COS/CHO 四份 contract.yaml |
| 没有真实 API key，端到端测试无法跑 | 🔴 High | 单元测试用 mock modelClient + fake agentLoop |
| 成本控制依赖 token 计数准确性 | 🟡 Medium | Phase A 使用 conservative estimate，Phase B 接入 TriModel 真实计数 |
| 静态文件加载不支持运行时新增员工 | 🟡 Medium | Phase A 只要求重启后生效，Phase C 热重载 |
| 编排层引入单点 | 🟢 Low | DispatchProxy 是无状态函数式设计，可水平扩展 |

---

## 9. 与 CPO 产品范围对齐点

以下边界需要与 CPO（小乔）确认：

1. **员工成本预算具体数值**：当前的 50K/100K/150K/200K 分级是否为合理的产品决策？
2. **模型分层策略**：deepseek-v4-pro/v3/v3-lite 三级是否覆盖当前需要？
3. **调度并发上限**：`TOTAL_CONCURRENT_TASKS=10` 是否过于激进/保守？
4. **超预算后的用户可见行为**：应该静默降级还是通知 CEO？
5. **小全上岗后编码类任务的调度优先级**：小全（FullStackDev）和小柯（TestEngineer）之间是否存在流水线依赖？

---

## 10. 使用依据

- `TriMMC/docs/engineering/DESIGN.md` §2 六层架构、§3 Coordinator 模式、§6 多 Agent 隔离
- `TriMMC/docs/engineering/phase-1-execution-note.md` — Phase 1&2 交付物列表
- `TriMMC/src/contracts/resolver.ts` — Contract Resolver v0.2.0 API
- `TriMMC/src/agent-loop/loop.ts` — agentLoop() API（AsyncGenerator + 8 事件类型）
- `TriMMC/src/task-controller/controller.ts` — 当前占位，将被本方案替代
- `TriCompany/docs/engineering/DESIGN.md` §2.2.1 元认知混合结构
- `TriCompany/.github/source-agents/test-engineer/` — TestEngineer 五件套（唯一完整的员工 contract）
