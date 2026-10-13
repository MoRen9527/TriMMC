// ── TriMMC MirrorStore ──
// S7: In-memory task mirror storage with CRUD + markUnknown.
// MVP uses Map<string, MirrorTask> — post-MVP migrates to SQLite/PG.
// CPO Q6c + CTO §7.2 S7 §2.3.

import type {
  MirrorTask,
  MirrorTaskStatus,
  MirrorRequest,
  MirrorResponse,
  TaskQueryParams,
  TaskQueryResponse,
} from './types.js';
import { TERMINAL_STATUSES } from './types.js';

/** 最大 summary 长度 */
const MAX_SUMMARY_LENGTH = 500;

function buildKey(nodeId: string, taskId: string): string {
  return `${nodeId}:${taskId}`;
}

/** 节点心跳登记（heartbeat-dualrun-contract v1.0 §3.1/3.2） */
export interface NodeHeartbeatRecord {
  lastSeenAt: number;      // epoch ms
  state: string;           // 心跳 payload state（connected/degraded/local）
  consecutiveHbs: number;  // 连续心跳计数（回归 known 判定）
  unknown: boolean;        // 当前是否被标 unknown
}

export class MirrorStore {
  private tasks = new Map<string, MirrorTask>();  // key = `${nodeId}:${taskId}`
  private nodeHeartbeats = new Map<string, NodeHeartbeatRecord>();
  private versionCounter = 0;

  /**
   * 登记节点心跳（heartbeat 端点调用）。
   * 节点此前 unknown 且连续 2 次心跳 → 回归 known（契约 3.3，与 TriRLC recoverThreshold=2 对称）。
   * @param now 时钟注入（测试用，默认 Date.now()）
   */
  recordNodeHeartbeat(nodeId: string, state: string, now = Date.now()): void {
    const existing = this.nodeHeartbeats.get(nodeId);
    if (!existing) {
      this.nodeHeartbeats.set(nodeId, {
        lastSeenAt: now,
        state,
        consecutiveHbs: 1,
        unknown: false,
      });
      return;
    }
    existing.lastSeenAt = now;
    existing.state = state;
    existing.consecutiveHbs = Math.min(existing.consecutiveHbs + 1, 100);
    if (existing.unknown && existing.consecutiveHbs >= 2) {
      existing.unknown = false;
      existing.consecutiveHbs = 0;  // 回归后重置，避免溢出
      console.log(`[trimc:mirror] node recovered (2 heartbeats): ${nodeId}`);
    }
  }

  /** 读取节点心跳记录（测试/诊断用）。 */
  getNodeHeartbeat(nodeId: string): NodeHeartbeatRecord | undefined {
    return this.nodeHeartbeats.get(nodeId);
  }

  /** 节点心跳表大小（测试/诊断用）。 */
  get heartbeatCount(): number {
    return this.nodeHeartbeats.size;
  }

  /**
   * 扫描心跳表，超阈值节点 → markNodeUnknown。
   * 双阈值（契约 3.2）：state=degraded 节点用 180s 宽松阈值（覆盖 60s 慢心跳 ×3 防误判），
   * 其余 30s（3×interval，与 TriRLC failThreshold=3 对称）。
   * @returns 本次被标 unknown 的节点数
   */
  scanStaleNodes(
    staleMs = 30_000,
    degradedStaleMs = 180_000,
    now = Date.now(),
  ): number {
    let marked = 0;
    for (const [nodeId, hb] of this.nodeHeartbeats) {
      if (hb.unknown) continue;
      const threshold = hb.state === 'degraded' ? degradedStaleMs : staleMs;
      if (now - hb.lastSeenAt > threshold) {
        this.markNodeUnknown(nodeId);
        hb.unknown = true;
        hb.consecutiveHbs = 0;
        marked++;
        console.warn(`[trimc:mirror] node stale → unknown: ${nodeId} (state=${hb.state}, lastSeen=${now - hb.lastSeenAt}ms ago)`);
      }
    }
    return marked;
  }

