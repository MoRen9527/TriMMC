# Claude Code 吸收共识（CEO 已批准）

> **Authority**: CEO 现场审查批准（2026-07-15）
> **Owner**: CTO 小狄（CTO-003）
> **COS 收口**: CEOChiefOfStaff 小贾
> **依赖**: `NA-20260713-CTO-003`（due 2026-07-24）

---

## 1. 当前状态

| Phase | 分析文档 | 分析质量 | TriMMC 当前吸收率 | 代码落地 |
|-------|---------|---------|-----------------|---------|
| 1 核心 Loop | `phase-1-core-loop-v2.md` | 25/25 PASS | **100% Tier 1** ✅ | `loop.ts` ~480行，streaming + 三级错误级联 + spread-replace state + abort |
| 2 Prompt 缓存 | `phase-2-prompt-cache-v2.md` | 25/25 PASS | **100% Tier 1** ✅ | `prompt-cache/` — SHA256 hash + change detection + cache hit 估算 |
| 3 Sub-Agent 树 | `phase-3-subagent-tree-v2.md` | 25/25 PASS | **100% Tier 1** ✅ | `sub-agent/` — spawnAgent + built-in agents + tools-resolve + loop integration（29 tests） |
| 4 工具权限 | `phase-4-tool-permission.md` | 25/25 PASS | **~60%（Tier 1 ✅）** | CTO-008/009/011 tier + Tool Gater + P4T1 PermissionEngine（规则系统+决策管道+PermissionMode）|

**更新于 2026-07-15 13:58**：Phase 1 Tier 1 + Phase 2 Tier 1 全部完成。P0 + P1(前半) 交付。
**更新于 2026-07-16**：Phase 4 Tier 1 全部完成。PermissionEngine（4 源文件 + 1 测试文件，53 tests）集成到 loop.ts 双层级权限检查（engine → tier+gater）。P1(后半) 交付。
**更新于 2026-07-17**：Phase 3 Tier 1 全部完成。Sub-Agent 模块（5 源文件 + 1 测试文件，29 tests）—— built-in agents + tools-resolve + spawnAgent + loop task handler 集成。P2 交付。

**结论**：四阶段分析全部完成（小全 + 小柯验证），Tier 1 吸收全部完成（Phase 1/2/3/4）。P0/P1/P2 全部交付。剩余 P3（Tier 2-4）远期。

---

## 2. CEO 批准的吸收优先级

```
P0（立即，W29）  Phase 2 Tier 1 — Cache annotation（cache_control markers）
                理由：每次 API 调用都重发完整 system prompt + tools，烧冤枉钱。
                      改动量小（~200行）ROI 极高（30+ turn 会话 ~85% 命中率，省 ~80% input tokens）。

P1（W29-W30）   Phase 1 Tier 1 — Streaming 执行 + 分层错误恢复级联
                理由：当前 loop.ts catch→yield error 过于脆弱，需要 model hiccup
                      → model swap → session terminate 三级恢复。

P1（W30）       Phase 4 Tier 1 — 规则系统 + 决策管道 + PermissionMode
                理由：当前无独立安全决策管道，完全依赖宿主 Copilot CLI 默认策略。
                      Safety Check（bypass-immune）必须在任何 bypassPermissions 能力之前落地。

P2（W30-W31）   Phase 3 Tier 1 — Agent spawn + 三态执行 + tools resolve
                前提：Phase 2 缓存必须先落地（Fork 子代理共享父 prompt cache）。

P3（远期）       各 Phase Tier 2-4
                - Phase 1 Tier 2: Compaction + Token 管理
                - Phase 2 Tier 2: Break detection（可观测性）
                - Phase 2 Tier 3: cache_edits（高级优化，需 Phase 3 后）
                - Phase 3 Tier 2: Fork cache 共享 + Worktree 隔离
                - Phase 3 Tier 3: Memory/Transcript/Resume
                - Phase 3 Tier 4: Custom Agent + Plugin
                - Phase 4 Tier 2: 路径验证 + Safety Check + 拒绝追踪
                - Phase 4 Tier 3: YOLO Classifier + 分类器白名单 + 权限解释器
                - Phase 4 Tier 4: Kill Switch + Shadow Rule 检测 + 模式转换 UI
```

---

## 3. 吸收档位定义

| Tier | 含义 | 准入标准 |
|------|------|---------|
| **Tier 1 (MVP)** | 必须吸收才能进入下一阶段 | 吸收后 TriMMC 具备该维度的最小可行能力 |
| **Tier 2 (Optimize)** | 成本/性能/安全增强 | Tier 1 稳定运行后择机启动 |
| **Tier 3 (Observe)** | 可观测性 + 高级能力 | 需 Tier 1-2 数据积累后评估 |
| **Tier 4 (Extend)** | 生态扩展 | TriMMC 正式宿主阶段再评估 |

---

## 4. 关键依赖链

```
Phase 2 Tier 1 (Cache) ──→ Phase 3 Tier 1 (Sub-Agent，Fork 共享缓存)
                       ──→ 当前所有 API 调用省钱（独立价值）

Phase 1 Tier 1 (Loop)  ──→ 所有 Phase 的运行时基础（独立价值）

Phase 4 Tier 1 (Perms) ──→ CTO-008/009/011 的下一步（独立价值）

Phase 3 Tier 1 (Agent) ──→ 依赖 Phase 2 缓存 + Phase 1 稳定 loop
```

---

## 5. CTO 行动项

| ID | 动作 | Phase | Tier | 预计改动 | 建议窗口 | 状态 |
|----|------|-------|------|---------|---------|------|
| CTO-003-P2T1 | 实现 cache_control annotation（`getCacheControl()` + system prompt blocks + last message） | 2 | 1 | ~200行 | W29 立即 | ✅ 完成 2026-07-15 |
| CTO-003-P1T1 | 重构 loop.ts：Streaming + 三级错误恢复级联 + spread-replace state | 1 | 1 | ~500行 | W29-W30 | ✅ 完成 2026-07-15 |
| CTO-003-P4T1 | 实现规则系统（PermissionRule + 8源优先级）+ 决策管道 + PermissionMode + Safety Check（bypass-immune） | 4 | 1 | ~1000行（4 engine src + 1 test + loop.ts 集成） | W30 | ✅ 完成 2026-07-16 |
| CTO-003-P3T1 | 实现 AgentTool.call() → spawn + 三态执行 + tools resolve | 3 | 1 | ~600行 | W30-W31 | ✅ 完成 2026-07-17 |

---

## 6. 治理

- **变更权限**：优先级变更需 CEO 重新审批。Tier 内具体实现方案由 CTO 自主决定。
- **进度同步**：每个 P0/P1 行动项完成后，CTO 更新本文件状态 + W29 JSON `NA-20260713-CTO-003`。
- **冲突裁决**：若实现中遇到与中央 BusinessStrategy 边界冲突，升级至 CEOChiefOfStaff。
- **真源**：本文件为 Claude Code 吸收的 registry 级共识真源。分析文档（`phase-*-v2.md`）为技术参考，冲突时以本文件优先级为准。

---

> **CEO 批准**: 2026-07-15 12:03 CST
> **下次审查**: CTO-003 due 2026-07-24 或 P0 完成后
