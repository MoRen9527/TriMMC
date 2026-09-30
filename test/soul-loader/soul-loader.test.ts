// ── TriMMC Soul Loader Tests ──
// CTO-005: Tests for contractToPrompt() and contractToContextSources().
// Validates that AgentContract six-element Schema v1 converts to structured Markdown prompts.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { contractToPrompt, contractToContextSources } from '../../src/soul-loader/soul-loader.js';
import type { AgentContract } from '../../src/contracts/agent-contract.js';

// ── Test Fixtures ──

const FULL_CTO_CONTRACT: AgentContract = {
  agent_id: 'chief-technology-officer',
  version: '1.0.0',
  identity: {
    display_name: '小狄',
    family: 'Role',
    role: 'Chief Technology Officer',
    description: 'CTO of TriCompany — delivers technical roadmap.',
    user_invocable: true,
  },
  responsibilities: [
    { description: 'Architect technical strategy', priority: 'high' },
    { description: 'Review code quality', priority: 'medium' },
    { description: 'Manage technical debt' },
  ],
  decision_rights: {
    approve: ['technical_design', 'code_merge', 'deployment'],
    freeze: ['architecture_change'],
    escalate: ['business_strategy_conflict'],
    forbidden: ['product_scope_change'],
  },
  collaborators: {
    reports_to: 'ceo',
    peers: ['cpo', 'cos'],
    supervises: ['test-engineer', 'fullstack-dev'],
  },
  tools: [
    { name: 'read_file', scope: ['*'], risk_level: 'low', requires_approval: false, runtime_equivalent: 'trimodel:read_file' },
    { name: 'write_file', scope: ['src/'], risk_level: 'medium', requires_approval: false, runtime_equivalent: 'trimodel:write_file' },
    { name: 'shell_exec', scope: ['npm test'], risk_level: 'high', requires_approval: true, runtime_equivalent: 'trimodel:shell_exec' },
  ],
  io_contract: {
    inputs: [{ type: 'technical_task', description: 'Engineering task' }],
    outputs: [{ type: 'technical_decision', description: 'APPROVE/FREEZE/ESCALATE' }],
  },
  instructions: 'Always prefer reading before writing. Never skip validation.',
  runtime_baseline: [{ name: 'TriMMC', description: 'Agent runtime' }],
};

const MINIMAL_CONTRACT: AgentContract = {
  agent_id: 'minimal-agent',
  version: '1.0.0',
  identity: {
    display_name: 'MinBot',
    family: 'Registry',
    role: 'Minimal Registry Agent',
    description: 'Minimal registry agent for testing.',
    user_invocable: false,
  },
  responsibilities: [{ description: 'Serve registry queries' }],
  decision_rights: {
    approve: [],
    escalate: [],
    forbidden: [],
  },
  collaborators: {
    reports_to: 'admin',
    peers: [],
    supervises: [],
  },
  tools: [],
  io_contract: {
    inputs: [{ type: 'query', description: 'Registry query' }],
    outputs: [{ type: 'fact', description: 'Registry fact' }],
  },
};

// ── Suite 1: Full Contract → Complete Prompt ──

