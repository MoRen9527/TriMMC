# TriMC Scheduler 服务域适配器设计（trimc-scheduler-adapter-design）

## 文档同步元信息

- sourceOfTruth: TriMMC/docs/engineering/trimc-scheduler-adapter-design.md
- syncMode: source-only
- lastSyncedAt: 2026-08-13

> 状态：APPROVED（r1-1 交付，CTO 小狄，2026-08-13）
> 树：TriMetaverse/docs/workflow/operating-records/2026-W33/trees/prod-grade-1-trimc-weekly-cron（生产级开发期首树，CEO 批准）
> 上游 brief：同树 `briefs/r1-1-20260813160943.md`（方案全文与决策依据）
> 关联：TriCompany/docs/engineering/trilc-trimc-runtime-parity.md V1.1；TriMMC/docs/engineering/cos-005-openclaw-absorption-plan.md（APPROVED 2026-07-16）

---

## 1. 背景与结论

生产级开发期首树目标：TriMMC 侧 scheduler 模块定时触发周平面迁移五段链（`TriCompany/runtime/cognition/weekly_plane_shift.py`：create→migrate→carry_over→validate→agent_close），在服务器舰队克隆执行 W33→W34 迁移，硬 deadline 2026-08-16 23:59 前可触发。

**核心结论：复用 `@tricompany/agent-core` 共享 scheduler（croner + JSON job-store + JobExecutor），TriMMC 仓只写服务域适配器 `src/cron/`。不移植 TriRLC cron，不新写调度核心。**

判据：parity V1.1 §1 禁止「复制一份 TriRLC/src 到 TriMMC/src」；§2 声明共享 core 已包含 scheduler；`agent-core/src/scheduler/` 已实现 8 文件 1066 行 + 5 测试并从 `src/index.ts` 全量导出。

---

## 2. 决策记录（三定案点）

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| D1 模块命名 | TriMMC 侧适配器 = **`src/cron/`** | ① 与 CLI 动词 `trimc cron` 一致；② 与 TriRLC host 层 `src/cron/`（行为对标基准）命名对齐；③ `src/orchestration/employee-scheduler.ts` 已占用 "scheduler" 语义（员工调度，agent 域），用 "cron" 零冲突。共享核心保持 `agent-core/src/scheduler/`。边界声明见 `src/cron/index.ts` 模块头注释 |
| D2 语言 | **TypeScript** | ① 共享 core 为 TS 且已全量导出；② TriMMC server（`src/server/app.ts`）为 TS 进程，scheduler 须装配其中；③ croner ^10.0.1 已在 TriMMC dependencies；④ COS-005 决策：Python 仅 IPD heartbeat 域；⑤ 服务器 Node v18.20.8 无 `node:sqlite`（TriRLC SQLite store 不可移植），JSON 文件 store 纯 fs 兼容 v18。执行器 spawn python3 属进程级跨语言调用，非 TriMMC 新 Python 模块 |
| D3 复用方式 | **复用共享 core + 薄适配器**；TriRLC src/cron 仅作行为对标基准（CLI 契约、HTTP 路由表、防并发/超时/降级语义），不作代码移植源 | parity V1.1 §1；agent-core 已有全部调度核心；TriRLC cron 的 session/LLM/localbus 耦合正是共享 core 已剔除部分。版本差标注：COS-005 规划 TriMMC `src/scheduler/` 落点，实际演进为 agent-core 共享核心（R7 2026-08-12 CEO 批准），本设计沿用其 croner/JSON 原子写/Python 域边界决策，修正落点与消费方式 |

---

## 3. 架构与模块清单

```
TriMMC Server（tsx / systemd，root）
├─ src/server/app.ts      cron 路由 if 块 + start()/shutdown 装配 + healthz cron 块
├─ src/cron/（本设计新增，服务域适配器）
│   ├─ week-math.ts        ISO week 纯函数（today → {fromWeek, toWeek, startDate}）
│   ├─ command-handler.ts  JobHandler：token 替换 → spawn(bash -e) → 超时 → 输出捕获 → per-run 日志
│   ├─ service.ts          JobExecutor 装配 + CRUD 封装 + stale-run 恢复 + degraded 聚合
│   ├─ routes.ts           HTTP handlers
│   └─ index.ts            barrel + 命名边界声明
├─ src/cli.ts              trimc cron 子命令（HTTP 客户端形态）
└─ src/config/env.ts       扩展 cronEnabled / cronLogDir

消费（不改动）：
TriCompany/packages/agent-core/src/scheduler/
├─ JobExecutor（调度循环 + runningAtMs 防并发 + 隐式 catchup）
├─ job-store（JSON 原子写：tmp + .bak + rename，0600）
├─ cron-engine（croner 解析/下次运行/校验/时区）
└─ backoff / stagger / heartbeat-policy（原语，MVP 不接）
```

