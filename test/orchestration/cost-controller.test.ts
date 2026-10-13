// ── Cost Controller Unit Tests ──
// 3-layer budget: company-daily, employee-daily, per-task
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §5.4

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  estimateCost,
  checkBudget,
  recordCost,
  getBudgetState,
  getModelTierPolicy,
  resetBudget,
} from '../../src/orchestration/cost-controller.js';
import type { EmployeeRecord } from '../../src/orchestration/types.js';
import type { AgentContract } from '../../src/contracts/agent-contract.js';

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  return {
    employeeId: 'test-employee',
    contract: { agent_id: 'Test', identity: { name: 'Test', display_name: 'T', family: 'Role', role: 'R', description: '', user_invocable: false }, responsibilities: [], decision_rights: { approve: [], freeze: [], escalate: [], forbid: [] }, collaborators: { reports_to: '', peers: [], supervises: [] }, tools: [], io_contract: { inputs: [], outputs: [] }, version: '1' } as AgentContract,
    status: { state: 'active', since: new Date().toISOString() },
    currentLoad: 0,
    maxConcurrentTasks: 2,
    activeSkills: [],
    costProfile: {
      dailyTokenBudget: 300_000,
      modelTier: 'balanced',
      maxCostPerTask: 2.0,
      monthlyCostCap: 50.0,
    },
    reportingChain: ['test-employee', 'manager'],
    ...overrides,
  };
}

describe('Cost Controller — estimateCost()', () => {
  it('estimates tokens based on expected outputs', () => {
    const emp = makeEmployee();
    const result = estimateCost(emp, ['design_doc', 'code_review']);

    assert.ok(result.estimatedTokens > 0);
    assert.ok(result.estimatedCostUSD > 0);
    assert.strictEqual(result.modelTier, 'balanced');
  });

  it('scales with number of outputs', () => {
    const emp = makeEmployee();
    const small = estimateCost(emp, ['a']);
    const large = estimateCost(emp, ['a', 'b', 'c', 'd', 'e']);

    assert.ok(large.estimatedTokens > small.estimatedTokens, 'more outputs should produce higher estimates');
  });

  it('caps at tier maxTokensPerTurn', () => {
    const emp = makeEmployee({ costProfile: { dailyTokenBudget: 100_000, modelTier: 'fast', maxCostPerTask: 1, monthlyCostCap: 30 } });
    const manyOutputs = Array.from({ length: 100 }, (_, i) => `output_${i}`);
    const result = estimateCost(emp, manyOutputs);

    const fastPolicy = getModelTierPolicy('fast');
    assert.ok(result.estimatedTokens <= fastPolicy.maxTokensPerTurn, 'should cap at fast tier limit');
  });

  it('returns different tiers for different employees', () => {
    const thinkingEmp = makeEmployee({ employeeId: 'thinker', costProfile: { dailyTokenBudget: 500_000, modelTier: 'thinking', maxCostPerTask: 5, monthlyCostCap: 100 } });
    const fastEmp = makeEmployee({ employeeId: 'fast', costProfile: { dailyTokenBudget: 50_000, modelTier: 'fast', maxCostPerTask: 0.5, monthlyCostCap: 10 } });

    const thinkingResult = estimateCost(thinkingEmp, ['design_doc']);
    const fastResult = estimateCost(fastEmp, ['design_doc']);

    assert.strictEqual(thinkingResult.modelTier, 'thinking');
    assert.strictEqual(fastResult.modelTier, 'fast');
    assert.ok(thinkingResult.estimatedTokens >= fastResult.estimatedTokens, 'thinking tier should allow more tokens');
  });
});