describe('Soul Loader 完整合约转提示词', () => {
  it('完整合约输出全部六个章节', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);

    assert.ok(prompt.includes('## Identity'), '应包含 Identity');
    assert.ok(prompt.includes('小狄'), '应包含 display_name');
    assert.ok(prompt.includes('Chief Technology Officer'), '应包含 role');
    assert.ok(prompt.includes('Role'), '应包含 family');
    assert.ok(prompt.includes('user-invocable'), '应包含 invocation 状态');
    assert.ok(prompt.includes('## Responsibilities'), '应包含 Responsibilities');
    assert.ok(prompt.includes('[HIGH]'), '应有高优先级标签');
    assert.ok(prompt.includes('[MEDIUM]'), '应有中优先级标签');
    assert.ok(prompt.includes('## Decision Rights'), '应包含 Decision Rights');
    assert.ok(prompt.includes('**Approve**'), '应包含 Approve');
    assert.ok(prompt.includes('**Freeze**'), '应包含 Freeze');
    assert.ok(prompt.includes('**Forbidden**'), '应包含 Forbidden');
    assert.ok(prompt.includes('## Collaborators'), '应包含 Collaborators');
    assert.ok(prompt.includes('ceo'), '应包含 reports_to');
    assert.ok(prompt.includes('## Behavioral Instructions'), '应包含 Instructions');
    assert.ok(prompt.includes('Never skip validation'), '应包含指令文本');
    assert.ok(prompt.includes('## Authorized Tools'), '应包含 Tools');
  });

  it('章节顺序为 Identity → Responsibilities → DecisionRights → Collaborators → Instructions → Tools', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);

    const identityIdx = prompt.indexOf('## Identity');
    const respIdx = prompt.indexOf('## Responsibilities');
    const drIdx = prompt.indexOf('## Decision Rights');
    const collabIdx = prompt.indexOf('## Collaborators');
    const instrIdx = prompt.indexOf('## Behavioral Instructions');
    const toolsIdx = prompt.indexOf('## Authorized Tools');

    assert.ok(identityIdx < respIdx, 'Identity 应在 Responsibilities 前');
    assert.ok(respIdx < drIdx, 'Responsibilities 应在 Decision Rights 前');
    assert.ok(drIdx < collabIdx, 'Decision Rights 应在 Collaborators 前');
    assert.ok(collabIdx < instrIdx, 'Collaborators 应在 Instructions 前');
    assert.ok(instrIdx < toolsIdx, 'Instructions 应在 Tools 前');
  });
});

// ── Suite 2: Minimal Contract ──

describe('最小合约', () => {
  it('最少字段合约只输出有内容的章节', () => {
    const prompt = contractToPrompt(MINIMAL_CONTRACT);

    assert.ok(prompt.includes('## Identity'), '应有 Identity');
    assert.ok(prompt.includes('MinBot'), '应有 display_name');
    assert.ok(prompt.includes('## Responsibilities'), '应有 Responsibilities');
    assert.ok(prompt.includes('## Decision Rights'), '应有 Decision Rights');
    assert.ok(prompt.includes('## Collaborators'), '应有 Collaborators');
    assert.ok(!prompt.includes('## Behavioral Instructions'), '不应有空白 Instructions');
    assert.ok(!prompt.includes('## Authorized Tools'), '不应有空 Tools');
  });

  it('user_invocable=false 时标注不可直接调度', () => {
    const prompt = contractToPrompt(MINIMAL_CONTRACT);
    assert.ok(prompt.includes('NOT user-invocable'), '应标明不可直接调度');
  });

  it('Registry family 正确显示', () => {
    const prompt = contractToPrompt(MINIMAL_CONTRACT);
    assert.ok(prompt.includes('Registry'), '应包含 Registry family');
  });

  it('空 decision_rights 输出章节但没有内容条目', () => {
    const prompt = contractToPrompt(MINIMAL_CONTRACT);
    assert.ok(prompt.includes('## Decision Rights'), '应有 Decision Rights 章节');
    // No Approve/Freeze/Escalate/Forbidden bullet points
    const drSection = prompt.split('## Collaborators')[0];
    assert.ok(!drSection.includes('**Approve**'), '不应有 Approve 条目');
    assert.ok(!drSection.includes('**Freeze**'), '不应有 Freeze 条目');
    assert.ok(!drSection.includes('**Forbidden**'), '不应有 Forbidden 条目');
  });
});

// ── Suite 3: Partial Contract Behaviors ──

describe('部分合约行为', () => {
  it('无 instructions 时不输出 Behavioral Instructions 章节', () => {
    const c: AgentContract = { ...FULL_CTO_CONTRACT, instructions: undefined };
    const prompt = contractToPrompt(c);
    assert.ok(!prompt.includes('## Behavioral Instructions'), '不应输出 Instructions');
  });

  it('空 instructions 字符串不输出章节', () => {
    const c: AgentContract = { ...FULL_CTO_CONTRACT, instructions: '' };
    const prompt = contractToPrompt(c);
    assert.ok(!prompt.includes('## Behavioral Instructions'), '空字符串不应输出');
  });

  it('仅空白 instructions 不输出章节', () => {
    const c: AgentContract = { ...FULL_CTO_CONTRACT, instructions: '   \n  ' };
    const prompt = contractToPrompt(c);
    assert.ok(!prompt.includes('## Behavioral Instructions'), '空白不应输出');
  });

  it('无 tools 时不输出 Authorized Tools 章节', () => {
    const c: AgentContract = { ...FULL_CTO_CONTRACT, tools: [] };
    const prompt = contractToPrompt(c);
    assert.ok(!prompt.includes('## Authorized Tools'), '空数组不应输出');
  });

  it('decision_rights 仅有 approve+escalate 时不输出 freeze 和 forbidden', () => {
    const c: AgentContract = {
      ...FULL_CTO_CONTRACT,
      decision_rights: {
        approve: ['code_merge'],
        escalate: ['everything_else'],
        forbidden: [],
      },
    };
    const prompt = contractToPrompt(c);

    assert.ok(prompt.includes('**Approve**: code_merge'), '应有 Approve');
    assert.ok(prompt.includes('**Escalate**: everything_else'), '应有 Escalate');
    assert.ok(!prompt.includes('**Freeze**'), '不应有 Freeze');
    assert.ok(!prompt.includes('**Forbidden**'), '不应有 Forbidden');
  });
});