**禁止**：改动 `TriCompany/packages/agent-core/`。若实现中发现共享 core 缺口，停止并升级到 r1-1 owner（CTO），共享包变更走独立变更通道（parity 纪律）。

---

## 4. 调度设计

### 4.1 触发源

- cron 表达式：**`0 23 * * 0`**，timezone **`Asia/Singapore`**——周日 23:00（服务器 UTC+8），ISO 周翻转（周一）之前。（2026-08-24 修正：timezone 全线统一 `Asia/Shanghai`（北京时间），同 UTC+8 偏移、触发时刻不变；现役 job cron 已手调 `59 23 * * 0` = 周日 23:59）
- week token 规则（week-math 纯函数）：`toWeek = ISO week of (today + 1 天)`；`startDate = toWeek 所在周的周一`；`fromWeek = toWeek − 1`。
- 窗口正确性：周日跑 → to=W34 ✓；周一~周六补跑（隐式 catchup）→ 明天仍在当前 ISO 周内 → to=W34 ✓；下周日跑 → to=W35 ✓。全周成立。

### 4.2 调度存储

- agent-core job-store：JSON 文件 **`$TRIMC_CONFIG_DIR/cron/jobs.json`**（`CRON_STORE_VERSION=1` 版本化 schema，原子写，0600）。
- 服务器落点：`TRIMC_CONFIG_DIR=/var/lib/trimc`（root 可写、持久、不进 git），trimc-start.sh 或 trimc.service Environment 注入。
- 选型记录：现役 JSON 文件；**PostgreSQL 迁移登记为跟进项**（服务器已有 postgres:16 + `pg` 依赖；单实例 systemd 下文件存储安全，K8s 多副本化时再迁，接口不变）。SQLite 路线否决（Node 18 无 node:sqlite）。

### 4.3 执行器

- **JobExecutor**（共享 core）：tickMs 1s / maxTimerDelay 60s；`runningAtMs` 守卫防并发重入；隐式 catchup——首 tick 即执行 `nextRunAtMs ≤ now` 的 due job（服务器重启/错过窗口自动补跑，r1-3 实测确认）。
- **command-handler**（本模块，确定性命令执行，无 LLM）：
  1. 读 `job.payload`：`{ command: string; cwd: string; timeoutMs?: number; runAs?: string }`；
  2. token 替换 `{fromWeek}` `{toWeek}` `{startDate}`；
  3. spawn `/bin/bash -e`（`&&` 链失败即停），cwd 按 payload；
  4. runAs 降权：`runAs: "fleet"` 以 uid/gid 1001 执行（复用 `env.ts` TRIMC_RUNAS 的 M1 session-bridge 模式）；未设以进程用户执行（本地开发）；
  5. 超时默认 10min（对齐 TriRLC），`payload.timeoutMs` 可覆盖，超时 SIGKILL；
  6. stdout/stderr 捕获，写 `$TRIMC_CONFIG_DIR/cron/logs/<jobId>__<ISO>.log`（`__` 分隔 jobId 与时间戳，service.ts 解析依赖）+ 回显 systemd journal。
- **stale-run 恢复**（agent-core 缺口的适配器侧补齐）：service.start() 将所有 `runningAtMs ≠ null` 重置为 null（崩溃残留恢复，否则 job 永久卡 running）。

### 4.4 失败、审计与幂等

- **无自动重试**（MVP 裁减；agent-core `withRetry`/backoff 原语 P2 接入）。重跑 = `trimc cron run <id>`。
- **降级可见**：`consecutiveErrors ≥ 3` → degraded → `/healthz` cron 块 + `GET /internal/v1/cron/status`。
- **审计三层**：① jobs.json state（lastRunAt/lastRunStatus/lastError/lastDurationMs/runCount）；② per-run 日志文件；③ 文件级：`.shift-ade.json`（脚本产出，进 git）+ git commit 固定身份（`TriMC Scheduler <trimc@tri.company>`，`-c` 内联）。
- **重复触发防副作用**（迁移窗口内）：runningAtMs 守卫（进程内防重入）+ 单 systemd 实例（无多副本）+ 脚本幂等（create `already_exists` 不失败、carry_over 目标存在即 skip）+ commit 段 no-op 容忍（`git diff --cached --quiet ||`）。

---

## 5. 周平面文件服务器端写路径

### 5.1 命令模板（payload.command）

```bash
cd /srv/fleet/TriCompany && python3.8 -m runtime.cognition.weekly_plane_shift \
  --from {fromWeek} --to {toWeek} --start-date {startDate} \
  --operating-root /srv/fleet/TriMetaverse/docs/workflow/operating-records --sync \
&& cd /srv/fleet/TriMetaverse \
&& git add docs/workflow/operating-records \
&& (git diff --cached --quiet || git -c user.name="TriMC Scheduler" -c user.email="trimc@tri.company" \
     commit -m "ops: weekly plane shift {fromWeek}->{toWeek} (TriMMC scheduler)") \
&& git push /srv/git/TriMetaverse.git HEAD:dev
```

