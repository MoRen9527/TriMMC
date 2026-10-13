// ── MirrorStore Node Heartbeat Tests ──
// heartbeat-dualrun-contract v1.0 §3.1/3.2/3.3: TriMMC 侧节点心跳表接线
// 验收（契约 §六.2）：登记 → 30s 标 unknown → degraded 180s 不误判 → 2 次回归 known

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MirrorStore } from '../../src/mirror/store.js';

const NOW = 1_700_000_000_000;

describe('MirrorStore node heartbeat (dualrun contract v1.0)', () => {
  it('records heartbeats into the node table', () => {
    const store = new MirrorStore();
    store.recordNodeHeartbeat('node-a', 'connected', NOW);
    store.recordNodeHeartbeat('node-a', 'connected', NOW + 1);

    const hb = store.getNodeHeartbeat('node-a');
    assert.ok(hb, 'node should be registered');
    assert.equal(hb!.state, 'connected');
    assert.equal(hb!.consecutiveHbs, 2);
    assert.equal(hb!.unknown, false);
    assert.equal(store.heartbeatCount, 1);
  });

  it('marks node unknown after 3×interval (30s) without heartbeat', () => {
    const store = new MirrorStore();
    store.recordNodeHeartbeat('node-a', 'connected', NOW);

    // 30s 内不标
    assert.equal(store.scanStaleNodes(30_000, 180_000, NOW + 29_000), 0);
    assert.equal(store.getNodeHeartbeat('node-a')!.unknown, false);

    // 超 30s → unknown
    assert.equal(store.scanStaleNodes(30_000, 180_000, NOW + 31_000), 1);
    assert.equal(store.getNodeHeartbeat('node-a')!.unknown, true);
  });

  it('uses 180s relaxed threshold for degraded nodes (slow heartbeat not misjudged)', () => {
    const store = new MirrorStore();
    store.recordNodeHeartbeat('node-d', 'degraded', NOW);

    // degraded 节点 60s 慢心跳 ×2 后：距上次 100s，常规阈值早已超，宽松阈值未超 → 不误判
    assert.equal(store.scanStaleNodes(30_000, 180_000, NOW + 100_000), 0);
    assert.equal(store.getNodeHeartbeat('node-d')!.unknown, false);

    // 超 180s → unknown
    assert.equal(store.scanStaleNodes(30_000, 180_000, NOW + 181_000), 1);
    assert.equal(store.getNodeHeartbeat('node-d')!.unknown, true);
  });

  it('recovers node to known after 2 consecutive heartbeats', () => {
    const store = new MirrorStore();
    store.recordNodeHeartbeat('node-a', 'connected', NOW);
    store.scanStaleNodes(30_000, 180_000, NOW + 31_000); // → unknown
    assert.equal(store.getNodeHeartbeat('node-a')!.unknown, true);

    store.recordNodeHeartbeat('node-a', 'connected', NOW + 40_000); // 1st after unknown
    assert.equal(store.getNodeHeartbeat('node-a')!.unknown, true, 'still unknown after 1 heartbeat');

    store.recordNodeHeartbeat('node-a', 'connected', NOW + 50_000); // 2nd → known
    assert.equal(store.getNodeHeartbeat('node-a')!.unknown, false, 'recovered after 2 heartbeats');
  });

  it('markNodeUnknown marks non-terminal tasks of the node', () => {
    const store = new MirrorStore();
    store.mirror('node-a', [
      {
        taskId: 't1',
        title: 'running task',
        status: 'running',
        summary: 's',
        updatedAt: new Date(NOW).toISOString(),
      },
    ]);

    store.recordNodeHeartbeat('node-a', 'connected', NOW);
    store.scanStaleNodes(30_000, 180_000, NOW + 31_000);

    const tasks = store.query({ nodeId: 'node-a' });
    const t1 = tasks.tasks.find((t) => t.taskId === 't1');
    assert.equal(t1!.status, 'unknown');
  });
});
