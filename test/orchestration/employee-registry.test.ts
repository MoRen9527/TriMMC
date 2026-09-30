// ── Employee Registry Unit Tests ──
// Phase A: static contract loading, EmployeeRecord construction
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §5.1

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadEmployeeRegistry } from '../../src/orchestration/employee-registry.js';
import type { EmployeeRecord } from '../../src/orchestration/types.js';

const CTO_YAML = `
contract:
  version: '3.0'
  type: agent-contract
  agent_id: ChiefTechnologyOfficer
  family: Role
identity:
  display_name: 小狄
  role: CTO
  description: CTO of TriCompany
  user_invocable: true
paths:
  soul: cto/soul.agent.md
  agent_body: cto/agent-body.agent.md
  agent_frontmatter: cto/agent-frontmatter.agent.md
  memory: cto/memory.agent.md
  colleagues: cto/colleagues.agent.md
  social: cto/social.agent.md
responsibilities:
  - description: code-delivery
    priority: high
decision_rights:
  approve:
    - architecture
    - tech-stack
  freeze:
    - release
  escalate:
    - budget
  forbidden: []
collaborators:
  reports_to: CEO
  peers:
    - CPO
  supervises:
    - TestEngineer
tools:
  - name: view
    runtime_equivalent: read_file
    risk_level: low
    requires_approval: false
    scope: []
  - name: powershell
    runtime_equivalent: execute_command
    risk_level: medium
    requires_approval: false
    scope: []
io_contract:
  inputs:
    - type: task
      description: task assignment
  outputs:
    - type: design_doc
      description: technical design
    - type: code_review
      description: code review result
`;

const CPO_YAML = `
contract:
  version: '3.0'
  type: agent-contract
  agent_id: ChiefProductOfficer
  family: Role
identity:
  display_name: 小乔
  role: CPO
  description: CPO of TriCompany
  user_invocable: true
paths:
  soul: cpo/soul.agent.md
  agent_body: cpo/agent-body.agent.md
  agent_frontmatter: cpo/agent-frontmatter.agent.md
  memory: cpo/memory.agent.md
  colleagues: cpo/colleagues.agent.md
  social: cpo/social.agent.md
responsibilities:
  - description: product-scope
    priority: high
decision_rights:
  approve:
    - product-scope
  freeze: []
  escalate: []
  forbidden:
    - architecture
collaborators:
  reports_to: CEO
  peers:
    - CTO
  supervises: []
tools:
  - name: view
    runtime_equivalent: read_file
    risk_level: low
    requires_approval: false
    scope: []
io_contract:
  inputs:
    - type: market_research
      description: market data
  outputs:
    - type: prd
      description: Product Requirements Document
`;

const BROKEN_YAML = `
contract:
  version: '3.0'
  type: agent-contract
  agent_id: Broken
  family: Role
# intentionally broken — missing required fields
`;

describe('Employee Registry — loadEmployeeRegistry', () => {
  const tmpDir = mkdtempSync('tricode-registry-test-');

  it('loads valid contracts into EmployeeRecords', () => {
    writeFileSync(join(tmpDir, 'cto.contract.yaml'), CTO_YAML, 'utf-8');
    writeFileSync(join(tmpDir, 'cpo.contract.yaml'), CPO_YAML, 'utf-8');

    const result = loadEmployeeRegistry(tmpDir);

    assert.strictEqual(result.employees.length, 2, 'should load 2 employees');
    assert.strictEqual(result.errors.length, 0, 'should have no errors');

    const cto = result.employees.find((e: EmployeeRecord) => e.employeeId === 'chieftechnologyofficer');
    assert.ok(cto, 'should find CTO');
    assert.strictEqual(cto!.status.state, 'active', 'CTO should be active');
    assert.ok(cto!.activeSkills.length > 0, 'CTO should have skills');
    assert.ok(cto!.activeSkills.includes('code-delivery'), 'CTO should have responsibility skill');
    assert.ok(cto!.activeSkills.some((s: string) => s.startsWith('tool:')), 'CTO should have tool skills');
    assert.strictEqual(cto!.maxConcurrentTasks, 2, 'default max concurrent');
    assert.ok(cto!.reportingChain.includes('CEO'), 'CTO reports to CEO');
    assert.strictEqual(cto!.costProfile.modelTier, 'balanced', 'default model tier');
  });

  it('handles broken contracts gracefully', () => {
    writeFileSync(join(tmpDir, 'broken.contract.yaml'), BROKEN_YAML, 'utf-8');
    writeFileSync(join(tmpDir, 'cto.contract.yaml'), CTO_YAML, 'utf-8');

    const result = loadEmployeeRegistry(tmpDir);

    assert.ok(result.employees.length >= 1, 'should load at least 1 valid employee');
    assert.ok(result.errors.length > 0, 'should report errors for broken contracts');
  });

  it('returns empty employees for empty directory', () => {
    const emptyDir = mkdtempSync('tricode-registry-empty-');
    const result = loadEmployeeRegistry(emptyDir);

    assert.strictEqual(result.employees.length, 0, 'should be empty');
    // resolveContracts returns errors for non-yaml files, but an empty dir should have 0 employees
    rmSync(emptyDir, { recursive: true });
  });

  it('returns empty for non-existent directory', () => {
    const result = loadEmployeeRegistry(resolve('/tmp/nonexistent-registry-' + Date.now()));

    assert.strictEqual(result.employees.length, 0, 'should be empty for non-existent dir');
    assert.ok(result.errors.length > 0, 'should report read errors');
  });

  it('EmployeeRecord has all required fields', () => {
    writeFileSync(join(tmpDir, 'cto.contract.yaml'), CTO_YAML, 'utf-8');

    const result = loadEmployeeRegistry(tmpDir);
    const emp = result.employees[0];

    assert.ok(emp.employeeId, 'should have employeeId');
    assert.ok(emp.contract, 'should have contract');
    assert.ok(emp.status, 'should have status');
    assert.ok(emp.currentLoad !== undefined, 'should have currentLoad');
    assert.ok(emp.maxConcurrentTasks > 0, 'should have maxConcurrentTasks');
    assert.ok(Array.isArray(emp.activeSkills), 'activeSkills should be array');
    assert.ok(emp.costProfile, 'should have costProfile');
    assert.ok(Array.isArray(emp.reportingChain), 'reportingChain should be array');
  });

  // cleanup runs after all subtests
  after(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── r13-2 Step 4: 真实 source-agents 14 员工实载（registryDir 改指 v3 真源） ──

describe('Employee Registry — source-agents v3 (14 employees)', () => {
  const SOURCE_AGENTS = resolve('..', 'TriCompany', 'source-agents');

  it('loads 14 employees from the v3 contract source', () => {
    const result = loadEmployeeRegistry(SOURCE_AGENTS);

    assert.strictEqual(result.employees.length, 14, `expected 14, got ${result.employees.length}`);
    assert.strictEqual(result.errors.length, 0, `unexpected errors: ${result.errors.map((e) => e.path).join(', ')}`);

    // 3 份缺口员工（r13-2 Step 2 新写）必须在列
    for (const id of ['business-strategy', 'customer-success-officer', 'deployment-engineer']) {
      const emp = result.employees.find((e: EmployeeRecord) => e.employeeId === id);
      assert.ok(emp, `gap employee missing: ${id}`);
      assert.strictEqual(emp!.status.state, 'active', `${id} should be active`);
    }
  });
});
