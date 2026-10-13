// ── M.5 Conflict Arbitration Unit Tests ──
// Tests for TriMMC/src/comm/arbitration.ts
// Covers: task double-assignment, version behind, idempotent tool calls, passthrough.

import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import {
  arbitrate,
  trackTaskAssignment,
  trackToolExecution,
  resetArbitrationState,
} from '../../src/comm/arbitration.js';

describe('arbitrate', () => {
  const nodeA = 'node-alpha';
  const nodeB = 'node-bravo';

  beforeEach(() => {
    resetArbitrationState();
  });

  it('accepts all events when no conflicts exist (passthrough)', () => {
    const events = [
      { eventId: 'e1', type: 'agent_run', timestamp: 1, seqNo: 1, payload: {} },
      { eventId: 'e2', type: 'agent_run', timestamp: 2, seqNo: 2, payload: {} },
      { eventId: 'e3', type: 'agent_run', timestamp: 3, seqNo: 3, payload: {} },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 3);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.lastSeqNo, 3);
  });

  it('rejects task_assign when task already assigned to another node', () => {
    trackTaskAssignment('task-1', nodeB);

    const events = [
      { eventId: 'e1', type: 'task_assign', timestamp: 1, seqNo: 1, payload: { taskId: 'task-1' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 0);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].resolution, 'rejected_duplicate');
    assert.ok(result.conflicts[0].reason.includes('task-1'));
  });

  it('accepts task_assign when same node assigns', () => {
    trackTaskAssignment('task-1', nodeA);

    const events = [
      { eventId: 'e1', type: 'task_assign', timestamp: 1, seqNo: 1, payload: { taskId: 'task-1' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 1);
    assert.equal(result.conflicts.length, 0);
  });

  it('rejects task_complete when task assigned to another node', () => {
    trackTaskAssignment('task-1', nodeB);

    const events = [
      { eventId: 'e1', type: 'task_complete', timestamp: 1, seqNo: 1, payload: { taskId: 'task-1' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 0);
    assert.equal(result.conflicts[0].resolution, 'rejected_duplicate');
  });

  it('rejects task_complete when task was never assigned', () => {
    const events = [
      { eventId: 'e1', type: 'task_complete', timestamp: 1, seqNo: 1, payload: { taskId: 'orphan-task' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 0);
    assert.equal(result.conflicts[0].resolution, 'rejected_version_behind');
  });

  it('accepts task_complete when task was assigned to same node', () => {
    trackTaskAssignment('task-1', nodeA);

    const events = [
      { eventId: 'e1', type: 'task_complete', timestamp: 1, seqNo: 1, payload: { taskId: 'task-1' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 1);
    assert.equal(result.conflicts.length, 0);
  });

  it('rejects tool_call when idempotency key already executed', () => {
    trackToolExecution('ik-duplicate');

    const events = [
      { eventId: 'e1', type: 'tool_call', timestamp: 1, seqNo: 1, payload: { idempotencyKey: 'ik-duplicate' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 0);
    assert.equal(result.conflicts[0].resolution, 'already_executed');
  });

  it('accepts tool_call when idempotency key not yet executed', () => {
    const events = [
      { eventId: 'e1', type: 'tool_call', timestamp: 1, seqNo: 1, payload: { idempotencyKey: 'ik-fresh' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 1);
    assert.equal(result.conflicts.length, 0);
  });

  it('handles mixed conflicts in a batch', () => {
    trackTaskAssignment('t1', nodeB);
    trackTaskAssignment('t2', nodeA); // t2 assigned to us → task_complete accepted
    trackToolExecution('ik-dupe');

    const events = [
      { eventId: 'e1', type: 'agent_run', timestamp: 1, seqNo: 1, payload: {} },
      { eventId: 'e2', type: 'task_assign', timestamp: 2, seqNo: 2, payload: { taskId: 't1' } },
      { eventId: 'e3', type: 'tool_call', timestamp: 3, seqNo: 3, payload: { idempotencyKey: 'ik-dupe' } },
      { eventId: 'e4', type: 'task_complete', timestamp: 4, seqNo: 4, payload: { taskId: 't2' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 2); // agent_run + task_complete(t2) accepted
    assert.equal(result.conflicts.length, 2); // t1 + ik-dupe rejected
    assert.equal(result.lastSeqNo, 4);
  });

  it('returns lastSeqNo 0 for empty events', () => {
    const result = arbitrate(nodeA, []);
    assert.equal(result.accepted, 0);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.lastSeqNo, 0);
  });

  it('unknown event types are accepted by default', () => {
    const events = [
      { eventId: 'e1', type: 'custom_event', timestamp: 1, seqNo: 1, payload: { foo: 'bar' } },
    ];

    const result = arbitrate(nodeA, events);
    assert.equal(result.accepted, 1);
    assert.equal(result.conflicts.length, 0);
  });
});
