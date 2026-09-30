// ── TriMMC Tool Gater Tests ──
// CTO-011: Tests for unified tool permission check (tier + risk-level).
// Covers: checkToolPermission, createToolGater, summarizeGater.
// Pattern: 小柯验证 — block-level tests for each gater function.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkToolPermission,
  createToolGater,
  summarizeGater,
} from '../../src/tool-gater/gater.js';
import type { ToolSpec, AgentTier } from '../../src/tool-gater/gater.js';

// ── Test Fixtures ──

function makeSpec(
  name: string,
  risk: ToolSpec['risk_level'],
  requiresApproval = false,
): ToolSpec {
  return {
    name,
    scope: ['*'],
    risk_level: risk,
    requires_approval: requiresApproval,
    runtime_equivalent: `builtin:${name}`,
  };
}

const lowSpec = makeSpec('read_file', 'low');
const medSpec = makeSpec('shell_exec', 'medium');
const highSpec = makeSpec('write_file', 'high');
const critSpec = makeSpec('task', 'critical');

const MIXED_SPECS: ToolSpec[] = [lowSpec, medSpec, highSpec, critSpec];

// ── Suite 1: checkToolPermission — tier checks (no toolSpecs) ──

describe('checkToolPermission — tier checks (no toolSpecs)', () => {
  it('main tier: all tools allowed', () => {
    const r = checkToolPermission('read_file', 'main');
    assert.equal(r.allowed, true);
  });

  it('main tier: unknown tool still allowed', () => {
    const r = checkToolPermission('nonexistent_tool', 'main');
    assert.equal(r.allowed, true);
  });

  it('subagent: read_file allowed', () => {
    const r = checkToolPermission('read_file', 'subagent');
    assert.equal(r.allowed, true);
  });

  it('subagent: task blocked (no recursion)', () => {
    const r = checkToolPermission('task', 'subagent');
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('anti-recursion guard'));
  });

  it('coordinator: task allowed (only tool)', () => {
    const r = checkToolPermission('task', 'coordinator');
    assert.equal(r.allowed, true);
  });

  it('coordinator: read_file blocked', () => {
    const r = checkToolPermission('read_file', 'coordinator');
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('requires tier "subagent" or higher'));
  });
});

// ── Suite 2: checkToolPermission — risk-level checks (with toolSpecs) ──

describe('checkToolPermission — risk-level checks (with toolSpecs)', () => {
  it('low risk: always allowed', () => {
    const r = checkToolPermission('read_file', 'main', MIXED_SPECS);
    assert.equal(r.allowed, true);
  });

  it('medium risk: allowed with audit reason', () => {
    const r = checkToolPermission('shell_exec', 'main', MIXED_SPECS);
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'allowed_with_audit');
  });

  it('high risk: blocked (approval required)', () => {
    const r = checkToolPermission('write_file', 'main', MIXED_SPECS);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('[risk:high]'));
    assert.ok(r.reason?.includes('approval_required'));
  });

  it('critical risk: blocked (denied no override)', () => {
    const r = checkToolPermission('task', 'main', MIXED_SPECS);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('[risk:critical]'));
    assert.ok(r.reason?.includes('denied_no_override'));
  });

  it('tool not in specs: tier-only check, no risk eval', () => {
    const r = checkToolPermission('glob_search', 'subagent', MIXED_SPECS);
    assert.equal(r.allowed, true);
  });

  it('empty toolSpecs array: same as no specs', () => {
    const r = checkToolPermission('write_file', 'main', []);
    assert.equal(r.allowed, true);
  });

  it('subagent + high risk: tier wins (task blocked before risk check)', () => {
    const r = checkToolPermission('task', 'subagent', MIXED_SPECS);
    assert.equal(r.allowed, false);
    // tier check comes first — blocked by tier, not risk
    assert.ok(r.reason?.includes('anti-recursion guard'));
  });
});

// ── Suite 3: createToolGater — factory ──