// ── Suite 4: Tool Formatting ──

describe('工具格式化', () => {
  it('低风险工具不显示风险标签', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    const readLine = prompt.split('\n').find((l) => l.includes('read_file'));
    assert.ok(readLine, '应有 read_file 行');
    assert.ok(!readLine!.includes('[low risk]'), 'low risk 不应显示标签');
  });

  it('中高风险工具显示风险标签', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    assert.ok(prompt.includes('[medium risk]'), '应有 medium risk 标签');
    assert.ok(prompt.includes('[high risk]'), '应有 high risk 标签');
  });

  it('需审批工具显示审批标签', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    assert.ok(prompt.includes('requires approval'), '应有审批标签');
    const shellLine = prompt.split('\n').find((l) => l.includes('shell_exec'));
    assert.ok(shellLine!.includes('requires approval'), 'shell_exec 应标记需审批');
  });
});

// ── Suite 5: Collaborators Formatting ──

describe('协作者格式化', () => {
  it('有 peers 时显示 peers', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    assert.ok(prompt.includes('**Peers**: cpo, cos'), '应显示 peers');
  });

  it('有 supervises 时显示 supervises', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    assert.ok(prompt.includes('**Supervises**: test-engineer, fullstack-dev'), '应显示 supervises');
  });

  it('无 peers 无 supervises 时不显示对应行', () => {
    const prompt = contractToPrompt(MINIMAL_CONTRACT);
    assert.ok(!prompt.includes('**Peers**'), '不应有 Peers');
    assert.ok(!prompt.includes('**Supervises**'), '不应有 Supervises');
  });
});

// ── Suite 6: contractToContextSources ──

describe('contractToContextSources 集成', () => {
  it('输出 ContextSources 具有正确的 role 和 tier', () => {
    const sources = contractToContextSources(FULL_CTO_CONTRACT, 'main');

    assert.equal(sources.role, '小狄');
    assert.equal(sources.tier, 'main');
  });

  it('extraContext 包含 prompt 的每一行', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    const sources = contractToContextSources(FULL_CTO_CONTRACT, 'subagent');
    const promptLines = prompt.split('\n');

    assert.ok(sources.extraContext, '应有 extraContext');
    for (const line of promptLines) {
      assert.ok(sources.extraContext!.includes(line), `extraContext 应包含: ${line.substring(0, 50)}`);
    }
  });

  it('subagent tier 正确传递', () => {
    const sources = contractToContextSources(FULL_CTO_CONTRACT, 'subagent');
    assert.equal(sources.tier, 'subagent');
  });

  it('coordinator tier 正确传递', () => {
    const sources = contractToContextSources(FULL_CTO_CONTRACT, 'coordinator');
    assert.equal(sources.tier, 'coordinator');
  });
});

// ── Suite 7: 责任项无 priority 时不显示标签 ──

describe('责任项格式', () => {
  it('有 priority 时显示标签', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    assert.ok(prompt.includes('Architect technical strategy [HIGH]'), '应有 HIGH 标签');
    assert.ok(prompt.includes('Review code quality [MEDIUM]'), '应有 MEDIUM 标签');
  });

  it('无 priority 时不显示标签', () => {
    const prompt = contractToPrompt(FULL_CTO_CONTRACT);
    assert.ok(prompt.includes('- Manage technical debt'), '应有无标签的责任项');
    assert.ok(!prompt.includes('Manage technical debt ['), '不应有标签后缀');
  });
});