  /**
   * 写入/更新一批镜像任务。
   *
   * 规则：
   * - 新 taskId → 插入，firstSeenAt = now
   * - 已有 taskId → 只更新 status/summary/updatedAt/lastSeenAt，version+1
   * - 不允许 status 从 terminal 回退到非 terminal（CPO 6c: TriRLC 是权威方，
   *   但 TriMMC 做基本防御：如果现有状态是 success/failed/cancelled 且新状态
   *   是 running，记录 warning 但仍接受——因为可能是 TriRLC 恢复后的全量推送）
   */
  mirror(nodeId: string, tasks: MirrorRequest['tasks']): number {
    const now = new Date().toISOString();
    let mirrored = 0;

    for (const t of tasks) {
      const key = buildKey(nodeId, t.taskId);
      const existing = this.tasks.get(key);

      // 截断 summary
      const summary = t.summary.length > MAX_SUMMARY_LENGTH
        ? t.summary.slice(0, MAX_SUMMARY_LENGTH - 3) + '...'
        : t.summary;

      if (!existing) {
        // 新任务：插入
        const task: MirrorTask = {
          taskId: t.taskId,
          nodeId,
          title: t.title,
          status: t.status,
          summary,
          updatedAt: t.updatedAt,
          lastSeenAt: now,
          firstSeenAt: now,
          version: ++this.versionCounter,
        };
        this.tasks.set(key, task);
        mirrored++;
      } else {
        // 已有任务：增量更新
        // terminal defense: 如果现有状态是 terminal 且新状态是 running，接受但记录
        if (TERMINAL_STATUSES.has(existing.status) && t.status === 'running') {
          // TriRLC 恢复后的全量推送 — 接受但记录 warning
          console.warn(
            `[trimc:mirror] terminal→running accepted (recovery push): ` +
            `${nodeId}/${t.taskId} ${existing.status}→${t.status}`,
          );
        }

        // 检查是否有实际变更（幂等）
        const changed =
          existing.status !== t.status ||
          existing.summary !== summary ||
          existing.title !== t.title;

        if (changed) {
          existing.status = t.status;
          existing.summary = summary;
          existing.title = t.title;
          existing.updatedAt = t.updatedAt;
          existing.lastSeenAt = now;
          existing.version = ++this.versionCounter;
          mirrored++;
        } else {
          // 仅更新 lastSeenAt（心跳）
          existing.lastSeenAt = now;
        }
      }
    }

    return mirrored;
  }

  /**
   * 标记某节点所有非 terminal 任务为 unknown。
   * 由 heartbeat handler 在检测到节点超时时调用。
   */
  markNodeUnknown(nodeId: string): number {
    const now = new Date().toISOString();
    let count = 0;

    for (const [key, task] of this.tasks) {
      if (task.nodeId === nodeId && !TERMINAL_STATUSES.has(task.status)) {
        task.status = 'unknown';
        task.updatedAt = now;
        task.version = ++this.versionCounter;
        count++;
      }
    }

    return count;
  }

  /** 查询任务列表 */
  query(params: TaskQueryParams = {}): TaskQueryResponse {
    const { nodeId, status, limit = 50, offset = 0 } = params;

    let tasks: MirrorTask[] = [];

    // 默认不返回 unknown 超过 1 小时的任务（可配置）
    const maxUnknownAgeMs = 60 * 60 * 1000;
    const now = Date.now();

    for (const task of this.tasks.values()) {
      if (nodeId && task.nodeId !== nodeId) continue;
      if (status && task.status !== status) continue;

      // 过滤过期 unknown
      if (task.status === 'unknown') {
        const age = now - new Date(task.lastSeenAt).getTime();
        if (age > maxUnknownAgeMs) continue;
      }

      tasks.push(task);
    }

    // 按 updatedAt 降序排序
    tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const total = tasks.length;
    tasks = tasks.slice(offset, offset + limit);

    return { tasks, total };
  }

  /** 单任务查询 */
  getTask(nodeId: string, taskId: string): MirrorTask | undefined {
    return this.tasks.get(buildKey(nodeId, taskId));
  }

  /** 获取某节点所有活跃（非 terminal）任务，用于恢复后全量推送 */
  getActiveByNode(nodeId: string): MirrorTask[] {
    const active: MirrorTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.nodeId === nodeId && !TERMINAL_STATUSES.has(task.status)) {
        active.push(task);
      }
    }
    return active;
  }

  /**
   * 清理 terminal 状态超过指定毫秒数的旧任务。
   * 防止内存无限增长。
   * @param maxAgeMs 最大保留时间（默认 24 小时）
   */
  cleanup(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, task] of this.tasks) {
      if (TERMINAL_STATUSES.has(task.status)) {
        const age = now - new Date(task.lastSeenAt).getTime();
        if (age > maxAgeMs) {
          this.tasks.delete(key);
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  /** 获取当前总任务数 */
  get size(): number {
    return this.tasks.size;
  }
}
