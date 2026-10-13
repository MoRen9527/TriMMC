# TriMMC Cron Scheduler 运维 Runbook（周平面迁移五段链）

## 文档同步元信息

- sourceOfTruth: TriMMC/docs/ops/trimc-cron-plane-shift-runbook.md
- syncMode: source-only
- lastSyncedAt: 2026-08-31

> **时点修正（2026-08-31，真源可修口径留痕；LG-016 晨间简报派落）**：现役迁移触发时点为**每周日 23:00 北京时间**（cron `0 23 * * 0` Asia/Shanghai，CEO 2026-08-30 定）——本文正文散见的「现役 23:59 手调（59 23 * * 0，2026-08-16 手调）」为历史时点，按历史叙事冻结不改，以本注记现行值为准。W35→W36 首跑 PASS（2026-08-30 23:00 heyuan job 9c81c7ec，ok/9342ms，sg-bare dev=f284c19b 落真源 19c39f82 之上）；本轮同步变更：heyuan 侧迁移 job 去 runAs（服务 User=fleet 单身份）+payload 前置 TriMetaverse ff 拉取（隐雷排除，见 board-journal 2026-08-30 深夜干预链摘录）。
- 命名注记（quad-migration v1.0）：本 runbook 所述"TriMMC"= 服务器现役实例，叙事面已更名 **TriMMC**（原 TriMMC，元虚拟主控壳）；兼容面物理名照旧。权威 alias 表：TriCompany/docs/registry/company-governance-state.md

> 关联：TriMMC/docs/engineering/trimc-scheduler-adapter-design.md（r1-1 APPROVED，r1-2 实现）
> 树：TriMetaverse/docs/workflow/operating-records/2026-W33/trees/prod-grade-1-trimc-weekly-cron

## 1. 架构速览

```
trimc.service（root，tsx 直跑）
  └─ src/cron/（JobExecutor 调度循环 + command-handler）
       └─ 周日 23:59 北京时间触发（现役 cron `59 23 * * 0`，timezone `Asia/Shanghai`）
            └─ runAs fleet：python3.8 五段链 --sync
                 ├─ /srv/fleet/TriMetaverse 写 docs/workflow/operating-records/
                 ├─ git add + commit（内联身份 TriMC Scheduler）
                 └─ git push /srv/git/TriMetaverse.git HEAD:dev
```

- 存储：`/var/lib/trimc/cron/jobs.json`（TRIMC_CONFIG_DIR=/var/lib/trimc，service drop-in 注入）
- 日志：`/var/lib/trimc/cron/logs/<jobId>__<ISO>.log` + systemd journal（`journalctl -u trimc`）
- 解释器：**python3.8**（服务器系统 python3.6.8 不兼容 `from __future__ import annotations`，checklist #2 定案 A'）
- 通知：**notify 已真实配通（O1 关闭，2026-08 演练二期实证）**——`notify.json` 0600 + QQ SMTP；`--sync` 迁移完成后邮件通知真实投递（非 render_only 空转），审计仍以 `.shift-ade.json` + git commit + per-run 日志为主、邮件为补充

## 2. 部署步骤（代码版本更新）

1. 本地 push sg-server（编排层执行；收口复核 `git ls-remote`）
2. 服务器：`cd /srv/fleet/TriMC && git pull`（执行身份二选一：**root**——TriMC 工作区新文件写成 root 属主无碍（fleet 不消费 TriMC 仓）；**`runuser -u fleet`**——保持 fleet 单主体。推荐后者，二选一记录在案）
3. **TriMetaverse 仓 .git 属主修正（每次 pull 后必跑，与 pull 身份无关）**：root pull 会在 .git 产生 root 属主新文件（index/refs/objects），fleet 无法写 index/refs；fleet pull 则新文件自然属 fleet 无需 chown——无论哪种身份 pull，跑一遍即可：
   `chown -R fleet:fleet /srv/fleet/TriMetaverse/.git`
   （r1-2 P4 实测：首次 838 个 root 文件；r1-3 复查 26 个复发；r1-3 自验时再次捕获编排层 root pull 产生的 10 个新 root 文件——复发属常态，入部署步骤）
4. **裸仓 loose 目录 g+w（每次 push 后检查）**：git push 新建的 loose 对象目录不带组写，fleet 下次 push 会概率失败：
   `find /srv/git/TriMetaverse.git/objects -maxdepth 1 -type d -not -perm -g=w -exec chmod g+w {} +`
   （r1-3 实测 5 个锁定目录：03/79/7c/3a/90，修复后 push 通道验证 exit 0）
