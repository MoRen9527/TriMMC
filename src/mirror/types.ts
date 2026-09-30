// ── TriMMC Mirror Types ──
// S7: MirrorTask state model + API contract types.
// CPO Q6c + CTO §7.2 S7.

/** 镜像任务状态（CPO 6c 定义 + 扩展） */
export type MirrorTaskStatus =
  | 'pending'    // TriRLC 已提交，尚未开始执行
  | 'running'    // TriRLC 正在执行
  | 'success'    // 执行成功
  | 'failed'     // 执行失败
  | 'cancelled'  // 用户取消
  | 'unknown';   // TriRLC 离线，状态未知

/** terminal 状态集合（不可回退） */
export const TERMINAL_STATUSES: ReadonlySet<MirrorTaskStatus> = new Set([
  'success',
  'failed',
  'cancelled',
]);

/** 单个镜像任务 */
export interface MirrorTask {
  taskId: string;           // TriRLC sessionId（如 "sess_xxx"）
  nodeId: string;           // 来源 TriRLC 节点（如 "trilc-win-jedih"）
  title: string;            // 任务标题（首条用户消息截断 ≤80 chars）
  status: MirrorTaskStatus;
  summary: string;          // 进度摘要（≤500 chars，CPO 6c 约束）
  updatedAt: string;        // ISO 8601，TriRLC 最后上报时间
  lastSeenAt: string;       // ISO 8601，TriMMC 最后收到该任务心跳的时间
  // 以下字段由 TriMMC 服务端维护，不从 mirror payload 直接写入
  firstSeenAt: string;      // ISO 8601，TriMMC 首次收到该任务的时间
  version: number;          // 单调递增，每次 mirror 更新 +1
}

/** mirror 端点请求体 */
export interface MirrorRequest {
  nodeId: string;
  tasks: Array<{
    taskId: string;
    title: string;
    status: MirrorTaskStatus;   // TriRLC 侧只上报 pending/running/success/failed/cancelled
    summary: string;
    updatedAt: string;
  }>;
}

/** mirror 端点响应体 */
export interface MirrorResponse {
  ok: boolean;
  mirrored: number;         // 本次成功写入的任务数
}

/** GET /tasks 查询参数 */
export interface TaskQueryParams {
  nodeId?: string;          // 按节点过滤
  status?: MirrorTaskStatus;
  limit?: number;           // 默认 50
  offset?: number;          // 默认 0
}

/** GET /tasks 响应体 */
export interface TaskQueryResponse {
  tasks: MirrorTask[];
  total: number;
}