> r1-2 checklist #2 实测定案（2026-08-13，预案 A'）：
> - 服务器系统 Python 3.6.8 实测 `SyntaxError: future feature annotations is not defined`，不兼容（预案静态判断证实）；
> - `dnf module install python38`（3.8.17，alinux3-module）完成，系统 python3.6 未动；
> - 门禁通过：`python3.8 --help` + 测试根 dry 链（5 步执行 exit 0）+ 真实根 dry 链（create pass / migrate fail 为 dry 未写预期 / carry_over would-write）；
> - 命令模板解释器固定 `python3.8`（另装 python3.11 备用，模板不使用）。

- `--sync` 是唯一写开关：默认 dry-run 不写文件、不投递通知；正式触发（--sync）真实写文件并投递邮件通知（O1 已关闭——notify 真实配通、演练二期实证投递，非 render_only 空转）。五段链全确定性，退出码 0/1；产出 `.shift-ade.json` 进新周目录。
- 推裸仓走本地路径（同主机，无网络、无凭证），`HEAD:dev` 对齐裸仓 HEAD=dev。

### 5.2 git 链路与边界

1. 服务器侧：fleet 克隆 commit → push `/srv/git/TriMetaverse.git`（生产级开发期 §三方向例外：周平面文件 TriMMC 编排层维护）。
2. 本地回流：`git pull sg-server dev`——运维回流步骤，编排层执行，**调度器不负责**（服务器无法触发本地动作）。
3. 写方向单主体不变：服务器侧只写 `docs/workflow/operating-records/`；代码文件仍本地发起。

### 5.3 服务器前置检查（一次性，r1-2 checklist）

| # | 项 | 要点 |
| --- | --- | --- |
| 1 | 裸仓写权限 | `/srv/git/TriMetaverse.git` 现为 root:root；fleet 需写权：`chgrp fleet` + `g+w`（推荐，fleet 单主体）；备选 push 段 root 执行 |
| 2 | Python 兼容性（三级预案，CTO 2026-08-13 预裁决） | 静态判断确认：五段链 `from __future__ import annotations`（3.7+）在服务器 Python 3.6.8 必 SyntaxError。影响面已实测：服务器自定义 python3 消费方仅 `/usr/local/sbin/squid-allowlist-sync`；dnf module 有 python38 可并行安装（不动系统 python3.6）。依赖面已核：五段链 import 链纯 stdlib（`__init__.py` 仅 docstring，ecdsa 不在链上），零 pip 依赖。**定案倾向 A'**：`dnf module install python38`（不 enable 默认流）→ 模板解释器改显式 `python3.8` → dry-run 门禁 `python3.8 -m runtime.cognition.weekly_plane_shift --help` + 测试根 dry 链通过即定案。**备选 C**：docker python:3.12-alpine 挂载 /srv/fleet 跑 python 段（docker.service 已是 trimc 依赖）。**否决倾向 B**：回移 3.6 语法触碰 TriCompany 共享 runtime，双端回归面最大，与「零改动复用」定案相悖 |
| 3 | agent-core 链 | `/srv/fleet/TriMC/node_modules/@tricompany/agent-core` 可解析且有 dist（M0 有同模式先例） |
| 4 | fleet git 身份 | `-c` 内联身份，不依赖 fleet 全局 config |
| 5 | TRIMC_CONFIG_DIR | `/var/lib/trimc` 建目录 + 环境注入 |
| 6 | Node engines 对齐 | 服务器 Node v18.20.8 实测；package.json engines 下调 `>=18.20.0`（TriMMC 已在 18 上跑通 M1-M3，tsx>=18.18 满足；tsconfig ES2022 目标 Node 18 完整支持）。新代码 API 面限制 Node 18：禁 `import.meta.dirname`（20.11+）、`fs.glob`（22+）、`node:sqlite`、`Array.prototype.toSorted/toSpliced/toReversed/with`（20+）、`process.loadEnvFile`；`@types/node ^24` 只是编译期类型面，不代表运行时可用。agent-core scheduler 从未在服务器实例化过，P4 smoke 首次实战，暴露问题走共享 core 缺口升级通道 |

---

## 6. HTTP 端点与 CLI 契约

