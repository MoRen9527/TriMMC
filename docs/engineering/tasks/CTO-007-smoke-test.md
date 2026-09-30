# CTO-007: 小全+小柯流水线烟雾测试

- 任务编号：CTO-007-SMOKE-001
- 状态：✅ 已完成（2026-07-14）
- 创建日期：2026-07-14（W29）
- 发起人：CTO（小狄）
- 审批：CEO 确认小全 CHO 已审批上岗，小柯合同已上线

## 测试目标

验证编码积木 → 验证器 → CTO审查 的完整流水线：
```
小全（编码积木）→ 小柯（验证器）→ CTO（审查）
```

小全产出可测试的代码积木，小柯用自己构建的验证器对积木做自动化门禁，CTO 审查两人工作质量。

## 第一阶段：小全 — 编码积木

### 任务范围

实现 `TriMMC/src/task-controller/controller.ts` 的基础任务生命周期管理，取代当前仅有的 `acceptPlaceholder()` 空壳。

### 功能要求

| 方法 | 签名 | 行为 |
|------|------|------|
| `createTask` | `(description: string, priority?: TaskPriority) => Task` | 创建任务，生成唯一 ID，记录时间戳 |
| `getTask` | `(taskId: string) => Task \| undefined` | 按 ID 查询 |
| `listTasks` | `(filter?: { status?: TaskStatus; priority?: TaskPriority }) => Task[]` | 列出，支持按状态/优先级过滤 |
| `updateTaskStatus` | `(taskId: string, status: TaskStatus) => Task` | 更新状态；非法转换抛错 |
| `acceptPlaceholder` | 保留，委托到 `createTask` | 向后兼容 |

### 类型定义

```typescript
type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

interface Task {
  taskId: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  controller: 'trimc-main';
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
}
```

### 状态转换规则

```
queued → running → completed
                → failed
queued → cancelled
running → cancelled
```

终态（completed / failed / cancelled）不可逆。

### 自测要求

- 测试文件：`TriMMC/test/task-controller.test.ts`（放入 `test/` 目录，与项目现有测试一致）
- 覆盖：创建/查询/列表/状态转换/终态保护/非法状态抛错/边界（不存在的 taskId）
- 目标：≥90% 行覆盖
- 使用项目现有测试基础设施：`node --import tsx --test`

### 约束

- **零新依赖**：不引入新 npm 包、DB、文件系统、网络
- **纯内存存储**：`Map<string, Task>` 在 TaskController 实例内部
- **TypeScript strict**：不使用 `any`
- **导出**：`TaskController` 类 + `Task` `TaskPriority` `TaskStatus` 类型
- **向后兼容**：`acceptPlaceholder()` 继续可用

## 第二阶段：小柯 — 验证器

### 任务范围

构建 `TriMMC/scripts/validate.mjs`，作为编码积木的自动化质量门禁工具。

### 验证器功能

```
node scripts/validate.mjs [--target <file-or-dir>]
```

| 门禁步骤 | 命令/方法 | 通过标准 |
|----------|-----------|----------|
| 1. 类型检查 | `tsc --noEmit` | exit 0 |
| 2. 测试执行 | `node --import tsx --test <target>` | 全部 pass |
| 3. 统计收集 | 解析 TAP 输出 | pass/fail/skip/duration |
| 4. 报告输出 | JSON → stdout | 结构化 JSON |

### 输出格式（JSON）

```json
{
  "target": "test/task-controller.test.ts",
  "timestamp": "2026-07-14T10:30:00.000Z",
  "typeCheck": { "passed": true, "durationMs": 1200 },
  "tests": {
    "total": 14,
    "passed": 14,
    "failed": 0,
    "skipped": 0,
    "durationMs": 450
  },
  "verdict": "PASS",
  "gates": {
    "typeCheckPassed": true,
    "allTestsPassed": true,
    "minTestCount": { "required": 5, "actual": 14, "passed": true }
  }
}
```

### 验证器自测

- 先在 TriMMC 现有 9 个测试文件上运行，确认能产出合法 JSON
- 再针对小全的 `test/task-controller.test.ts` 运行验证
- 记录两次运行的完整输出

### 约束

- **零新 npm 依赖**：只用 Node.js 内置模块（`child_process`、`fs`、`path`）
- Node.js TAP 输出解析：`node --test --test-reporter spec` 解析 exit code + stdout
- 退出码：全部通过 → `0`，任一失败 → `1`
- 报告输出到 stdout，可被 `> report.json` 重定向

## 第三阶段：CTO 审查

CTO 从**质量、效率、成本**三个维度审查小全和小柯的工作产出。

### 审查矩阵

