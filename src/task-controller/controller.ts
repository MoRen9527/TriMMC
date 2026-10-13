// ── Task Controller — Agent Loop Task Lifecycle Manager ──
// TriMMC v0.1.0: In-memory task CRUD with state machine enforcement.

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';
export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  taskId: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  controller: 'trimc-main';
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  /** M1 Phase-2: 执行结果回写（session-bridge 回复或错误） */
  result?: string;
  error?: string;
}

// Backward-compatible placeholder type (pre-CTO-007)
export type AcceptedTaskPlaceholder = {
  taskId: string;
  controller: 'trimc-main';
  status: 'accepted';
  queueStatus: 'queued';
};

// ── State Machine ──

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued:   ['running', 'cancelled'],
  running:  ['completed', 'failed', 'cancelled'],
  completed: [], // terminal
  failed:    [], // terminal
  cancelled: [], // terminal
};

const TERMINAL_STATUSES: Set<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

// ── Controller ──

export class TaskController {
  private tasks = new Map<string, Task>();
  private idCounter = 0;

  // ── Core CRUD ──

  createTask(description: string, priority: TaskPriority = 'normal'): Task {
    if (!description || description.trim().length === 0) {
      throw new Error('Task description must not be empty');
    }
    this.idCounter++;
    const taskId = `task_${this.idCounter}`;
    const now = new Date().toISOString();
    const task: Task = {
      taskId,
      description: description.trim(),
      status: 'queued',
      priority,
      controller: 'trimc-main',
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(taskId, task);
    return { ...task };
  }

  getTask(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  listTasks(filter?: { status?: TaskStatus; priority?: TaskPriority }): Task[] {
    let result = [...this.tasks.values()];
    if (filter?.status) {
      result = result.filter(t => t.status === filter.status);
    }
    if (filter?.priority) {
      result = result.filter(t => t.priority === filter.priority);
    }
    return result.map(t => ({ ...t }));
  }

  // ── State Machine ──

  updateTaskStatus(taskId: string, status: TaskStatus): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new Error(
        `Cannot transition from terminal status "${task.status}" to "${status}" (task: ${taskId})`
      );
    }
    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(status)) {
      throw new Error(
        `Invalid transition from "${task.status}" to "${status}". Allowed: [${allowed.join(', ')}]`
      );
    }
    task.status = status;
    task.updatedAt = new Date().toISOString();
    return { ...task };
  }

  /** M1 Phase-2: 结果回写（completed 时挂 reply，failed 时挂 error） */
  completeTask(taskId: string, result: string): Task {
    const task = this.updateTaskStatus(taskId, 'completed');
    task.result = result;
    task.updatedAt = new Date().toISOString();
    return { ...task };
  }

  failTask(taskId: string, error: string): Task {
    const task = this.updateTaskStatus(taskId, 'failed');
    task.error = error;
    task.updatedAt = new Date().toISOString();
    return { ...task };
  }

  // ── Backward Compatibility ──

  acceptPlaceholder(): AcceptedTaskPlaceholder {
    const task = this.createTask('placeholder');
    return {
      taskId: task.taskId,
      controller: 'trimc-main',
      status: 'accepted',
      queueStatus: 'queued',
    };
  }

  // ── Internal (testing / debugging) ──

  /** Returns the number of tasks currently stored. */
  get taskCount(): number {
    return this.tasks.size;
  }

  /** Clears all tasks. For test isolation only. */
  reset(): void {
    this.tasks.clear();
    this.idCounter = 0;
  }
}