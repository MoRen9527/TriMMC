// ── TriMMC Context Builder Tests ──
// CTO-004: Tests for buildContext() and mergeContextWithPrompt().
// Covers: full context assembly, minimal context, each section builder, merge behavior.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildContext, mergeContextWithPrompt, type ContextSources } from '../../src/context-builder/context-builder.js';
import '../../src/agent-loop/tools.js';

// ── Test Fixtures ──

const SAMPLE_AGENTS_MD = `# Test Module Agent Rules

## Module Role
- Test module for context builder verification.`;

const SAMPLE_CODE_STATE = `## Repository Map
- src/context-builder/: Context assembly module`;

// ── Suite 1: Full Context Assembly ──

describe('Context Builder 完整上下文组装', () => {
  it('全部源提供时输出所有章节', () => {
    const sources: ContextSources = {
      tier: 'main',
      role: 'Test Agent',
      agentsMd: SAMPLE_AGENTS_MD,
      codeState: SAMPLE_CODE_STATE,
      extraContext: ['Extra line 1', 'Extra line 2'],
    };
    const result = buildContext(sources);

    assert.ok(result.includes('## Agent Role'), '应包含 Role 章节');
    assert.ok(result.includes('**Test Agent**'), '应包含角色名');
    assert.ok(result.includes('## Agent Capabilities'), '应包含 Capabilities 章节');
    assert.ok(result.includes('`main`'), '应包含 tier 标签');
    assert.ok(result.includes('## Module Context (AGENTS.md)'), '应包含 AGENTS.md 章节');
    assert.ok(result.includes('Test module for context builder'), '应包含 AGENTS.md 内容');
    assert.ok(result.includes('## Code State'), '应包含 Code State 章节');
    assert.ok(result.includes('## Additional Context'), '应包含 Additional Context 章节');
    assert.ok(result.includes('Extra line 1'), '应包含额外上下文行');
    assert.ok(result.includes('Extra line 2'), '应包含额外上下文行 2');
  });

  it('章节顺序为 Role → Tier → AGENTS.md → Code State → Extra', () => {
    const sources: ContextSources = {
      tier: 'main',
      role: 'Ordered Agent',
      agentsMd: SAMPLE_AGENTS_MD,
      codeState: SAMPLE_CODE_STATE,
      extraContext: ['Extra'],
    };
    const result = buildContext(sources);

    const roleIdx = result.indexOf('## Agent Role');
    const tierIdx = result.indexOf('## Agent Capabilities');
    const agentsIdx = result.indexOf('## Module Context');
    const codeIdx = result.indexOf('## Code State');
    const extraIdx = result.indexOf('## Additional Context');

    assert.ok(roleIdx < tierIdx, 'Role 应在 Tier 之前');
    assert.ok(tierIdx < agentsIdx, 'Tier 应在 AGENTS.md 之前');
    assert.ok(agentsIdx < codeIdx, 'AGENTS.md 应在 Code State 之前');
    assert.ok(codeIdx < extraIdx, 'Code State 应在 Extra 之前');
  });
});

// ── Suite 2: Tier Capability Injection ──

describe('Tier 能力注入', () => {
  it('main tier 列出全部 6 个工具', () => {
    const sources: ContextSources = { tier: 'main' };
    const result = buildContext(sources);

    assert.ok(result.includes('`main`'), '应包含 main tier');
    assert.ok(result.includes('**Available Tools** (6)'), 'main 应有 6 个工具');
  });

  it('subagent tier 列出 2 个工具并说明无 task', () => {
    const sources: ContextSources = { tier: 'subagent' };
    const result = buildContext(sources);

    assert.ok(result.includes('`subagent`'), '应包含 subagent tier');
    assert.ok(result.includes('**Available Tools** (2)'), 'subagent 应有 2 个工具');
    // Verify no task in tool list
    const toolsLine = result.split('\n').find((l) => l.includes('**Available Tools**'));
    assert.ok(toolsLine, '应有 Available Tools 行');
    assert.ok(!toolsLine!.includes('task'), 'subagent 工具列表不应包含 task');
  });

  it('coordinator tier 列出 1 个工具（仅 task）', () => {
    const sources: ContextSources = { tier: 'coordinator' };
    const result = buildContext(sources);

    assert.ok(result.includes('`coordinator`'), '应包含 coordinator tier');
    assert.ok(result.includes('**Available Tools** (1)'), 'coordinator 应有 1 个工具');
    assert.ok(result.includes('task'), 'coordinator 应有 task 工具');
  });

  it('每个 tier 都注入 TIER_DESCRIPTIONS', () => {
    const tiers: Array<'main' | 'subagent' | 'coordinator'> = ['main', 'subagent', 'coordinator'];
    for (const tier of tiers) {
      const result = buildContext({ tier });
      // TIER_DESCRIPTIONS content should be present after the tools line
      // At minimum, should have meaningful description text (>20 chars beyond the tools line)
      const descStart = result.indexOf('**Available Tools**');
      const afterTools = result.slice(descStart + 50);
      assert.ok(afterTools.trim().length > 20, `${tier} 应有足够的描述文本`);
    }
  });
});

