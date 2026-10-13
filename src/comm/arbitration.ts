// ── TriMMC Conflict Arbitration ──
// Detects and resolves conflicts when TriRLC nodes replay offline events.
// CTO-008-M §3.3.3: winner-takes-last, apply-offline-changes, already_executed.
//
// Architecture constraint (MVP): TriMMC does not yet have a shared task-state store.
// Until a proper task DB arrives, conflict detection operates on a simple in-memory
// tracking map keyed by event type + payload identity.

/** A conflict found during event replay. */
export interface ConflictItem {
  eventId: string;
  type: string;
  resolution: ConflictResolution;
  reason: string;
}

export type ConflictResolution =
  | 'rejected_duplicate'
  | 'rejected_version_behind'
  | 'already_executed'
  | 'merged';

/** An event submitted for replay. */
export interface ReplayEvent {
  eventId: string;
  type: string;
  timestamp: number;
  seqNo: number;
  payload: unknown;
}

/** The result of arbitrating a batch of replay events. */
export interface ArbitrationResult {
  accepted: number;
  conflicts: ConflictItem[];
  lastSeqNo: number;
}

// ── In-memory tracking (MVP passthrough with framework) ──
// In production this will be replaced by a SQLite / PostgreSQL table.

const taskAssignments = new Map<string, string>(); // taskId → assignedNodeId
const executedToolCalls = new Set<string>();       // idempotencyKey
const nodeStateVersions = new Map<string, number>(); // nodeId → version

/**
 * Detect conflicts in a batch of replay events against TriMMC-side state.
 *
 * Current MVP behavior:
 * - `agent_run` events: always accepted (no conflict detection for now)
 * - `task_complete` / `task_assign` events: check taskId double-assignment
 * - `tool_call` events: check idempotency key
 */
export function arbitrate(
  nodeId: string,
  events: ReplayEvent[],
): ArbitrationResult {
  const conflicts: ConflictItem[] = [];
  let accepted = 0;

  for (const event of events) {
    const conflict = detectConflict(nodeId, event);
    if (conflict) {
      conflicts.push(conflict);
    } else {
      accepted++;
    }
  }

  const lastSeqNo = events.length > 0
    ? events[events.length - 1].seqNo
    : 0;

  return { accepted, conflicts, lastSeqNo };
}

function detectConflict(nodeId: string, event: ReplayEvent): ConflictItem | null {
  switch (event.type) {
    case 'task_assign': {
      const taskId = (event.payload as Record<string, unknown>)?.taskId;
      if (typeof taskId !== 'string') return null;

      const assignedTo = taskAssignments.get(taskId);
      if (assignedTo && assignedTo !== nodeId) {
        // Task already assigned to a different node — reject
        return {
          eventId: event.eventId,
          type: event.type,
          resolution: 'rejected_duplicate',
          reason: `task ${taskId} already assigned to ${assignedTo}`,
        };
      }
      // Track assignment for this node
      taskAssignments.set(taskId, nodeId);
      return null;
    }

    case 'task_complete': {
      const taskId = (event.payload as Record<string, unknown>)?.taskId;
      if (typeof taskId !== 'string') return null;

      const assignedTo = taskAssignments.get(taskId);
      if (!assignedTo) {
        // Task was never assigned — this node may have stale state
        return {
          eventId: event.eventId,
          type: event.type,
          resolution: 'rejected_version_behind',
          reason: `task ${taskId} not found in server assignments`,
        };
      }
      if (assignedTo !== nodeId) {
        return {
          eventId: event.eventId,
          type: event.type,
          resolution: 'rejected_duplicate',
          reason: `task ${taskId} was completed by ${assignedTo}`,
        };
      }
      return null;
    }

    case 'tool_call': {
      const idempotencyKey = (event.payload as Record<string, unknown>)?.idempotencyKey;
      if (typeof idempotencyKey === 'string' && executedToolCalls.has(idempotencyKey)) {
        return {
          eventId: event.eventId,
          type: event.type,
          resolution: 'already_executed',
          reason: `tool_call ${idempotencyKey} already executed`,
        };
      }
      if (typeof idempotencyKey === 'string') {
        executedToolCalls.add(idempotencyKey);
      }
      return null;
    }

    default:
      // Unknown event types: accept by default (no conflict)
      return null;
  }
}

/**
 * Track a task assignment on the server side (called when TriMMC assigns a task).
 */
export function trackTaskAssignment(taskId: string, nodeId: string): void {
  taskAssignments.set(taskId, nodeId);
}

/**
 * Track an executed tool call (called when TriMMC executes a tool).
 */
export function trackToolExecution(idempotencyKey: string): void {
  executedToolCalls.add(idempotencyKey);
}

/**
 * Reset all arbitration state (for testing).
 */
export function resetArbitrationState(): void {
  taskAssignments.clear();
  executedToolCalls.clear();
  nodeStateVersions.clear();
}