5. **fleet safe.directory（一次性）**：git 2.43.7 对非属主裸仓目录拒绝 push（exit 128，模板 `-c` 内联无效已实证），必须全局登记：
   `runuser -u fleet -- git config --global --add safe.directory /srv/git/TriMetaverse.git`
6. `systemctl restart trimc`
7. 验证：`curl -s http://127.0.0.1:8710/healthz | grep -o '"cron":{[^}]*}'`

## 3. 装周平面迁移 job（首次/重装）

```bash
cd /srv/fleet/TriMC
npx tsx src/cli.ts cron add --plane-shift   # 预设：周日 23:00 北京时间（Asia/Shanghai）+ runAs fleet（现役 job 为 23:59 手调，见 §7 时区口径条）
npx tsx src/cli.ts cron list
```

验证触发链路（不跑真迁移）：

```bash
# 测试根 dry 链（无 --sync 不写；或改用 --sync 在测试 operating-root 全链写验证）
cd /srv/fleet/TriCompany && python3.8 -m runtime.cognition.weekly_plane_shift \
  --from W33 --to W34 --start-date 2026-08-17 \
  --operating-root <测试根> [--sync]
```

真迁移触发（编排层定案：不做人工提前点火）：

```bash
# 主路径：自然触发 —— r1-3 验证 PASS 后由 cron 周日自动触发（现役 23:59 北京时间 Asia/Shanghai）
# 兜底：cron 未触发时手动补跑（幂等：重复跑安全）
npx tsx src/cli.ts cron run <jobId>
npx tsx src/cli.ts cron log --job-id <jobId> # 审计
```

**job ID 口径**：消息/命令里引用 job 必须用 `trimc cron list` 输出的**完整 UUID**（36 位，如现役周迁移 job `b00b0070-2f82-4e7d-a98c-de73e886834b`），截断形式（如 b00b0070-2f82-4e7d-a98）查不到 job、排查时才暴露是口径坑（编排层演练实证）。

写路径前置验证（fleet 身份，r1-2 P4 实测通过）：`/home/fleet` 存在（command-handler HOME 覆盖有效）、
`.git` 递归 fleet 属主后 `git add` 可写 index、`git diff --cached --quiet` no-op 幂等。

## 4. 本地回流（运维步骤，调度器不负责）

服务器 push 裸仓后，本地执行：

```bash
cd D:/Code/ai/TriMetaverse && git pull sg-server dev
```

**边界**：服务器无法触发本地动作；本地回流由编排层（小贾）执行。调度器职责止于服务器侧 push 裸仓。

## 5. 异常处理

| 症状 | 处置 |
| --- | --- |
| healthz cron.enabled=false | `systemctl restart trimc`；查 `journalctl -u trimc -n 50` |
| job 卡 running（崩溃残留） | service.start() 自动重置（stale-run 恢复）；手动：编辑 jobs.json 置 runningAtMs=null 后 restart |
| consecutiveFailures ≥ 3（degraded） | `trimc cron log` 查错误尾部；修复后 `trimc cron run <id>` 重跑（幂等） |
| 五段链失败 | 脚本幂等：create already_exists 不失败、carry_over 目标存在即 skip；修正后直接重跑 |
| 周平面文件被误改 | 本地 pull 回流后 diff 审查；写方向单主体（服务器只写 operating-records/） |
| fleet push 报 fatal: detected dubious ownership（exit 128） | safe.directory 未登记：`runuser -u fleet -- git config --global --add safe.directory /srv/git/TriMetaverse.git`（B1，一次性） |
| fleet push 报 Permission denied 写 loose 对象 | 裸仓 loose 目录缺 g+w：`find /srv/git/TriMetaverse.git/objects -maxdepth 1 -type d -not -perm -g=w -exec chmod g+w {} +`（B2） |
| fleet git add/commit 报 index 不可写 | .git 属主复发：`chown -R fleet:fleet /srv/fleet/TriMetaverse/.git`（R1，root pull 后常态） |

### 演练回退（无痕回退四件套，编排层演练实证可用；2026-08-14 升级三端口径）

依据：init-to-collab-design §8.3 三端回退与域隔离（三端 = 裸仓 ref / 舰队克隆 HEAD / 本地 dev+worktree HEAD）。