describe('createToolGater — factory', () => {
  it('bound gater with mixed specs blocks high risk tools', () => {
    const gater = createToolGater(MIXED_SPECS);
    const r = gater('write_file', 'main');
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('[risk:high]'));
  });

  it('bound gater allows low risk tools', () => {
    const gater = createToolGater(MIXED_SPECS);
    const r = gater('read_file', 'main');
    assert.equal(r.allowed, true);
  });

  it('bound gater with no specs: tier-only check', () => {
    const gater = createToolGater(undefined);
    const r = gater('task', 'subagent');
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('anti-recursion guard'));
  });

  it('bound gater with no specs: main always allows', () => {
    const gater = createToolGater(undefined);
    const r = gater('write_file', 'main');
    assert.equal(r.allowed, true);
  });

  it('bound gater respects tier before specs', () => {
    const gater = createToolGater(MIXED_SPECS);
    const r = gater('read_file', 'coordinator');
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('requires tier "subagent" or higher'));
  });
});

// ── Suite 4: summarizeGater ──

describe('summarizeGater', () => {
  it('empty specs: zero tools', () => {
    const s = summarizeGater([]);
    assert.equal(s.totalTools, 0);
    assert.deepEqual(s.highRiskTools, []);
    assert.deepEqual(s.criticalRiskTools, []);
  });

  it('undefined specs: zero tools', () => {
    const s = summarizeGater(undefined);
    assert.equal(s.totalTools, 0);
  });

  it('mixed risk levels: correct buckets', () => {
    const s = summarizeGater(MIXED_SPECS);
    assert.equal(s.totalTools, 4);
    assert.deepEqual(s.byRiskLevel.low, ['read_file']);
    assert.deepEqual(s.byRiskLevel.medium, ['shell_exec']);
    assert.deepEqual(s.byRiskLevel.high, ['write_file']);
    assert.deepEqual(s.byRiskLevel.critical, ['task']);
    assert.deepEqual(s.highRiskTools, ['write_file']);
    assert.deepEqual(s.criticalRiskTools, ['task']);
  });

  it('all low risk tools', () => {
    const allLow: ToolSpec[] = [
      makeSpec('read_file', 'low'),
      makeSpec('glob_search', 'low'),
    ];
    const s = summarizeGater(allLow);
    assert.equal(s.totalTools, 2);
    assert.deepEqual(s.highRiskTools, []);
    assert.deepEqual(s.criticalRiskTools, []);
  });
});

// ── Suite 5: Backward compatibility ──

describe('backward compatibility', () => {
  it('no toolSpecs: behaves like original canUseTool', () => {
    // main always passes
    assert.equal(checkToolPermission('anything', 'main').allowed, true);
    // subagent blocks task
    assert.equal(checkToolPermission('task', 'subagent').allowed, false);
    // coordinator only allows task
    assert.equal(checkToolPermission('task', 'coordinator').allowed, true);
  });
});

// ── Suite 6: Edge cases ──

describe('edge cases', () => {
  it('undefined toolSpecs: tier check only (read_file allowed at subagent)', () => {
    const r = checkToolPermission('read_file', 'subagent');
    assert.equal(r.allowed, true);
  });

  it('high risk tool allowed when not in spec list', () => {
    // tool not in specs → no risk check, tier check only
    const specs: ToolSpec[] = [lowSpec]; // only read_file is in specs
    const r = checkToolPermission('write_file', 'main', specs);
    assert.equal(r.allowed, true);
  });

  it('tool spec with requires_approval=true but low risk: still allowed', () => {
    const spec: ToolSpec = {
      ...lowSpec,
      requires_approval: true,
      risk_level: 'low',
    };
    const r = checkToolPermission('read_file', 'main', [spec]);
    assert.equal(r.allowed, true);
  });

  it('tool spec with requires_approval=false but high risk: still blocked', () => {
    const spec: ToolSpec = {
      ...highSpec,
      requires_approval: false,
      risk_level: 'high',
    };
    const r = checkToolPermission('write_file', 'main', [spec]);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('[risk:high]'));
  });
});
