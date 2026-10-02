// ── Contract Resolver Unit Test (v3.0) ──
// r13-2 Step 4: rewritten for v3 schema via agent-core loadContractV3.
// Target: TriCompany/source-agents/chief-technology-officer (CTO 小狄).

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { resolve, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { loadContract, resolveContracts } from '../src/contracts/resolver.js';
import type { AgentContract } from '../src/contracts/agent-contract.js';

// Paths relative to TriMMC repo root (v3 真源 = source-agents)
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
        // batch-15 件③（CTO 终裁 2026-10-02）：runtime_equivalent 容缺省
        //（schema 本有 .default('')；全族 15 份双字段零持有实锚——非空强制撤除）
        assert.ok(
          typeof t.runtime_equivalent === 'string',
          `tool "${t.name}" runtime_equivalent should be string (缺省容许空串)`
        );
      });
    });
  });

  describe('Element 6: IO Contract', () => {
    it('has inputs and outputs arrays', () => {
      assert.ok(cto.io_contract.inputs.length > 0, 'should have at least 1 input');
      assert.ok(cto.io_contract.outputs.length > 0, 'should have at least 1 output');
    });
  });

  it('runtime_baseline falls back to optional (spec L104 候裁态)', () => {
    // batch-15 件③（CTO 终裁 2026-10-02）：断言回落 spec 现役可选态——
    // 容 undefined（「runtime_baseline 对象形补齐」系 spec L104 候裁待办，
    // 裁决后源侧 15 份批量补+断言升级，两步分明）；存在才校验对象形。
    if (cto.runtime_baseline !== undefined) {
      assert.equal(typeof cto.runtime_baseline, 'object');
      assert.equal((cto.runtime_baseline as Record<string, unknown>).host, 'copilot-host');
    }
  });
});

describe('Contract Resolver — resolveContracts over source-agents (15 v3)', () => {
  it('resolves 15 contracts from the per-agent layout', () => {
    // batch-15 件③（CTO 终裁 2026-10-02）：期望校准 14→15——
    // 15=13 员工 Role+board/business-strategy 两份 Registry（board 09-27 Registry 化；
    // 「预研 14」系 Registry 化前旧形历史态）；schema Registry 分支放行后全族 15/15。
    const { contracts, errors } = resolveContracts(SOURCE_AGENTS);
    assert.equal(contracts.length, 15, `expected 15, got ${contracts.length}`);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.map((e) => e.path).join(', ')}`);
  });

  it('all resolved agents have non-empty system-critical fields', () => {
    const { contracts } = resolveContracts(SOURCE_AGENTS);
    for (const c of contracts) {
      assert.ok(c.agent_id.length > 0, 'agent_id empty');
      assert.ok(c.identity.description.length > 0, `${c.agent_id}: description empty`);
      // batch-15 件③追裁细则④（CTO 2026-10-02）：io_contract 非空断言 Role 席 only——
      // Registry 席（board 治理席不接活设计）io_contract 可缺（投影兜底空 IO 形），跳过。
      if (c.identity.family === 'Role') {
        assert.ok(c.io_contract.inputs.length > 0, `${c.agent_id}: inputs empty`);
      }
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