// ── Suite 3: Minimal / Sparse Context ──

describe('稀疏/最小上下文', () => {
  it('仅 tier 时输出仅 Capabilities 章节', () => {
    const sources: ContextSources = { tier: 'main' };
    const result = buildContext(sources);

    assert.ok(result.includes('## Agent Capabilities'), '应包含 Capabilities');
    assert.ok(!result.includes('## Agent Role'), '不应包含 Role');
    assert.ok(!result.includes('## Module Context'), '不应包含 Module Context');
    assert.ok(!result.includes('## Code State'), '不应包含 Code State');
    assert.ok(!result.includes('## Additional Context'), '不应包含 Extra');
  });

  it('role + tier 输出两个章节', () => {
    const sources: ContextSources = { tier: 'subagent', role: 'Explorer' };
    const result = buildContext(sources);

    assert.ok(result.includes('## Agent Role'), '应包含 Role');
    assert.ok(result.includes('## Agent Capabilities'), '应包含 Capabilities');
    assert.ok(!result.includes('## Module Context'), '不应包含 AGENTS.md');
  });

  it('空 extraContext 数组不输出 Extra 章节', () => {
    const sources: ContextSources = { tier: 'main', extraContext: [] };
    const result = buildContext(sources);

    assert.ok(!result.includes('## Additional Context'), '空数组不应输出 Extra');
  });

  it('agentsMd 空白字符串不输出 AGENTS.md 章节', () => {
    const sources: ContextSources = { tier: 'main', agentsMd: '' };
    const result = buildContext(sources);

    // empty string is falsy in JS but truthy in our check — let's verify:
    // Actually, empty string is falsy, so the if (sources.agentsMd) check passes false
    assert.ok(!result.includes('## Module Context'), '空白 agentsMd 不应输出');
  });
});

// ── Suite 4: mergeContextWithPrompt ──

describe('mergeContextWithPrompt 合并行为', () => {
  it('context + systemPrompt 用 --- 分隔', () => {
    const result = mergeContextWithPrompt('## Context', 'User instructions.');

    assert.ok(result.startsWith('## Context'), '应以 context 开头');
    assert.ok(result.includes('\n\n---\n\n'), '应用 --- 分隔');
    assert.ok(result.includes('User instructions.'), '应包含 systemPrompt');
  });

  it('仅有 context 无 systemPrompt 时不追加分隔符', () => {
    const result = mergeContextWithPrompt('## Context');

    assert.equal(result, '## Context');
    assert.ok(!result.includes('---'), '不应有分隔符');
  });

  it('仅有 systemPrompt 无 context 时直接返回 systemPrompt', () => {
    const result = mergeContextWithPrompt('', 'Only prompt');

    assert.equal(result, 'Only prompt');
  });

  it('两者皆空返回空字符串', () => {
    const result = mergeContextWithPrompt('', '');

    assert.equal(result, '');
  });
});

// ── Suite 5: ContextSources 类型合约 ──

describe('ContextSources 类型合约', () => {
  it('ContextSources 接受所有可选字段', () => {
    // Compile-time type check expressed as runtime assertion
    const sources: ContextSources = {
      tier: 'main',
      role: 'Tester',
      agentsMd: '# AGENTS',
      codeState: '# State',
      extraContext: ['a', 'b'],
    };
    assert.equal(sources.tier, 'main');
    assert.equal(sources.role, 'Tester');
    assert.equal(sources.agentsMd, '# AGENTS');
    assert.equal(sources.codeState, '# State');
    assert.deepEqual(sources.extraContext, ['a', 'b']);
  });

  it('ContextSources 仅 tier 必填', () => {
    const sources: ContextSources = { tier: 'coordinator' };
    assert.equal(sources.tier, 'coordinator');
    assert.equal(sources.role, undefined);
  });
});
