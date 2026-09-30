# TriMMC Wiki Absorption Integration Plan

版本：V0.1
日期：2026-07-13
状态：架构草案（待 CPO / CTO 联审确认后进入 TriMMC ROADMAP）

## 文档同步元信息

- sourceOfTruth: TriMMC/docs/engineering/wiki-absorption-integration-plan.md
- publishedFrom: 当前文件（source）
- syncMode: source-only
- publishTier: source-only
- lastSyncedAt: 2026-07-13

---

## 1. 问题陈述

### 1.1 当前状态

TriCompany 已建立员工 LLM-wiki 知识吸收管道，核心架构：

- **inbox/**：接收零散资料（.md、.txt、.json），YAML frontmatter 标记源属性
- **wiki/**：LLM 编译产出体系化知识页（摘要 / 整理事实 / 判断 / 待确认 / 来源）
- **audit/**：记录每次吸收的 run_id、trigger_mode、sources、compile_rules
- **workbench/**：前台知识工作台 HTML + JSON 快照投影
- **schedule registry**：Hermes cron 配置的定时吸收规则

**当前运行方式**：Copilot-host 手动触发。员工在会话中执行 CLI 命令（`python -m runtime.cognition.chief_of_staff_llm_wiki_refresh`），LLM 在 Agent 会话上下文内完成 inbox → wiki 编译。

**核心限制**：Copilot-host 无 7×24 daemon 进程。Hermes cron 已配置但定时任务仅在 Agent 活跃会话时才能被触发——这意味着：
- 没有人在与 Agent 对话时，wiki 不会自动吸收
- 最多只能在每次会话开始/结束时手动触发吸收
- 长期不活跃的员工其 inbox 可能积压大量未吸收资料

### 1.2 目标状态

TriMMC daemon 模式下：
- TriMMC 自身提供 7×24 runtime，不依赖 Copilot 会话存活
- Hermes cron → TriMMC cron_runner → task-controller 分发 → wiki_refresh_runner 执行
- 员工的 inbox → wiki 吸收在无人值守下自动运行
- 员工进入任何宿主（Copilot / Claude Code / TriMMC Web Dashboard）时，wiki 已经是最新状态

---

## 2. 架构桥接

### 2.1 总体数据流

```
┌─────────────────────────────────────────────────────────────┐
│                    Copilot-host（当前）                       │
│                                                             │
│  员工在会话中手动执行 CLI ──→ wiki_refresh_runner           │
│                                     │                       │
│                              LLM 在会话上下文内编译          │
│                                     │                       │
│                              wiki/ + audit/ 写回 support root │
└─────────────────────────────────────────────────────────────┘
                           │
                           │  迁移
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    TriMMC daemon（目标）                       │
│                                                             │
│  Hermes schedule_registry ──→ TriMMC cron_runner             │
│                                     │                       │
│                              task-controller.dispatch()     │
│                                     │                       │
│                    ┌────────────────┼────────────────┐       │
│                    ▼                ▼                ▼       │
│              wiki_refresh    wiki_batch_refresh    ...       │
│              (inbox→wiki)    (全量 pages)                   │
│                    │                │                       │
│                    ▼                ▼                       │
│              TriModel 调用（独立推理 session）              │
│                    │                                       │
│                    ▼                                       │
│              knowledge/employees/<id>/wiki/*.md            │
│              knowledge/employees/<id>/audit/*.json          │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 组件映射

| TriCompany 当前组件 | TriMMC 目标组件 | 映射说明 |
|---|---|---|
| `runtime/cognition/runners/wiki_refresh_runner.py` | `TriMMC/src/task-controller/tasks/wiki-refresh.ts` | 单页刷新逻辑迁移到 TriMMC task |
| `runtime/cognition/runners/wiki_batch_refresh_runner.py` | `TriMMC/src/task-controller/tasks/wiki-batch-refresh.ts` | 批量刷新逻辑迁移到 TriMMC task |
| `runtime/cognition/tasks/wiki_ingest_task.py` | `TriMMC/src/task-controller/tasks/wiki-ingest.ts` | inbox 源读取与标准化 |
| `runtime/cognition/tasks/wiki_compile_task.py` | `TriMMC/src/task-controller/tasks/wiki-compile.ts` | LLM 编译逻辑（用 TriModel 调用） |
| `runtime/cognition/chief_of_staff_wiki_paths.py` | `TriMMC/src/knowledge/employee-paths.ts` | 通用化员工知识路径解析 |
| `TriCompany-copilot-host-assets/docs/execution/hermes-copilot-host/phase-1/schedules/*.json` | `TriMMC/config/schedules/wiki-absorption.json` | 定时规则迁移到 TriMMC config |
| Copilot 会话上下文的 LLM 推理 | TriModel + 独立 inference session | 吸收任务获得专属推理上下文，不共享员工会话 |

### 2.3 Task Controller 集成

TriMMC 的 Task Controller 当前是占位实现（`TriMMC/src/task-controller/controller.ts` 仅有 `acceptPlaceholder()`）。

wiki 吸收集成需要在 Task Controller 中注册以下 task type：

```typescript
// TriMMC/src/task-controller/controller.ts 扩展

interface WikiRefreshTask {
  type: 'wiki-refresh';
  employeeId: string;
  pageId: string;
  title: string;
  triggerMode: 'scheduled' | 'manual' | 'event-driven';
  scheduleId?: string;          // Hermes schedule run 的追踪 ID
  sources?: WikiSource[];       // 可选：预筛选的 inbox 源
}

interface WikiBatchRefreshTask {
  type: 'wiki-batch-refresh';
  employeeId: string;
  specIds?: string[];           // 不传则全量
  triggerMode: 'scheduled' | 'manual';
  scheduleId?: string;
}

// Task Controller 处理逻辑
function dispatchTask(task: TriMMCTask): TaskResult {
  switch (task.type) {
    case 'wiki-refresh':
      return executeWikiRefresh(task as WikiRefreshTask);
    case 'wiki-batch-refresh':
      return executeWikiBatchRefresh(task as WikiBatchRefreshTask);
    // ... 其他 task type
  }
}
```

### 2.4 Cron Runner 集成

Hermes schedule_registry 已定义定时规则（如每 2 小时检查 inbox、每日凌晨批量刷新）。TriMMC cron_runner 负责：

1. 解析 `TriMMC/config/schedules/` 下的 schedule JSON
2. 按 cron 表达式触发
3. 将 schedule-run 转换为 `WikiRefreshTask` 或 `WikiBatchRefreshTask`
4. 通过 task-controller.dispatch() 分发给对应 worker
5. 记录执行结果到 audit（run_id + scheduleId + triggerMode=scheduled）

```typescript
// TriMMC/src/cron/runner.ts 伪代码

class CronRunner {
  private schedules: Schedule[];
  private taskController: TaskController;

  async tick(): Promise<void> {
    const dueSchedules = this.schedules.filter(s => s.isDue());
    for (const schedule of dueSchedules) {
      if (schedule.taskType === 'wiki-refresh') {
        await this.taskController.dispatch({
          type: 'wiki-refresh',
          employeeId: schedule.targetEmployee,
          pageId: schedule.targetPage,
          triggerMode: 'scheduled',
          scheduleId: schedule.id,
        });
      }
    }
  }
}
```

---

## 3. 迁移路径

### Phase 1：代码泛化（Copilot-host 阶段）

**目标**：不依赖 TriMMC daemon，先在 Copilot-host 内泛化 wiki 吸收代码。

1. `chief_of_staff_wiki_paths.py` → `employee_wiki_paths.py`（通用化路径解析）
2. 所有 runner 和 task 从 `chief-of-staff` 前缀改为 `employee` 通用前缀
3. CLI 命令支持 `--employee-id` 参数
4. 验证：CPO 和 CTO 可以手动运行 wiki 刷新

**产出**：可在 Copilot-host 手动触发任何员工的 wiki 吸收。

### Phase 2：TriMMC Task 注册（TriMMC scaffold 阶段）

**目标**：在 TriMMC task-controller 中注册 wiki 吸收 task type。

1. 实现 `TriMMC/src/task-controller/tasks/wiki-refresh.ts`
2. 实现 `TriMMC/src/task-controller/tasks/wiki-batch-refresh.ts`
3. 接入 TriModel 进行 LLM 编译（替代当前 Copilot 会话上下文）
4. 对接 `TriCompany-copilot-host-assets/knowledge/` 作为数据读写目标

**产出**：TriMMC 可以执行 wiki 吸收任务，但需要手动触发。

### Phase 3：Cron 与 Schedule 接入（TriMMC daemon 阶段）

**目标**：Hermes schedule registry → TriMMC cron_runner → 自动触发 wiki 吸收。

1. 实现 `TriMMC/src/cron/runner.ts`
2. 将 `TriCompany-copilot-host-assets/docs/execution/hermes-copilot-host/phase-1/schedules/` 下的 schedule JSON 迁移到 `TriMMC/config/schedules/`
3. cron_runner 按表达式定时触发 task-controller.dispatch()
4. 验证：在不活跃会话下，wiki 页面自动更新（audit 记录 triggerMode=scheduled）

**产出**：7×24 无人值守自动 wiki 吸收。

### Phase 4：多员工并行（TriMMC 正式运营阶段）

**目标**：所有在岗员工的 wiki 吸收并行自动运行。

1. 每位员工有独立的 inbox/wiki/audit/workbench 四目录
2. 每位员工的 page-specs.json 独立定义吸收规则
3. cron_runner 按员工维度调度（不同员工可有不同的 cron 表达式）
4. 并行执行（不同员工的吸收任务独立 inference session，互不阻塞）

**产出**：全公司知识自动吸收与沉淀。

---

## 4. 关键设计决策

### 4.1 推理上下文隔离

**决策**：wiki 吸收任务使用独立 TriModel inference session，不与员工交互会话共享上下文。

**理由**：
- 吸收任务是批处理性质，不需要员工对话历史
- 避免 token 污染（inbox 资料+编译指令≈2K-5K tokens）
- 吸收任务可能在员工不在线时运行

### 4.2 Support Root 读写

**决策**：Phase 2-3 期间，TriMMC wiki 吸收的读写目标保持为 `TriCompany-copilot-host-assets/knowledge/`，不迁移数据目录。

**理由**：
- knowledge/ 目录属于 support-object-set，已在 hermes-copilot-host-migration.md 中定义为宿主直接消费的对象集
- TriMMC 启动后 Copilot-host 与 TriMMC 可能短期内并行运行
- 保持单数据源避免分叉

### 4.3 Page Promotion 自动审批

**决策**：在 TriMMC daemon 模式下，page promotion 的 `working → reviewing` 在达到 schedule 刷新次数阈值后自动晋升；`reviewing → stable` 需要人工或 Agent 审批（approval gate）。

**理由**：
- 防止无人审核下低质量 wiki 页被标记为 stable
- 保留人类/Agent 审批作为质量门槛
- 与 object spec 中定义的 promotion 链保持一致

---

## 5. 风险与待确认

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| TriModel 在吸收任务上的编译质量不如 Copilot 会话上下文 | wiki 页质量下降 | Phase 2 先做 A/B 对比测试，达标后再裁撤手动方式 |
| knowledge/ 目录并发读写冲突（Copilot-host 与 TriMMC 并行） | 数据不一致 | Phase 3 前明确文件锁策略（如 sqlite WAL 或文件锁） |
| Hermes schedule JSON schema 需适配 TriMMC cron_runner | 迁移成本 | Phase 2 输出 schema 差异分析后再进入 Phase 3 |
| 其他员工的 llm-wiki-object-spec 尚未创建 | 无法为其他员工启用自动吸收 | 本计划 Phase 1 在代码泛化前先补齐 CPO/CTO 的 spec |

### 5.1 前置依赖

本计划 Phase 2 依赖以下前置条件：
- TriMMCCodeRegistry 正式启用（task-controller 从占位→可运行）
- TriModel 配置完成（provider/model/fallback 可用）
- TriMMC Agent Runtime Layer 可创建独立 inference session
- 员工知识目录 schema 已泛化（`employee_wiki_paths.py`）

---

## 6. 与其他计划的关系

- **Employee capability contract**：wiki 吸收能力将纳入员工通用能力考核项（知识沉淀与复用）
- **CompanyGovernanceRegistry**：本计划确认后写入公司治理记录，作为"知识自动化"路线图的执行层附件
- **Hermes 融合**：本计划是 Hermes 融合中"cron / 定时复杂任务"从 Copilot-host 手动 → TriMMC 自动的关键迁移路径
- **运营记录**：Phase 1-4 的进度里程碑回写到相应的周度 operating record

---

## 7. 验证标准

### Phase 1 完成标准
- [ ] `employee_wiki_paths.py` 支持所有 employee_id 参数化
- [ ] CPO 可在 Copilot-host 中运行 `python -m runtime.cognition.employee_llm_wiki_refresh --employee-id chief-product-officer --page-id ...`
- [ ] audit 记录中 employeeId 字段正确

### Phase 2 完成标准
- [ ] TriMMC task-controller 接受 `wiki-refresh` task type
- [ ] TriModel 调用完成一次完整的 inbox → wiki 编译
- [ ] 输出 wiki 页面块结构与总助手动编译的质量对比在可接受范围

### Phase 3 完成标准
- [ ] 关闭所有 Copilot-host 会话，等待 2 小时后检查 wiki 页面 `updatedAt` 已通过 cron 触发刷新
- [ ] audit 记录中 triggerMode=scheduled

### Phase 4 完成标准
- [ ] 两名以上员工（总助 + CPO）的 wiki 吸收在无人值守下自动运行超过 72 小时
- [ ] 无并发写冲突

---

## 8. 责任分配

| 阶段 | 主导 | 参与 | 审批 |
|------|------|------|------|
| Phase 1（代码泛化） | CTO | 总助（需求方） | CTO 自审 |
| Phase 2（Task 注册） | CTO | - | CPO + 总助（产品验收） |
| Phase 3（Cron 接入） | CTO | 总助（Hermes schedule 口径） | CEO |
| Phase 4（多员工并行） | CTO | CPO（岗位激活优先级） | CEO + CPO |
