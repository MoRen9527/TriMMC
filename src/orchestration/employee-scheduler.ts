// ── Employee Scheduler ──
// 5-state machine: queued → assigned → running → accepted/rejected → done
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §3.3

import type {
  EmployeeRecord,
  TaskRecord,
  TaskState,
  SchedulerConfig,
} from './types.js';

// ── Default Config ──

const DEFAULT_CONFIG: SchedulerConfig = {
  maxConcurrentTotal: 20,
  defaultTaskTimeoutMs: 300_000, // 5 minutes
  maxRetries: 3,
};

// ── State Machine ──

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued: ['assigned'],
  assigned: ['running', 'escalated', 'rejected'],
  running: ['accepted', 'rejected', 'escalated'],
  escalated: ['assigned', 'rejected'],
  accepted: ['done'],
  rejected: [],
  done: [],
};

function validateTransition(from: TaskState, to: TaskState): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed?.includes(to) ?? false;
}

// ── Concurrency Guard ──

function hasCapacity(
  employee: EmployeeRecord,
  activeTasks: TaskRecord[],
  config: SchedulerConfig,
): boolean {
  const employeeActive = activeTasks.filter(
    (t) => t.assignedTo === employee.employeeId && t.state === 'running',
  );
  return employeeActive.length < employee.maxConcurrentTasks;
}

// ── Public API ──

/**
 * Attempt a state transition on a task record.
 * Returns the updated record (immutable — new object).
 */
export function transition(
  task: TaskRecord,
  to: TaskState,
  reason?: string,
): { success: boolean; task: TaskRecord; error?: string } {
  if (!validateTransition(task.state, to)) {
    return {
      success: false,
      task,
      error: `Invalid transition: ${task.state} → ${to}. Valid transitions: ${VALID_TRANSITIONS[task.state].join(', ')}`,
    };
  }

  const updated: TaskRecord = {
    ...task,
    state: to,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, task: updated };
}

/**
 * Assign a task to an employee if they have capacity.
 */
export function assign(
  task: TaskRecord,
  employee: EmployeeRecord,
  activeTasks: TaskRecord[],
  config: SchedulerConfig = DEFAULT_CONFIG,
): { success: boolean; task: TaskRecord; error?: string } {
  if (task.state !== 'queued') {
    return { success: false, task, error: `Cannot assign task in state: ${task.state}` };
  }

  if (!hasCapacity(employee, activeTasks, config)) {
    return { success: false, task, error: `Employee ${employee.employeeId} has no capacity` };
  }

  const updated: TaskRecord = {
    ...task,
    state: 'assigned',
    assignedTo: employee.employeeId,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, task: updated };
}

/**
 * Escalate a task — transition to 'escalated' and clear assignee.
 */
export function escalate(
  task: TaskRecord,
  reason: string,
): { success: boolean; task: TaskRecord; error?: string } {
  const validStates: TaskState[] = ['assigned', 'running', 'escalated'];
  if (!validStates.includes(task.state)) {
    return {
      success: false,
      task,
      error: `Cannot escalate task in state: ${task.state}`,
    };
  }

  const updated: TaskRecord = {
    ...task,
    state: 'escalated',
    assignedTo: undefined,
    retryCount: task.retryCount + 1,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, task: updated };
}

/**
 * Check if a task has timed out.
 */
export function isTimedOut(task: TaskRecord, timeoutMs?: number): boolean {
  const ms = timeoutMs ?? DEFAULT_CONFIG.defaultTaskTimeoutMs;
  const startedAt = new Date(task.createdAt).getTime();
  return Date.now() - startedAt > ms;
}

/**
 * Get scheduler config (Phase A: defaults only).
 */
export function getConfig(): SchedulerConfig {
  return { ...DEFAULT_CONFIG };
}
