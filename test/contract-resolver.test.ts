// ── Contract Resolver Unit Test (v3.0) ──
// r13-2 Step 4: rewritten for v3 schema via agent-core loadContractV3.
// Target: TriCompany/source-agents/chief-technology-officer (CTO 小狄).

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { loadContract, resolveContracts } from '../src/contracts/resolver.js';
import type { AgentContract } from '../src/contracts/agent-contract.js';

// Paths relative to TriMC repo root (v3 真源 = source-agents)
const SOURCE_AGENTS = resolve('..', 'TriCompany', 'source-agents');
const CTO_CONTRACT_PATH = resolve(SOURCE_AGENTS, 'chief-technology-officer', 'chief-technology-officer.contract.yaml');

describe('Contract Resolver — chief-technology-officer v3.0 (CTO 小狄)', () => {
  let cto: AgentContract;

  before(() => {
    cto = loadContract(CTO_CONTRACT_PATH);
  });

  // ── Contract + identity ──

  it('parses agent_id and version', () => {
    assert.strictEqual(cto.agent_id, 'chief-technology-officer');
    assert.strictEqual(cto.version, '3.0');
  });

  describe('Element 1: Identity', () => {
    it('has all required identity fields', () => {
      assert.strictEqual(cto.identity.display_name, '小狄');
      assert.strictEqual(cto.identity.family, 'Role');
      assert.strictEqual(cto.identity.role, 'ChiefTechnologyOfficer');
      assert.ok(cto.identity.description.length > 0, 'description should not be empty');
      assert.strictEqual(cto.identity.user_invocable, true);
    });
  });

  describe('Element 2: Responsibilities', () => {
    it('has at least one responsibility', () => {
      assert.ok(cto.responsibilities.length > 0, 'should have at least 1 responsibility');
      cto.responsibilities.forEach((r: { description: string; priority?: string }) => {
        assert.ok(r.description.length > 0, `responsibility "${JSON.stringify(r)}" should have a description`);
      });
    });
  });

  describe('Element 3: Decision Rights', () => {
    it('has all four keys', () => {
      assert.ok(cto.decision_rights.approve.length > 0, 'should have at least 1 approve item');
      assert.ok(cto.decision_rights.escalate.length > 0, 'should have at least 1 escalate item');
      assert.ok(cto.decision_rights.forbidden.length > 0, 'should have at least 1 forbidden item');
      assert.ok(Array.isArray(cto.decision_rights.freeze), 'freeze should be an array (v3 four-key)');
    });
  });

  describe('Element 4: Collaborators', () => {
    it('has reports_to, peers and supervises', () => {
      assert.ok(cto.collaborators.reports_to.length > 0, 'reports_to should not be empty');
      assert.ok(Array.isArray(cto.collaborators.peers), 'peers should be an array');
      assert.ok(Array.isArray(cto.collaborators.supervises), 'supervises should be an array');
    });
  });

  describe('Element 5: Tools', () => {
    it('has tools with valid risk_level and runtime_equivalent', () => {
      assert.ok(cto.tools.length > 0, 'should have at least 1 tool');
      const validLevels = ['low', 'medium', 'high', 'critical'];
      cto.tools.forEach((t) => {
        assert.ok(validLevels.includes(t.risk_level), `tool "${t.name}" risk_level invalid`);
        assert.ok(t.runtime_equivalent.length > 0, `tool "${t.name}" should have runtime_equivalent`);
      });
    });
  });

  describe('Element 6: IO Contract', () => {
    it('has inputs and outputs arrays', () => {
      assert.ok(cto.io_contract.inputs.length > 0, 'should have at least 1 input');
      assert.ok(cto.io_contract.outputs.length > 0, 'should have at least 1 output');
    });
  });

  it('runtime_baseline is the v3 object shape', () => {
    assert.ok(cto.runtime_baseline, 'runtime_baseline should be present');
    assert.equal(typeof cto.runtime_baseline, 'object');
    assert.equal((cto.runtime_baseline as Record<string, unknown>).host, 'copilot-host');
  });
});

describe('Contract Resolver — resolveContracts over source-agents (14 v3)', () => {
  it('resolves 14 contracts from the per-agent layout', () => {
    const { contracts, errors } = resolveContracts(SOURCE_AGENTS);
    assert.equal(contracts.length, 14, `expected 14, got ${contracts.length}`);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.map((e) => e.path).join(', ')}`);
  });

  it('all resolved agents have non-empty system-critical fields', () => {
    const { contracts } = resolveContracts(SOURCE_AGENTS);
    for (const c of contracts) {
      assert.ok(c.agent_id.length > 0, 'agent_id empty');
      assert.ok(c.identity.description.length > 0, `${c.agent_id}: description empty`);
      assert.ok(c.io_contract.inputs.length > 0, `${c.agent_id}: inputs empty`);
    }
  });

  it('rejects v1-shaped contracts (negative path: no compat branch)', () => {
    // v1 合同已退役（r13-2 Step 5），用自建 fixture 验证负路径
    const legacyDir = mkdtempSync(join(resolve('..', 'TriMMC'), '.tmp-v1-neg-'));
    writeFileSync(
      join(legacyDir, 'Legacy.contract.yaml'),
      [
        'contract:',
        "  version: '1.0'",
        '  agent_id: Legacy',
        'identity:',
        '  display_name: Legacy',
        '  role: Legacy',
        '  description: legacy',
      ].join('\n'),
      'utf-8',
    );
    try {
      const { contracts, errors } = resolveContracts(legacyDir);
      // v1 形状被 v3 schema 拒绝：零加载 + 错误信息含版本或校验失败
      assert.equal(contracts.length, 0);
      assert.ok(errors.length >= 1, `expected >= 1 rejection, got ${errors.length}`);
      for (const e of errors) {
        assert.match(e.message, /unsupported contract version|schema validation failed/, e.path);
      }
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