**前置（一期/二期教训）**：
- **演练前精确 HEAD 必须当场记录并核对，不凭记忆**——一期教训：记忆值 be4f80a1 与实值 a857ccaa 不符，裸仓/克隆回退目标分叉 → 后续 push 被 non-fast-forward 拒绝。
- **服务器侧 git 操作统一 fleet 身份**（`runuser -u fleet --`），root 只做 chown/chgrp 类属主修复——克隆混入 root 属主文件会致 fleet `reset`/`clean` 被拒（R1 同源）。

```bash
# ① 裸仓回退：把 ref 指回演练前 commit
git --git-dir=/srv/git/TriMetaverse.git update-ref refs/heads/dev <演练前commit>

# ② 舰队克隆回退：硬重置 + 清理（clean 限定路径域，不得全仓 clean）
git -C /srv/fleet/TriMetaverse reset --hard <演练前commit> && git -C /srv/fleet/TriMetaverse clean -fd docs/workflow/operating-records

# ③ job 运行态复位：编辑 /var/lib/trimc/cron/jobs.json，把 runCount 置 0、
#    state 各时间戳置 null（lastRunAtMs/lastRunStatus/lastError 等），restart trimc

# ④ 本地端回退（§8.3 升级新增）：若本地 dev/worktree 已 pull 迁移 commit，
#    同步 ff 复位到同一回退目标（本地执行，编排层窗口）
git fetch sg-server dev && git reset --hard <演练前commit>   # D:/Code/ai/TriMetaverse
git -C <worktreePath> reset --hard <演练前commit>            # 项目 worktree（如有）
```

> 演练产生了文件与 job 状态，回退后按 §2.3 chown .git（reset 可能重建 root 属主文件）。

**「无痕」定义（§8.3 升级）**：三端 HEAD + job 态 + 本地读面一致复位——① 裸仓 ref、② 舰队克隆 HEAD、④ 本地 dev 与 worktree HEAD 三端同指回退目标 commit；③ job 运行态复位（runCount=0/state null）；本地读面（W 产物目录）随 HEAD 复位一致回退，无残留无幻影文件。

**回退纪律（三期继承，逐项执行）**：
- 回退目标 HEAD **当场记录核对不凭记忆**；三端（裸仓/舰队克隆/本地）用同一目标值。
- 服务器侧 git 操作统一 fleet 身份（`runuser -u fleet --`），root 只做 chown/chgrp。
- job ID 用 `trimc cron list` 输出的**全量 UUID**（截断形式查不到 job）。
- 回退后 `chown -R fleet:fleet /srv/fleet/TriMetaverse/.git`（reset 可能重建 root 属主文件）。
- clean 限定路径域：`clean -fd docs/workflow/operating-records`，**不得全仓 clean**（防误删非迁移域文件）。

**三路径回退与恢复（init-to-collab-design §8.2/§8.3，2026-08-14 新增）**：

| 路径 | 失败面 | 回退 | 恢复 |
| --- | --- | --- | --- |
| a 自然触发 = 首个协同工作 | 迁移五段链失败 | 四件套回退到演练前 HEAD（先例同构） | 修复后 `trimc cron run <jobId>` 重跑（幂等）→ 重验收 |
| a 迁移成功但验收判定失败 | 证据/判定环节 | **不回退迁移**（W33→W34 平移已生效是生产事实；「首个协同工作 FAIL」≠ 回退迁移） | 补采证据 → 重判定；firstCollab 不写 passed |
| b 显式触发（确认后 run） | 显式 run 失败 | 同路径 a（迁移域） | 幂等重跑 → 重验收 |
| c 初始化未完成降级 | 迁移照常（不依赖初始化） | 同路径 a（迁移域） | 旧口径验收独立执行；初始化完成后补显式触发 |
| 任一路径 | — | **初始化域不回退**（init-sync bundle 域隔离，§8.3） | — |

**域隔离声明（§8.3）**：迁移回退**不回退初始化域**——回退命令只触 operating-records 域与 git ref；init-sync bundle（`docs/registry/init-sync/`，写权归初始化流）不在任何回退命令路径内（迁移脚本写权边界已限 operating-records，r1-2 现状）。回退演练后验证：服务器 applied.json（`/var/lib/trimc/init-sync/`）与本地 bundle 文件均不受演练影响。

## 6. 运行维护