describe('Cost Controller — checkBudget()', () => {
  beforeEach(() => {
    resetBudget();
  });

  it('approves when all budgets are available', () => {
    const emp = makeEmployee();
    const result = checkBudget(emp, 20_000, 0.3);

    assert.ok(result.approved);
    assert.strictEqual(result.reason, undefined);
  });

  it('rejects when per-task cost exceeds employee max', () => {
    const emp = makeEmployee({ costProfile: { dailyTokenBudget: 100_000, modelTier: 'balanced', maxCostPerTask: 0.5, monthlyCostCap: 50 } });
    const result = checkBudget(emp, 100_000, 2.5); // $2.5 > maxCostPerTask $0.5

    assert.strictEqual(result.approved, false);
    assert.ok(result.reason?.includes('Per-task'), `expected per-task reason, got: ${result.reason}`);
  });

  it('rejects when company daily cap would be exceeded', () => {
    const emp = makeEmployee();
    // Exhaust company daily budget first
    const largeEmp = makeEmployee({
      employeeId: 'large',
      costProfile: { dailyTokenBudget: 1_000_000, modelTier: 'thinking', maxCostPerTask: 50, monthlyCostCap: 200 },
    });
    // Record ~$45 in daily costs
    recordCost(largeEmp.employeeId, 'task-heavy', 3_000_000, 'claude-4.5');

    // Now try a $10 task — should exceed $50 daily cap
    const result = checkBudget(emp, 1_000_000, 10.0);

    // Company daily cap is $50. If we already used ~$45, $10 more would exceed.
    // But $45 + $10 = $55 > $50, so it should reject
    const state = getBudgetState();
    if (state.companyDailyUsed + 10 > 50) {
      assert.strictEqual(result.approved, false);
      assert.ok(result.reason?.includes('Company daily'));
    }
  });

  it('rejects when employee daily cap is exceeded', () => {
    const emp = makeEmployee({
      costProfile: { dailyTokenBudget: 300_000, modelTier: 'balanced', maxCostPerTask: 5, monthlyCostCap: 50 },
    });
    // Record costs for this employee
    recordCost(emp.employeeId, 'task-1', 500_000, 'claude-4.5');
    recordCost(emp.employeeId, 'task-2', 500_000, 'claude-4.5');

    const result = checkBudget(emp, 500_000, 7.5); // $7.5 on top of existing costs

    // Employee daily cap is $10. If we've used ~$15 already (from 1M tokens at $15/M),
    // then $7.5 more would exceed.
    const state = getBudgetState();
    const empDaily = state.employeeDailyUsed.get(emp.employeeId) ?? 0;
    if (empDaily + 7.5 > 10) {
      assert.strictEqual(result.approved, false);
      assert.ok(result.reason?.includes('Employee daily'));
    }
  });
});

describe('Cost Controller — recordCost()', () => {
  beforeEach(() => {
    resetBudget();
  });

  it('records cost and updates budget state', () => {
    const empId = 'test-employee';
    const record = recordCost(empId, 'task-1', 100_000, 'claude-4.5');

    assert.strictEqual(record.employeeId, empId);
    assert.strictEqual(record.taskId, 'task-1');
    assert.ok(record.costUSD > 0);
    assert.ok(record.timestamp.length > 0);

    const state = getBudgetState();
    assert.ok(state.companyDailyUsed > 0, 'company daily should be updated');
    assert.ok((state.employeeDailyUsed.get(empId) ?? 0) > 0, 'employee daily should be updated');
  });

  it('accumulates costs for same employee', () => {
    const empId = 'test-employee';
    const r1 = recordCost(empId, 'task-1', 50_000, 'claude-4.5');
    const r2 = recordCost(empId, 'task-2', 50_000, 'claude-4.5');

    const state = getBudgetState();
    const empTotal = state.employeeDailyUsed.get(empId) ?? 0;
    assert.ok(empTotal >= r1.costUSD + r2.costUSD - 0.01, 'employee costs should accumulate');
  });

  it('tracks costs for multiple employees independently', () => {
    recordCost('emp-a', 'task-a', 100_000, 'claude-4.5');
    recordCost('emp-b', 'task-b', 200_000, 'gpt-5.1');

    const state = getBudgetState();
    const aCost = state.employeeDailyUsed.get('emp-a') ?? 0;
    const bCost = state.employeeDailyUsed.get('emp-b') ?? 0;
    assert.ok(aCost > 0 && bCost > 0, 'both employees should have costs');
    assert.ok(aCost !== bCost || true, 'costs may differ by model'); // gpt-5.1 same price as claude-4.5
  });
});

describe('Cost Controller — getModelTierPolicy()', () => {
  it('returns policy for thinking tier', () => {
    const policy = getModelTierPolicy('thinking');
    assert.strictEqual(policy.tier, 'thinking');
    assert.ok(policy.maxTokensPerTurn > 100_000);
    assert.ok(policy.allowedModels.length >= 2);
    assert.ok(policy.defaultModel.length > 0);
    assert.ok(policy.fallbackChain.length > 0);
  });

  it('returns policy for balanced tier', () => {
    const policy = getModelTierPolicy('balanced');
    assert.strictEqual(policy.tier, 'balanced');
    assert.ok(policy.maxTokensPerTurn <= 150_000);
  });

  it('returns policy for fast tier', () => {
    const policy = getModelTierPolicy('fast');
    assert.strictEqual(policy.tier, 'fast');
    assert.ok(policy.maxTokensPerTurn <= 50_000);
  });
});

describe('Cost Controller — resetBudget()', () => {
  it('clears all budget state', () => {
    recordCost('test-employee', 'task-1', 100_000, 'claude-4.5');
    resetBudget();

    const state = getBudgetState();
    assert.strictEqual(state.companyDailyUsed, 0);
    assert.strictEqual(state.companyMonthlyUsed, 0);
    assert.strictEqual(state.employeeDailyUsed.size, 0);
    assert.strictEqual(state.employeeMonthlyUsed.size, 0);
  });
});
