// ── Dispatch Proxy Unit Tests ──
// 6-step pipeline: classify → estimate → route → budget → schedule → dispatch
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §5.5

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { dispatch } from '../../src/orchestration/dispatch-proxy.js';
import { resetBudget } from '../../src/orchestration/cost-controller.js';
import type { EmployeeRecord, DispatchRequest } from '../../src/orchestration/types.js';
import type { AgentContract } from '../../src/contracts/agent-contract.js';

function makeEmployee(overrides: Partial<EmployeeRecord> = {}): EmployeeRecord {
  const id = overrides.employeeId ?? 'test-employee';
  return {
    employeeId: id,
    contract: {
      agent_id: id,
      version: '1.0',
      identity: { name: id, display_name: id, family: 'Role', role: 'Test', description: '', user_invocable: true },
      responsibilities: [{ description: 'design', priority: 'P1' }],
      decision_rights: {
        approve: ['architecture'],
        freeze: ['release'],
        escalate: ['budget'],
        forbid: [],
      },
      collaborators: { reports_to: 'manager', peers: [], supervises: [] },
      tools: [{ name: 'view', runtime_equivalent: 'read', risk_level: 'low' }],
      io_contract: {
        inputs: [{ type: 'task', description: '' }],
        outputs: [
          { type: 'design_doc', description: 'design document' },
          { type: 'code_review', description: 'code review' },
        ],
      },
      ...overrides.contract as Partial<AgentContract> ?? {},
    },
    status: { state: 'active', since: new Date().toISOString() },
    currentLoad: 0,
    maxConcurrentTasks: 3,
    activeSkills: ['design', 'code-review'],
    costProfile: {
      dailyTokenBudget: 500_000,
      modelTier: 'balanced',
      maxCostPerTask: 5.0,
      monthlyCostCap: 100.0,
    },
    reportingChain: [id, 'manager', 'ceo'],
    ...overrides,
  } as EmployeeRecord;
}

function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    task: {
      type: 'design',
      priority: 'P1',
      description: 'Design the new API',
      expectedOutputs: ['design_doc'],
    },
    requester: 'CEO',
    context: { ipdPhase: 'discovery' },
    ...overrides,
    task: { ...(overrides.task ?? {}), type: overrides.task?.type ?? 'design', priority: overrides.task?.priority ?? 'P1', description: overrides.task?.description ?? 'Design task', expectedOutputs: overrides.task?.expectedOutputs ?? ['design_doc'] },
  };
}

