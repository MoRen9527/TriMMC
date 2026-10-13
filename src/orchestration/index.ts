// ── Employee Orchestration Layer ──
// Re-exports for TriMMC/src/orchestration/

export * from './types.js';
export { loadEmployeeRegistry } from './employee-registry.js';
export type { LoadResult } from './employee-registry.js';
export { route } from './capability-router.js';
export { transition, assign, escalate, isTimedOut, getConfig } from './employee-scheduler.js';
export { estimateCost, checkBudget, recordCost, getBudgetState, getModelTierPolicy, resetBudget } from './cost-controller.js';
export { dispatch, dispatchAsync } from './dispatch-proxy.js';
export type { DispatchDeps, AsyncDispatchDeps, DispatchExecutor, DispatchExecutorContext } from './dispatch-proxy.js';
export { spawnSession, listAgents, sendMessage, buildRegistry } from './session-bridge.js';
export type { AgentSession, SessionBridgeOptions, SpawnResult, SendMessageResult } from './session-bridge.js';