- **per-run 日志轮转**：`/var/lib/trimc/cron/logs/` 随 runCount 增长无自动清理；周迁移 job 每周 1 条量级很小，暂不需 logrotate；若新增高频 job，按文件 mtime 定期清理旧日志（保留 90 天）或接 logrotate，当前不做（登记跟进项）。
- **/tmp/trimc-run.log 轮转（O2 观察项）**：trimc-start.sh 将服务控制台输出重定向到 `/tmp/trimc-run.log`（无轮转，含 cron 审计回显）。处置：在 `/etc/logrotate.d/trimc` 加轮转规则：
  ```
  /tmp/trimc-run.log {
      daily
      rotate 7
      missingok
      notifempty
      copytruncate
      compress
  }
  ```
  执行一次 `logrotate -f /etc/logrotate.d/trimc` 验证规则有效。
- **jobs.json 备份**：store 原子写自带 `.bak`（同目录 `jobs.json.bak`），备份保留最近一次；手工改 store 前先 `cp jobs.json jobs.json.manual-bak`。

## 7. 约束与纪律

- **时区口径（2026-08-24 CEO 统一：北京时间）**：schedule.timezone 全线 `Asia/Shanghai`（UTC+8）——原 `Asia/Singapore` 同偏移，触发时刻不变。已知漂移：cli.ts 预设 cron `0 23 * * 0` vs 现役 job `59 23 * * 0`（2026-08-16 手调），重装/复用预设前须先对齐现役值；CLI `cron update` 缺 `--timezone` 旗标且 `--cron` 会整体替换 schedule 对象丢 tz 字段（跟进项）。历史文档（W33 树 brief、FADE 论文、init-to-collab-design）按叙事冻结不改
- **周日触发前时钟三查（2026-08-24 增，防钟漂）**：① `chronyc tracking | grep 'System time'` 偏差 <1s；② `date -u` 对照权威源（`curl -sI https://www.baidu.com | grep -i ^date`）差 <2s；③ 超差先 `chronyc makestep` 校时再放行自然触发（`cron run` 兜底幂等，迁移窗口不受影响）。2026-08-24 基线实测：服务器 chronyd stratum 3 / 偏差 91µs，本地 w32tm 同步 ±2s，三方与权威源一致
- **迁移冻结窗口（2026-08-24 增，W34→W35 基线差异教训，CEO 定纪律）**：周日 **23:00 北京时间**前，本地研发仓须完成 `docs/workflow/operating-records/` 全部 commit 并推送 sg-server（编排层职责：`git push sg-server refs/heads/dev:refs/heads/dev`）；23:00 至周一回流完成期间**冻结本地对 operating-records/ 的一切写入**。效果：迁移 commit 落在真最新基 → 本地回流 fast-forward、零 merge 零冲突。反面案例（W34→W35 实测）：本地超前 101 commit 未推 → 迁移落旧基 `ae3d32fe` → 回流 merge + W34 index 冲突人工裁定 + W35 台账漏登 2 树（2026-08-24 补全，W35 v1.3.0）。服务器侧 fleet==bare 同步检查见 §5 前置条件，本条补齐本地→裸仓一环
- **周日全仓推送软习惯（2026-08-24 增，冻结窗口的姊妹条）**：周日 23:00 前顺手把全部仓（TriMetaverse/TriCompany/TriMMC 及其他活跃仓）的未推 commit 一并推送 sg-server——非迁移要求（迁移只读写 operating-records/，其他目录改动对其零影响），为的是周一回流纯 fast-forward、历史无多余合并节点。紧急周报若发生在迁移完成后可正常写、周一登进新周，真正禁区仅 23:00–23:59 迁移触发那一小时
- 代码修改一律本地发起（本地 → 裸仓 → 舰队克隆）；服务器只写周平面文件（生产级开发期 §三方向例外）
- 迁移窗口单实例：runningAtMs 守卫 + 单 systemd 实例
- ~~真迁移触发时机由编排层决定（硬 deadline 2026-08-16 23:59 前可触发 W33→W34）~~（历史条款，2026-08-24 注：该 deadline 属 W33 部署期首次上线的一次性决策，已过；现态=周日 23:59 北京时间自然触发的常驻主路径 + `cron run <全量UUID>` 兜底，无需每周人工定夺。2026-08-23 首次自然触发实证 pass）
- scheduler 未就绪时迁移走既有路径兜底（服务器手工执行同命令链）