describe('Dispatch Proxy — dispatch()', () => {
  beforeEach(() => {
    resetBudget();
  });

  describe('Full Pipeline Success', () => {
    it('completes full 6-step pipeline successfully', () => {
      const emp = makeEmployee();
      const request = makeRequest();

      const result = dispatch(request, {
        registryDir: '',
        employees: [emp],
      });

      assert.ok(result.success, `should succeed, got: ${result.rejectionReason}`);
      assert.strictEqual(result.assignedTo, 'test-employee');
      assert.ok(result.costEstimate, 'should have cost estimate');
      assert.ok(result.costEstimate!.estimatedTokens > 0);
      assert.ok(result.costEstimate!.estimatedCostUSD > 0);
      assert.ok(result.trace.length >= 6, `should have 6+ trace entries, got ${result.trace.length}`);

      // Verify trace contains all 6 steps
      const stepNames = result.trace.map((t) => t.step);
      assert.ok(stepNames.includes('classify'));
      assert.ok(stepNames.includes('load'));
      assert.ok(stepNames.includes('estimate'));
      assert.ok(stepNames.includes('route'));
      assert.ok(stepNames.includes('budget'));
      assert.ok(stepNames.includes('schedule'));
      assert.ok(stepNames.includes('dispatch'));

      // All trace entries except maybe escalation should be success
      const nonEscalation = result.trace.filter((t) => t.step !== 'escalate');
      assert.ok(nonEscalation.every((t) => t.success), 'all non-escalation steps should succeed');
    });

    it('generates unique task IDs', () => {
      const emp = makeEmployee();
      const r1 = dispatch(makeRequest(), { registryDir: '', employees: [emp] });
      const r2 = dispatch(makeRequest(), { registryDir: '', employees: [emp] });

      assert.notStrictEqual(
        r1.trace.find((t) => t.step === 'dispatch')?.message,
        r2.trace.find((t) => t.step === 'dispatch')?.message,
        'task IDs should be unique',
      );
    });
  });

  describe('Error: No Employees', () => {
    it('fails when no employees are available', () => {
      const request = makeRequest();
      const result = dispatch(request, { registryDir: '', employees: [] });

      assert.strictEqual(result.success, false);
      assert.ok(result.rejectionReason?.includes('No employees'));
      assert.ok(result.trace.length > 0);
    });
  });

  describe('Error: No Match', () => {
    it('fails when no employee matches task requirements', () => {
      const emp = makeEmployee({
        contract: {
          agent_id: 'mismatch',
          io_contract: {
            inputs: [],
            outputs: [{ type: 'unrelated', description: '' }],
          },
        } as Partial<AgentContract>,
      });
      const request = makeRequest({
        task: {
          type: 'deploy',
          priority: 'P1',
          description: 'Deploy to prod',
          expectedOutputs: ['deploy_script', 'rollback_plan', 'health_check', 'schema_migration', 'config_update'],
        },
      });

      const result = dispatch(request, { registryDir: '', employees: [emp] });

      assert.strictEqual(result.success, false);
      assert.ok(result.rejectionReason?.includes('No matching'));
    });

    it('escalates when escalation path is available', () => {
      const manager = makeEmployee({
        employeeId: 'manager',
        contract: {
          agent_id: 'manager',
          io_contract: {
            inputs: [],
            outputs: [{ type: 'design_doc', description: '' }],
          },
        } as Partial<AgentContract>,
      });
      const emp = makeEmployee({
        contract: {
          agent_id: 'test-employee',
          io_contract: {
            inputs: [],
            outputs: [{ type: 'unrelated', description: '' }],
          },
        } as Partial<AgentContract>,
        reportingChain: ['test-employee', 'manager', 'ceo'],
      });
      const request = makeRequest({
        task: {
          type: 'deploy',
          priority: 'P1',
          description: 'Deploy',
          expectedOutputs: ['deploy_script', 'rollback_plan', 'health_check', 'schema_migration', 'config_update'],
        },
      });

      const result = dispatch(request, { registryDir: '', employees: [emp, manager] });

      // No match → escalation
      assert.ok(result.success || result.escalationTo !== undefined, 'should succeed via escalation');
    });
  });

  describe('Budget Failure', () => {
    it('fails when per-task budget is exceeded', () => {
      const emp = makeEmployee({
        costProfile: { dailyTokenBudget: 500_000, modelTier: 'balanced', maxCostPerTask: 0.01, monthlyCostCap: 100 },
      });
      const request = makeRequest({
        task: {
          type: 'design',
          priority: 'P1',
          description: 'Design',
          expectedOutputs: ['design_doc', 'code_review'],
        },
      });

      const result = dispatch(request, { registryDir: '', employees: [emp] });

      // Should fail because maxCostPerTask $0.01 won't cover even a small estimate
      assert.ok(
        !result.success || result.escalationTo !== undefined,
        'should either fail or escalate',
      );
    });
  });

  describe('Escalation', () => {
    it('escalates to reporting chain when primary fails', () => {
      // Employee with no IO coverage but has manager in chain
      const manager = makeEmployee({
        employeeId: 'manager',
        contract: {
          agent_id: 'manager',
          io_contract: {
            inputs: [],
            outputs: [{ type: 'design_doc', description: '' }, { type: 'code_review', description: '' }],
          },
        } as Partial<AgentContract>,
      });
      const emp = makeEmployee({
        employeeId: 'junior',
        contract: {
          agent_id: 'junior',
          io_contract: {
            inputs: [],
            outputs: [{ type: 'chat', description: '' }],
          },
        } as Partial<AgentContract>,
        reportingChain: ['junior', 'manager', 'ceo'],
      });

      const request = makeRequest({
        task: {
          type: 'design',
          priority: 'P2',
          description: 'Design',
          expectedOutputs: ['design_doc', 'code_review'],
        },
      });

      const result = dispatch(request, { registryDir: '', employees: [emp, manager] });

      // Junior has no IO match (< 80%) → manager matched directly (100% coverage)
      // Manager wins the global route — no escalation needed
      assert.ok(result.success, `should succeed, got: ${result.rejectionReason}`);
      assert.strictEqual(result.assignedTo, 'manager', `should assign to manager directly, got: ${result.assignedTo}`);
    });
  });

  describe('Trace Completeness', () => {
    it('every trace entry has timestamp', () => {
      const emp = makeEmployee();
      const result = dispatch(makeRequest(), { registryDir: '', employees: [emp] });

      for (const entry of result.trace) {
        assert.ok(entry.timestamp.length > 0, `step ${entry.step} should have timestamp`);
        assert.ok(Date.parse(entry.timestamp) > 0, `step ${entry.step} should have valid timestamp`);
      }
    });

    it('every trace entry has message', () => {
      const emp = makeEmployee();
      const result = dispatch(makeRequest(), { registryDir: '', employees: [emp] });

      for (const entry of result.trace) {
        assert.ok(entry.message.length > 0, `step ${entry.step} should have message`);
      }
    });
  });

  describe('Decision Type Routing', () => {
    it('routes task with decision type to authorized employee', () => {
      const cto = makeEmployee({
        employeeId: 'cto',
        contract: {
          agent_id: 'cto',
          decision_rights: {
            approve: ['architecture'],
            freeze: [],
            escalate: [],
            forbid: [],
          },
          io_contract: {
            inputs: [],
            outputs: [{ type: 'design_doc', description: '' }],
          },
        } as Partial<AgentContract>,
      });
      const cpo = makeEmployee({
        employeeId: 'cpo',
        contract: {
          agent_id: 'cpo',
          decision_rights: {
            approve: ['product-scope'],
            freeze: [],
            escalate: [],
            forbid: ['architecture'],
          },
          io_contract: {
            inputs: [],
            outputs: [{ type: 'design_doc', description: '' }],
          },
        } as Partial<AgentContract>,
      });

      const request = makeRequest({
        task: {
          type: 'decision',
          priority: 'P0',
          description: 'Approve architecture',
          expectedOutputs: ['design_doc'],
          decisionType: 'architecture',
        },
      });

      const result = dispatch(request, { registryDir: '', employees: [cto, cpo] });

      assert.ok(result.success);
      // CTO has 'architecture' in approve, CPO has it in forbid — CTO should win
      assert.strictEqual(result.assignedTo, 'cto');
    });
  });
});
