/**
 * Cron module — TriMMC 服务域定时任务适配器（cron 域）。
 *
 * 命名边界（r1-1 方案 §2.1 定案点①）：
 *   - `src/orchestration/employee-scheduler.ts` = 员工任务调度/排班（agent 域）
 *   - `src/cron/` = 定时任务（cron 域），本目录
 *   - 共享调度核心位于 @tricompany/agent-core（TriCompany/packages/agent-core），
 *     本目录只是服务域装配面，不移植、不复制 TriRLC cron（parity V1.1 §1）。
 *
 * 行为对标基准：TriRLC src/cron 的 CLI 契约与 HTTP 路由语义。
 */

export {
  createCronService,
  type CronService,
  type CronServiceOptions,
  type CronLogEntry,
  type CronLogStatus,
  type CronStatus,
  type CronRunResult,
} from './service.js';
export {
  createCommandHandler,
  DEFAULT_JOB_TIMEOUT_MS,
  type CommandHandler,
  type CommandHandlerOptions,
  type CommandJobPayload,
} from './command-handler.js';
export {
  computeWeekShiftTokens,
  isoWeekOf,
  formatIsoWeek,
  type WeekShiftTokens,
} from './week-math.js';
export {
  createCronRouteHandler,
  type CronRouteHandler,
} from './routes.js';