### 6.1 HTTP（app.ts if-chain，插入点：heartbeat 端点后）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/internal/v1/cron/jobs` | add（payload 校验：command/cwd 必填） |
| GET | `/internal/v1/cron/jobs` | list |
| PATCH | `/internal/v1/cron/jobs/{id}` | update（enable/disable、schedule、payload） |
| DELETE | `/internal/v1/cron/jobs/{id}` | remove |
| POST | `/internal/v1/cron/jobs/{id}/run` | 立即跑（`{ force?: boolean }`，禁用/运行中拒绝） |
| GET | `/internal/v1/cron/log` | 执行日志（`?jobId=&limit=`） |
| GET | `/internal/v1/cron/status` | `{ running, degraded, consecutiveErrors, jobCount }` |

`/healthz` 增加 cron 块：`{ enabled, jobCount, degraded, consecutiveFailures }`（对齐 TriRLC）。

### 6.2 CLI（`trimc cron ...`）

- 子命令：`add`（`--name --cron|--every --command --cwd [--run-as] [--timeout]` + `--plane-shift` 预设）、`list`、`run <id> [--force]`、`log`、`status`、`update`、`remove`。
- `--plane-shift` 预设 = §5.1 模板 + cron `0 23 * * 0` + tz `Asia/Singapore` + runAs `fleet` + cwd `/srv/fleet`。
- 服务地址默认 `http://127.0.0.1:8710`，`TRIMC_URL` 可覆盖；行为对标 `trilc cron`（r1-2 由 TriLC 参与 CLI 对齐段）。

---

## 7. 实现清单（r1-2 执行序）

- **P1 适配器核心**：week-math.ts（先写测试）→ command-handler.ts → service.ts → routes.ts → app.ts 装配 + env.ts 扩展 → index.ts（barrel + 命名边界声明）。
- **P2 CLI**：src/cli.ts + package.json `"bin": { "trimc": "./dist/src/cli.js" }`（tsconfig rootDir "." 布局，产物在 dist/src/），确认 tsconfig 编译范围。
- **P3 测试**：week-math 跨周日/周一/周三边界；command-handler mock spawn（成功/非零/超时/runAs 参数）；service CRUD/stale-run/degraded；routes supertest 全路由。门禁：`npm run check`（tsc）clean + `scripts/validate.mjs` typeCheck 通过；`npm test` 全量 491 中 488 通过，2 个失败为 pipeline-integration 既有失败（r1-2 改动前 HEAD 基线同败，与本次改动无关，登记为既有观察项）。
- **P4 服务器部署**：§5.3 checklist → push sg-server → fleet pull → restart trimc → `trimc cron add --plane-shift` → 测试根 dry 链验证 → `trimc cron run <id>` → log 审计。真 W33→W34 触发时机由编排层定（08-16 23:59 前手动触发或周日 23:00 自动首跑）。

---

## 8. 裁减与跟进项

| 项 | 状态 |
| --- | --- |
| 自动重试（backoff 接入） | P2 跟进项 |
| store 迁 PostgreSQL | 跟进项（K8s 多副本化前置） |
| K8s 多副本 lease / 领导选举 | 跟进项（当前单节点 systemd） |
| daemon/service 管理 CLI | 不实施（systemd 已覆盖） |
| 通知集成 | 不实施（脚本已内建 email） |

---

## 9. 风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 服务器 Python 3.6.8 与 runtime.cognition 不兼容 | 高 | checklist #2 三级预案：A' 并行装 python38（定案倾向）→ C 容器 python → B 否决倾向；dry-run 门禁先行实测 |
| 服务器 Node 18 < engines 20 声明性债务 | 中 | checklist #6：engines 下调 >=18.20.0 + 新代码 Node 18 API 面把关 |
| 裸仓写权限 | 中 | checklist #1 一次性调整 |
| agent-core 链服务器不可解析 | 中 | checklist #3 部署时复核 |
| 崩溃残留 runningAtMs 卡死 job | 中 | 适配器 start() 重置 |
| 时区错配 | 低 | schedule 显式 Asia/Singapore，r1-3 验 nextRunAt |
| 重复迁移副作用 | 低 | §4.4 幂等组合拳 |

---

## 10. 依据

- TriMetaverse/docs/execution/production-grade-development-plan.md v2026.W33.1
- TriCompany/docs/engineering/trilc-trimc-runtime-parity.md V1.1
- TriCompany/packages/agent-core/src/scheduler/（8 文件 + 5 测试）与 src/index.ts 导出面
- TriRLC/src/cron/（行为对标基准）、TriRLC/src/cli.ts cron 段、TriRLC/src/server/app.ts cron 路由段
- TriCompany/runtime/cognition/weekly_plane_shift.py（CLI 契约）
- TriMMC/docs/registry/code-state.md、docs/registry/business-state.md、docs/engineering/cos-005-openclaw-absorption-plan.md
- TriMetaverse/docs/execution/server-fleet-m0.md（服务器实测：Node v18.20.8 / Python 3.6.8 / trimc.service / 属主矩阵）
