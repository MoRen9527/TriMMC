// ── Capability Router Unit Tests ──
// 3-tier matching: IO hard → authority soft → load tuning
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §5.2

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { route } from '../../src/orchestration/capability-router.js';
import type { EmployeeRecord } from '../../src/orchestration/types.js';
import type { AgentContract } from '../../src/contracts/agent-contract.js';

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  const id = overrides.employeeId ?? 'test-employee';
  const defaults: EmployeeRecord = {
    employeeId: id,
    contract: {
      agent_id: 'TestAgent',
      version: '1.0',
      identity: {
        name: 'TestAgent',
        display_name: 'Test Agent',
        family: 'Role',
        role: 'TestRole',
        description: 'Test employee',
        user_invocable: true,
      },
      responsibilities: [{ description: 'test-task', priority: 'P1' }],
      decision_rights: {
        approve: ['approve_test'],
        freeze: ['freeze_test'],
        escalate: ['escalate_test'],
        forbidden: [],
      },
      collaborators: {
        reports_to: 'manager',
        peers: [],
        supervises: [],
      },
      tools: [{ name: 'test-tool', runtime_equivalent: 'test_cmd', risk_level: 'low' }],
      io_contract: {
        inputs: [{ type: 'data', description: 'input data' }],
        outputs: [
          { type: 'design_doc', description: 'design document' },
          { type: 'code_review', description: 'code review' },
          { type: 'test_report', description: 'test report' },
        ],
      },
      ...overrides.contract as Partial<AgentContract> ?? {},
    },
    status: { state: 'active', since: new Date().toISOString() },
    currentLoad: 0,
    maxConcurrentTasks: 3,
    activeSkills: ['design_doc', 'code_review'],
    costProfile: {
      dailyTokenBudget: 100_000,
      modelTier: 'balanced',
      maxCostPerTask: 2.0,
      monthlyCostCap: 50.0,
    },
    reportingChain: ['TestAgent', 'manager', 'ceo'],
  };
  return { ...defaults, ...overrides, contract: { ...defaults.contract, ...(overrides.contract ?? {}) } } as EmployeeRecord;
}

