// ── Employee Scheduler Unit Tests ──
// 5-state machine, concurrency, timeouts
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §5.3

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { transition, assign, escalate, isTimedOut, getConfig } from '../../src/orchestration/employee-scheduler.js';
import type { EmployeeRecord, TaskRecord } from '../../src/orchestration/types.js';
import type { AgentContract } from '../../src/contracts/agent-contract.js';

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'test-task-1',
    type: 'design',
    priority: 'P1',
    description: 'Test task',
    expectedOutputs: ['design_doc'],
    state: 'queued',
    requester: 'CEO',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retryCount: 0,
    ...overrides,
  };
}

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    employeeId: 'test-employee',
    contract: { agent_id: 'Test', identity: { name: 'Test', display_name: 'T', family: 'Role', role: 'R', description: '', user_invocable: false }, responsibilities: [], decision_rights: { approve: [], freeze: [], escalate: [], forbid: [] }, collaborators: { reports_to: '', peers: [], supervises: [] }, tools: [], io_contract: { inputs: [], outputs: [] }, version: '1' } as AgentContract,
    status: { state: 'active', since: new Date().toISOString() },
    currentLoad: 0,
    maxConcurrentTasks: 2,
    activeSkills: [],
    costProfile: { dailyTokenBudget: 100_000, modelTier: 'balanced', maxCostPerTask: 2.0, monthlyCostCap: 50.0 },
    reportingChain: ['test-employee', 'manager'],
    ...overrides,
  };
}

describe('Employee Scheduler — transition()', () => {
  it('transitions queued → assigned', () => {
    const task = makeTask({ state: 'queued' });
    const result = transition(task, 'assigned');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'assigned');
  });

  it('transitions assigned → running', () => {
    const task = makeTask({ state: 'assigned' });
    const result = transition(task, 'running');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'running');
  });

  it('transitions running → accepted', () => {
    const task = makeTask({ state: 'running' });
    const result = transition(task, 'accepted');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'accepted');
  });

  it('transitions accepted → done', () => {
    const task = makeTask({ state: 'accepted' });
    const result = transition(task, 'done');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'done');
  });

  it('transitions running → rejected', () => {
    const task = makeTask({ state: 'running' });
    const result = transition(task, 'rejected');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'rejected');
  });

  it('transitions assigned → escalated', () => {
    const task = makeTask({ state: 'assigned' });
    const result = transition(task, 'escalated');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'escalated');
  });

  it('transitions escalated → assigned', () => {
    const task = makeTask({ state: 'escalated' });
    const result = transition(task, 'assigned');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'assigned');
  });

  // Invalid transitions
  it('rejects queued → running (skip assigned)', () => {
    const task = makeTask({ state: 'queued' });
    const result = transition(task, 'running');

    assert.strictEqual(result.success, false);
    assert.ok(result.error?.includes('Invalid transition'), `expected transition error, got: ${result.error}`);
  });

  it('rejects done → running (terminal state)', () => {
    const task = makeTask({ state: 'done' });
    const result = transition(task, 'running');

    assert.strictEqual(result.success, false);
  });

  it('rejects rejected → running (terminal state)', () => {
    const task = makeTask({ state: 'rejected' });
    const result = transition(task, 'running');

    assert.strictEqual(result.success, false);
  });

  it('does not mutate original task', () => {
    const task = makeTask({ state: 'queued' });
    const originalState = task.state;
    transition(task, 'assigned');

    assert.strictEqual(task.state, originalState, 'original task unchanged');
  });
});

describe('Employee Scheduler — assign()', () => {
  it('assigns queued task to employee with capacity', () => {
    const task = makeTask({ state: 'queued' });
    const emp = makeEmployee({ currentLoad: 0 });

    const result = assign(task, emp, []);

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'assigned');
    assert.strictEqual(result.task.assignedTo, 'test-employee');
  });

  it('rejects assignment when employee is at capacity', () => {
    const task = makeTask({ state: 'queued' });
    const emp = makeEmployee({ currentLoad: 2, maxConcurrentTasks: 2 });

    const activeTasks: TaskRecord[] = [
      makeTask({ taskId: 't1', state: 'running', assignedTo: 'test-employee' }),
      makeTask({ taskId: 't2', state: 'running', assignedTo: 'test-employee' }),
    ];

    const result = assign(task, emp, activeTasks);

    assert.strictEqual(result.success, false, 'should reject');
    assert.ok(result.error?.includes('capacity'));
  });

  it('rejects assignment for non-queued tasks', () => {
    const task = makeTask({ state: 'running' });
    const emp = makeEmployee();

    const result = assign(task, emp, []);

    assert.strictEqual(result.success, false);
  });

  it('ignores non-running tasks for capacity check', () => {
    const task = makeTask({ state: 'queued' });
    const emp = makeEmployee({ currentLoad: 0, maxConcurrentTasks: 1 });

    // These are assigned but not running — should not count toward capacity
    const activeTasks: TaskRecord[] = [
      makeTask({ taskId: 't1', state: 'assigned', assignedTo: 'test-employee' }),
      makeTask({ taskId: 't2', state: 'queued', assignedTo: 'test-employee' }),
    ];

    const result = assign(task, emp, activeTasks);

    assert.ok(result.success, 'should assign since assigned/queued tasks do not consume running slots');
  });
});

describe('Employee Scheduler — escalate()', () => {
  it('escalates from assigned state', () => {
    const task = makeTask({ state: 'assigned', assignedTo: 'test-employee' });
    const result = escalate(task, 'Budget exceeded');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'escalated');
    assert.strictEqual(result.task.assignedTo, undefined);
    assert.strictEqual(result.task.retryCount, 1);
  });

  it('escalates from running state', () => {
    const task = makeTask({ state: 'running', assignedTo: 'test-employee' });
    const result = escalate(task, 'Timeout');

    assert.ok(result.success);
    assert.strictEqual(result.task.state, 'escalated');
  });

  it('rejects escalation from queued state', () => {
    const task = makeTask({ state: 'queued' });
    const result = escalate(task, 'Invalid');

    assert.strictEqual(result.success, false);
  });

  it('rejects escalation from done state', () => {
    const task = makeTask({ state: 'done' });
    const result = escalate(task, 'Invalid');

    assert.strictEqual(result.success, false);
  });
});

describe('Employee Scheduler — isTimedOut()', () => {
  it('returns false for recent task', () => {
    const task = makeTask({ createdAt: new Date().toISOString() });
    assert.strictEqual(isTimedOut(task), false);
  });

  it('returns true for task created long ago', () => {
    const task = makeTask({ createdAt: new Date(Date.now() - 999_999_999).toISOString() });
    assert.ok(isTimedOut(task));
  });

  it('respects custom timeout', () => {
    const task = makeTask({ createdAt: new Date(Date.now() - 2_000).toISOString() });
    assert.ok(isTimedOut(task, 1)); // 1ms timeout → anything older is timed out
  });
});

describe('Employee Scheduler — getConfig()', () => {
  it('returns default config', () => {
    const config = getConfig();
    assert.strictEqual(config.maxConcurrentTotal, 20);
    assert.ok(config.defaultTaskTimeoutMs > 0);
    assert.strictEqual(config.maxRetries, 3);
  });
});