| 维度 | 小全（编码积木） | 小柯（验证器） |
|------|-----------------|----------------|
| **质量** | 命名/结构/错误处理/类型完整度；终态保护 case 完整度；边界覆盖 | 能否正确检测失败/误报/漏报；输出格式合规；可 CI 集成 |
| **效率** | 代码产出（核心行数/测试行数比）；实现耗时；CTO 退回次数 | 工具简洁度（validate.mjs 行数）；首次可用耗时；零手工步骤 |
| **成本** | 内存占用（纯 Map 无泄漏）；每任务操作复杂度 | 零新依赖；验证器运行耗时（ms）；报告可读性（无需人工解析） |

### 效率与成本指标（量化基线）

#### 小全效率

| 指标 | 基线 | 测量方式 |
|------|------|----------|
| 核心代码行数 | ~60-80 行（controller.ts） | `wc -l` 去空行/注释 |
| 测试代码行数 | ~100-120 行（test 文件） | `wc -l` 去空行 |
| 测码比 | 1.2~1.5（测试行/核心行） | 自动计算 |
| 首次提交通过率 | ≥80%（验证器首跑 pass） | 小柯验证器报告 |
| 退回迭代次数 | ≤2 轮 | CTO 记录 |

#### 小柯效率

| 指标 | 基线 | 测量方式 |
|------|------|----------|
| 验证器代码行数 | ~60-100 行（validate.mjs） | `wc -l` |
| 新依赖数 | 0（纯 Node.js 内置） | `npm ls` 差量 |
| 验证器运行耗时 | <2s（对 10+ 测试文件） | JSON 报告 `durationMs` |
| 误报/漏报率 | 0（已知失败 case 能正确检出） | CTO 手工注入失败验证 |
| 退回迭代次数 | ≤1 轮 | CTO 记录 |

#### 两人交叉成本

| 指标 | 含义 | 测量方式 |
|------|------|----------|
| 缺陷逃逸率 | 小全的 bug 在自测阶段未发现，被验证器/CTO 发现的个数 | CTO 审计 |
| 验证器盲区 | 小柯验证器未能检出的已知问题 | CTO 手工注入缺陷测试 |
| CTO 审查耗时 | 从拿到两人产出到 sign-off 的时间 | 时间戳差 |

#### Token 消耗（模型调用成本）

Token 消耗作为 LLM 原生开发模式的直接成本指标，纳入 CTO 审查范围。当前阶段以 agent 会话估算为主，中长期路由到 CPO/TriModel 统一统计。

| 指标 | 含义 | 当前测量方式 | 目标状态 |
|------|------|-------------|----------|
| 小全实现 token | 从接到任务到提交代码的会话 token 消耗 | GitHub Copilot 会话统计（估算） | TriModel 统一 Credit 统计 |
| 小柯实现 token | 构建验证器的会话 token 消耗 | 同上 | 同上 |
| CTO 审查 token | 审查两人产出 + 写结论的消耗 | 本次会话统计 | 同上 |
| 端到端人均 token | （小全 + 小柯 + CTO）/ 3 | 汇总计算 | 用于后续任务基线对比 |
| Token 效率比 | 有效代码行 / token 消耗 | `(小全核心行 + 小柯核心行) / 端到端总 token` | 衡量 LLM 辅助编码的投入产出 |

**CPO 升级项**：Token/Credit 统一统计应作为产品需求路由到 CPO（小乔）评估——
- TriStaciss 内部有自身的 token 消耗统计，对外（TriModel）可能以 **Credit** 为单位结算
- TriModel 是否需要提供统一的 `TokenUsage` / `CreditUsage` 统计接口（provider-agnostic）
- 该接口是否作为 TriMMC agent loop 的标准 observability 指标
- 不影响当前 CTO-007 烟雾测试：先用会话估算跑通，后续接入统一统计后再回填精度 |

### CTO 审查结论格式

审查完成后输出三级结论：

```
小全：质量 [PASS/NEEDS-FIX] | 效率 [HIGH/MEDIUM/LOW] | 成本 [LOW/MEDIUM/HIGH]
小柯：质量 [PASS/NEEDS-FIX] | 效率 [HIGH/MEDIUM/LOW] | 成本 [LOW/MEDIUM/HIGH]
Token：端到端 [N]K | 人均 [N]K | 效率比 [N] 行/Ktoken
流水线：[PASS/BLOCKED] — 原因（如 BLOCKED）
```

## 交付物清单

| 序号 | 路径 | 负责人 | 类型 |
|------|------|--------|------|
| 1 | `TriMMC/src/task-controller/controller.ts` | 小全 | 修改 |
| 2 | `TriMMC/test/task-controller.test.ts` | 小全 | 新建 |
| 3 | `TriMMC/scripts/validate.mjs` | 小柯 | 新建 |
| 4 | 验证报告（小全积木） | 小柯 | 输出 |
| 5 | CTO review sign-off | 小狄 | 审查 |

## 执行顺序

```
1. 小全实现 controller.ts + controller.test.ts → 自测通过 → 提交
2. 小柯构建 validate.mjs → 在现有 9 测试上验证 → 对小全新测试跑验证 → 输出报告
3. CTO 审查 1+2 → sign-off 或退回
```