describe('Capability Router — route()', () => {
  describe('Tier 1: IO Contract Hard-Match', () => {
    it('matches employee with >= 80% output coverage', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc', 'code_review'],
      });

      assert.ok(result.matched, 'should match');
      assert.strictEqual(result.primary?.employeeId, 'test-employee');
      assert.ok(result.matchDetails.ioCoverage >= 80);
    });

    it('rejects employee with < 80% output coverage', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc', 'code_review', 'deploy_script', 'schema_update', 'migration_plan'],
      });

      assert.strictEqual(result.matched, false, 'should not match when coverage < 80%');
      assert.ok(result.matchDetails.ioCoverage < 80);
    });

    it('matches with 100% coverage for exact match', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc'],
      });

      assert.ok(result.matched, 'should match with 100%');
      assert.strictEqual(result.matchDetails.ioCoverage, 100);
    });

    it('handles empty required outputs', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'void',
        expectedOutputs: [],
      });

      assert.ok(result.matched, 'should match when no outputs needed');
      assert.strictEqual(result.matchDetails.ioCoverage, 100);
    });
  });

  describe('Tier 2: Authority Soft-Match', () => {
    it('matches employee with approve right', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'decision',
        expectedOutputs: ['design_doc'],
        decisionType: 'approve_test',
      });

      assert.ok(result.matched, 'should match with authority');
      assert.ok(result.matchDetails.authorityMatch);
    });

    it('matches without decision type (no authority needed)', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'info',
        expectedOutputs: ['design_doc'],
      });

      assert.ok(result.matched, 'should match without decision type');
      assert.ok(result.matchDetails.authorityMatch);
    });

    it('rejects when decision type is forbidden', () => {
      const emp = makeEmployee({
        employeeId: 'forbidden-emp',
        contract: {
          agent_id: 'Forbidden',
          identity: { name: 'Forbidden', display_name: 'F', family: 'Role', role: 'R', description: '', user_invocable: false },
          decision_rights: {
            approve: [],
            freeze: [],
            escalate: [],
            forbidden: ['approve_test'],
          },
          io_contract: { inputs: [], outputs: [{ type: 'design_doc', description: '' }] },
        } as Partial<AgentContract>,
      });

      const result = route([emp], {
        type: 'decision',
        expectedOutputs: ['design_doc'],
        decisionType: 'approve_test',
      });

      assert.strictEqual(result.matchDetails.authorityMatch, false);
    });

    it('matches freeze/escalate rights', () => {
      const emp = makeEmployee();
      const freezeResult = route([emp], {
        type: 'decision',
        expectedOutputs: ['design_doc'],
        decisionType: 'freeze_test',
      });
      assert.ok(freezeResult.matchDetails.authorityMatch, 'freeze should match');

      const escalateResult = route([emp], {
        type: 'decision',
        expectedOutputs: ['design_doc'],
        decisionType: 'escalate_test',
      });
      assert.ok(escalateResult.matchDetails.authorityMatch, 'escalate should match');
    });
  });

  describe('Tier 3: Load Tuning', () => {
    it('prefers employee with available capacity', () => {
      const emp = makeEmployee({ currentLoad: 0, maxConcurrentTasks: 3 });
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc'],
      });

      assert.ok(result.matched, 'should match');
      assert.ok(result.matchDetails.loadAvailable);
    });

    it('flags overloaded employee', () => {
      const emp = makeEmployee({ currentLoad: 3, maxConcurrentTasks: 3 });
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc'],
      });

      assert.strictEqual(result.matchDetails.loadAvailable, false, 'should flag as not available');
    });
  });

  describe('Multi-Employee Routing', () => {
    it('selects highest scorer among multiple employees', () => {
      const best = makeEmployee({ employeeId: 'best', currentLoad: 0 });
      const ok = makeEmployee({ employeeId: 'ok', currentLoad: 3, maxConcurrentTasks: 3 });
      const worst = makeEmployee({
        employeeId: 'worst',
        currentLoad: 3,
        maxConcurrentTasks: 3,
        contract: {
          agent_id: 'Worst',
          identity: { name: 'Worst', display_name: 'W', family: 'Role', role: 'R', description: '', user_invocable: false },
          decision_rights: { approve: [], freeze: [], escalate: [], forbid: ['approve_test'] },
          io_contract: { inputs: [], outputs: [{ type: 'design_doc', description: '' }] },
        } as Partial<AgentContract>,
      });

      const result = route([worst, ok, best], {
        type: 'design',
        expectedOutputs: ['design_doc', 'code_review'],
        decisionType: 'approve_test',
      });

      assert.ok(result.matched);
      assert.strictEqual(result.primary?.employeeId, 'best', 'should pick highest scorer');
      assert.ok(result.alternatives.length >= 1, 'should have alternatives');
    });

    it('includes reporting chain in escalation path', () => {
      const manager = makeEmployee({
        employeeId: 'manager',
        contract: {
          agent_id: 'Manager',
          identity: { name: 'manager', display_name: 'Manager', family: 'Role', role: 'Manager', description: '', user_invocable: false },
          decision_rights: { approve: ['approve_test'], freeze: [], escalate: [], forbid: [] },
          io_contract: { inputs: [], outputs: [{ type: 'design_doc', description: '' }] },
        } as Partial<AgentContract>,
        reportingChain: ['manager', 'ceo'],
      });
      const emp = makeEmployee({ reportingChain: ['test-employee', 'manager', 'ceo'] });
      // emp's escalation is manager; manager must be in the employee list
      const result = route([emp, manager], {
        type: 'design',
        expectedOutputs: ['design_doc'],
        decisionType: 'approve_test',
      });

      assert.ok(result.escalationPath.length > 0);
      assert.strictEqual(result.escalationPath[0].employeeId, 'manager');
    });
  });

  describe('Edge Cases', () => {
    it('returns no match for empty employee list', () => {
      const result = route([], {
        type: 'design',
        expectedOutputs: ['design_doc'],
      });

      assert.strictEqual(result.matched, false);
      assert.strictEqual(result.primary, null);
      assert.strictEqual(result.score, 0);
    });

    it('skips inactive employees', () => {
      const emp = makeEmployee({ status: { state: 'offline', since: new Date().toISOString() } });
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc'],
      });

      assert.strictEqual(result.matched, false, 'should not match offline employee');
    });

    it('skips suspended employees', () => {
      const emp = makeEmployee({ status: { state: 'suspended', since: new Date().toISOString() } });
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['design_doc'],
      });

      assert.strictEqual(result.matched, false, 'should not match suspended employee');
    });

    it('handles case-insensitive output matching', () => {
      const emp = makeEmployee();
      const result = route([emp], {
        type: 'design',
        expectedOutputs: ['Design_Doc', 'CODE_REVIEW'],
      });

      assert.ok(result.matched);
      assert.strictEqual(result.matchDetails.ioCoverage, 100);
    });
  });
});
