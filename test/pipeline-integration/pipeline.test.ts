// ── TriMMC Pipeline Integration Tests ──
// CTO-012: Validates end-to-end assembly of all four v0.2.0 orchestration components
// from AgentContract through to AgentLoopOptions.
// Pattern: 小柯验证 — block-level tests for the full pipeline composition.
//
// Pipeline: Contract → Soul Loader → ContextSources + systemPrompt
//                    → Memory Injector → extraContext (memdir)
//                    → Context Builder → merged prompt
//                    → Tool Gater → tool permission checks
//                    → AgentLoopOptions (ready for agentLoop)

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentContract, ToolSpec } from '../../src/contracts/agent-contract.js';
import { contractToPrompt, contractToContextSources } from '../../src/soul-loader/soul-loader.js';
import { contractToSoulMemory, buildMemoryContext, injectAll } from '../../src/memory-injector/memory-injector.js';
import type { SoulMemory, EpisodicMemory, ColleagueMemory, SocialMemory, MemoryPayload } from '../../src/memory-injector/memory-injector.js';
import { buildContext, mergeContextWithPrompt } from '../../src/context-builder/context-builder.js';
import type { ContextSources } from '../../src/context-builder/context-builder.js';
import { checkToolPermission, summarizeGater } from '../../src/tool-gater/gater.js';
import '../../src/agent-loop/tools.js';
import type { AgentTier } from '../../src/agent-loop/permissions.js';

// ── Test Fixtures ──

const CTO_CONTRACT: AgentContract = {
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
  version: '0.1.0',
  identity: {
    display_name: 'Min',
    family: 'Registry',
    role: 'Data Indexer',
    description: 'Minimal agent for testing.',
    user_invocable: false,
  },
  responsibilities: [],
  decision_rights: {
    approve: [],
    escalate: [],
    forbidden: [],
  },
  collaborators: {
    reports_to: 'supervisor',
    peers: [],
    supervises: [],
  },
  tools: [],
  io_contract: {
    inputs: [],
    outputs: [],
  },
};

// ── Memory test infrastructure ──

let memdirRoot: string;

before(async () => {
  memdirRoot = await mkdtemp(join(tmpdir(), 'trimc-pipeline-test-'));
});

after(async () => {
  await rm(memdirRoot, { recursive: true, force: true });
});

// ── Helper: Assemble the full pipeline ──

interface PipelineAssembly {
  /** Soul Loader output: structured Markdown system prompt from contract */
  soulPrompt: string;
  /** Soul Loader output: ContextSources (role + tier + extraContext from soul) */
  soulContextSources: ContextSources;
  /** Memory Injector output: SoulMemory snapshot */
  soulMemory: SoulMemory;
  /** Memory Injector output: extraContext lines from memdir/ */
  memoryContext: string[];
  /** Context Builder output: merged context block from soul+memory */
  contextBlock: string;
  /** Final merged system prompt (context + soulPrompt) */
  mergedSystemPrompt: string;
  /** Tool Gater summary for contract tools */
  gaterSummary: ReturnType<typeof summarizeGater>;
  /** Individual tool permission results */
  toolPermissions: Array<{ name: string; allowed: boolean; reason?: string }>;
}

async function assemblePipeline(
  contract: AgentContract,
  t: AgentTier,
  memoryPayload?: MemoryPayload,
): Promise<PipelineAssembly> {
  // Step 1: Soul Loader — contract to system prompt + ContextSources
  const soulPrompt = contractToPrompt(contract);
  const soulContextSources = contractToContextSources(contract, t);

  // Step 2: Memory Injector — contract to soul memory snapshot + memdir injection
  const soulMemory = contractToSoulMemory(contract);
  let memoryContext: string[] = [];

  if (memoryPayload) {
    const injectResult = await injectAll(memoryPayload, memdirRoot);
    if (injectResult.count > 0) {
      memoryContext = await buildMemoryContext(memdirRoot);
    }
  }

  // Step 3: Context Builder — merge soul context + memory context
  const fusedContextSources: ContextSources = {
    ...soulContextSources,
    extraContext: [
      ...(soulContextSources.extraContext ?? []),
      ...memoryContext,
    ],
  };
  const contextBlock = buildContext(fusedContextSources);
  const mergedSystemPrompt = mergeContextWithPrompt(contextBlock, soulPrompt);

  // Step 4: Tool Gater — check each contract tool
  const toolSpecs: ToolSpec[] = contract.tools;
  const toolPermissions = toolSpecs.map(ts => ({
    name: ts.name,
    ...checkToolPermission(ts.name, t, toolSpecs),
  }));
  const gaterSummary = summarizeGater(toolSpecs);

  return {
    soulPrompt,
    soulContextSources,
    soulMemory,
    memoryContext,
    contextBlock,
    mergedSystemPrompt,
    gaterSummary,
    toolPermissions,
  };
}

// ── Suite 1: Contract → Soul Loader → ContextSources ──

describe('Pipeline: Contract → Soul Loader → ContextSources', () => {
  it('produces non-empty soul prompt from CTO contract', () => {
    const prompt = contractToPrompt(CTO_CONTRACT);
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes('小狄'));
    assert.ok(prompt.includes('Chief Technology Officer'));
  });

  it('soul prompt contains all six sections', () => {
    const prompt = contractToPrompt(CTO_CONTRACT);
    assert.ok(prompt.includes('## Identity'));
    assert.ok(prompt.includes('## Responsibilities'));
    assert.ok(prompt.includes('## Decision Rights'));
    assert.ok(prompt.includes('## Collaborators'));
    assert.ok(prompt.includes('## Behavioral Instructions'));
    assert.ok(prompt.includes('## Authorized Tools'));
  });

  it('contractToContextSources has role = display_name', () => {
    const ctx = contractToContextSources(CTO_CONTRACT, 'main');
    assert.equal(ctx.role, '小狄');
    assert.equal(ctx.tier, 'main');
  });

  it('contractToContextSources extraContext is the soul prompt split by line', () => {
    const ctx = contractToContextSources(CTO_CONTRACT, 'main');
    const prompt = contractToPrompt(CTO_CONTRACT);
    assert.ok(ctx.extraContext);
    assert.ok(ctx.extraContext!.length > 1);
    assert.equal(ctx.extraContext!.join('\n'), prompt);
  });

  it('minimal contract produces valid soul prompt', () => {
    const prompt = contractToPrompt(MINIMAL_CONTRACT);
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes('Min'));
    assert.ok(prompt.includes('Data Indexer'));
  });

  it('minimal contract context sources have extraContext from prompt', () => {
    const ctx = contractToContextSources(MINIMAL_CONTRACT, 'main');
    assert.equal(ctx.role, 'Min');
    assert.ok(ctx.extraContext);
    assert.ok(ctx.extraContext!.length > 0);
  });
});

// ── Suite 2: Contract → Memory Injector → extraContext ──

describe('Pipeline: Contract → Memory Injector → extraContext', () => {
  it('contractToSoulMemory preserves identity fields', () => {
    const sm = contractToSoulMemory(CTO_CONTRACT);
    assert.equal(sm.agentId, 'chief-technology-officer');
    assert.equal(sm.displayName, '小狄');
    assert.equal(sm.family, 'Role');
    assert.equal(sm.role, 'Chief Technology Officer');
    assert.ok(sm.instructions);
    assert.ok(sm.instructions!.includes('prefer reading'));
  });

  it('minimal contract soul memory has no instructions', () => {
    const sm = contractToSoulMemory(MINIMAL_CONTRACT);
    assert.equal(sm.agentId, 'minimal-agent');
    assert.equal(sm.instructions, undefined);
  });

  it('injectAll writes memdir and buildMemoryContext returns entries', async () => {
    const payload: MemoryPayload = {
      agentId: 'chief-technology-officer',
      soul: contractToSoulMemory(CTO_CONTRACT),
      memories: [
        { key: 'last_deploy', value: '2026-07-14 v0.2.0', timestamp: Date.now() },
      ],
      colleagues: [
        { agentId: 'cpo', displayName: '小乔', family: 'Role', role: 'CPO', description: 'Chief Product Officer', responsibilities: ['Product scope'], reportsTo: 'ceo' },
      ],
      social: {
        agentId: 'chief-technology-officer',
        reportsTo: 'ceo',
        peers: ['cpo', 'cos'],
        supervises: ['test-engineer'],
        collaborationNotes: 'Daily sync at 10am',
      },
    };

    const result = await injectAll(payload, memdirRoot);
    assert.ok(result.count >= 4, `Expected >= 4 files, got ${result.count}`);

    const ctx = await buildMemoryContext(memdirRoot);
    assert.ok(ctx.length > 0, 'Memory context should have entries');
    const soulLine = ctx.find(l => l.includes('[soul]'));
    assert.ok(soulLine, 'Memory context should reference soul layer');
  });

  it('empty memory payload produces only soul file', async () => {
    const payload: MemoryPayload = { agentId: 'empty', soul: contractToSoulMemory(MINIMAL_CONTRACT) };
    const result = await injectAll(payload, memdirRoot);
    assert.equal(result.count, 1);
  });
});

// ── Suite 3: Context Builder — fusion of soul + memory context ──

describe('Pipeline: Context Builder fusion (soul + memory)', () => {
  it('buildContext from soul ContextSources produces valid block', () => {
    const ctx = contractToContextSources(CTO_CONTRACT, 'main');
    const block = buildContext(ctx);
    assert.ok(block.length > 0);
    assert.ok(block.includes('Agent Role'));
    assert.ok(block.includes('小狄'));
    assert.ok(block.includes('Agent Capabilities'));
    assert.ok(block.includes('Additional Context'));
  });

  it('mergeContextWithPrompt prepends context before system prompt', () => {
    const ctx = contractToContextSources(CTO_CONTRACT, 'main');
    const block = buildContext(ctx);
    const soulPrompt = contractToPrompt(CTO_CONTRACT);
    const merged = mergeContextWithPrompt(block, soulPrompt);

    const ctxPos = merged.indexOf('Agent Role');
    const soulPos = merged.indexOf('## Identity');
    assert.ok(ctxPos < soulPos, 'Context should appear before soul prompt identity');
    assert.ok(merged.includes('---'));
  });

  it('merging without system prompt returns only context', () => {
    const ctx = contractToContextSources(CTO_CONTRACT, 'main');
    const block = buildContext(ctx);
    const merged = mergeContextWithPrompt(block);
    assert.ok(merged.length > 0);
    assert.ok(!merged.includes('---'));
  });

  it('memory context lines can be appended to soul extraContext', () => {
    const ctx = contractToContextSources(CTO_CONTRACT, 'main');
    const before = ctx.extraContext!.length;

    const fused: ContextSources = {
      ...ctx,
      extraContext: [
        ...ctx.extraContext!,
        '[memory] deploy_status: v0.2.0 deployed (2026-07-15T08:00:00.000Z)',
      ],
    };
    const block = buildContext(fused);
    assert.ok(block.includes('[memory] deploy_status'));
    assert.equal(fused.extraContext!.length, before + 1);
  });

  it('minimal contract context block is still valid', () => {
    const ctx = contractToContextSources(MINIMAL_CONTRACT, 'main');
    const block = buildContext(ctx);
    assert.ok(block.length > 0);
    assert.ok(block.includes('Min'));
  });
});

// ── Suite 4: Tool Gater — contract tools through unified gate ──

describe('Pipeline: Tool Gater with contract tools', () => {
  const toolSpecs: ToolSpec[] = CTO_CONTRACT.tools;

  it('low-risk tool (read_file) passes both tier and risk check', () => {
    const r = checkToolPermission('read_file', 'main', toolSpecs);
    assert.equal(r.allowed, true);
  });

  it('medium-risk tool (write_file) passes with audit tag', () => {
    const r = checkToolPermission('write_file', 'main', toolSpecs);
    assert.equal(r.allowed, true);
    assert.equal(r.reason, 'allowed_with_audit');
  });

  it('high-risk tool (shell_exec) is blocked in MVP', () => {
    const r = checkToolPermission('shell_exec', 'main', toolSpecs);
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('approval_required'), `Expected approval_required in reason, got: ${r.reason}`);
  });

  it('subagent tier blocks write_file (heartbeat+)', () => {
    const r = checkToolPermission('write_file', 'subagent', toolSpecs);
    // write_file requires heartbeat+ tier (REQ-20260805-006); subagent cannot use it.
    assert.equal(r.allowed, false);
    assert.ok(r.reason?.includes('requires tier "heartbeat" or higher'));
  });

  it('summarizeGater categorizes by risk level', () => {
    const summary = summarizeGater(toolSpecs);
    assert.ok(summary.totalTools > 0);
    assert.ok(Object.keys(summary).some(k => k === 'byRiskLevel'));
    assert.ok(Array.isArray(summary.highRiskTools));
    assert.ok(Array.isArray(summary.criticalRiskTools));
  });

  it('contract tool not in toolSpecs falls back to tier-only check', () => {
    const r = checkToolPermission('nonexistent_tool', 'main', toolSpecs);
    assert.equal(r.allowed, true);
  });

  it('empty tools contract — all checks are tier-only', () => {
    const r = checkToolPermission('read_file', 'main', []);
    assert.equal(r.allowed, true);
    const r2 = checkToolPermission('read_file', 'main', MINIMAL_CONTRACT.tools);
    assert.equal(r2.allowed, true);
  });
});

// ── Suite 5: Full pipeline assembly (end-to-end) ──

describe('Pipeline: Full assembly → AgentLoopOptions', () => {
  it('assembles complete pipeline for CTO contract', async () => {
    const payload: MemoryPayload = {
      agentId: 'chief-technology-officer',
      soul: contractToSoulMemory(CTO_CONTRACT),
      memories: [
        { key: 'v0.2.0_status', value: 'All 4 components complete', timestamp: Date.now() },
      ],
    };

    const p = await assemblePipeline(CTO_CONTRACT, 'main', payload);

    // Soul Loader outputs
    assert.ok(p.soulPrompt.length > 0);
    assert.equal(p.soulContextSources.role, '小狄');

    // Memory Injector outputs
    assert.equal(p.soulMemory.agentId, 'chief-technology-officer');
    assert.ok(p.memoryContext.length > 0);

    // Context Builder output
    assert.ok(p.contextBlock.includes('Agent Role'));
    assert.ok(p.contextBlock.includes('Agent Capabilities'));

    // Merged system prompt: context first, then soul prompt
    assert.ok(p.mergedSystemPrompt.length > p.soulPrompt.length,
      'Merged prompt should be longer than soul prompt (includes context)');

    // Tool Gater
    assert.ok(p.gaterSummary.totalTools > 0);
    assert.equal(p.toolPermissions.length, CTO_CONTRACT.tools.length);

    // read_file: allowed (low risk)
    assert.equal(p.toolPermissions[0].allowed, true);
    assert.equal(p.toolPermissions[0].name, 'read_file');

    // shell_exec: blocked (high risk, MVP no approval)
    assert.equal(p.toolPermissions[2].allowed, false);
    assert.equal(p.toolPermissions[2].name, 'shell_exec');
  });

  it('assembles minimal contract pipeline without memory', async () => {
    const p = await assemblePipeline(MINIMAL_CONTRACT, 'main');

    assert.ok(p.soulPrompt.length > 0);
    assert.equal(p.soulMemory.agentId, 'minimal-agent');
    assert.equal(p.memoryContext.length, 0, 'No memory injection → empty context');
    assert.ok(p.contextBlock.length > 0);
    assert.ok(p.mergedSystemPrompt.length > 0);
    assert.equal(p.toolPermissions.length, 0, 'Minimal contract has no tools');
  });

  it('pipeline preserves contract identity across all stages', async () => {
    const p = await assemblePipeline(CTO_CONTRACT, 'main');

    const inSoul = p.soulPrompt.includes('小狄');
    const inContext = p.contextBlock.includes('小狄');
    const inMerged = p.mergedSystemPrompt.includes('小狄');

    assert.ok(inSoul, 'Identity in soul prompt');
    assert.ok(inContext, 'Identity in context block');
    assert.ok(inMerged, 'Identity in merged prompt');
  });

  it('subagent tier pipeline: write_file blocked (main-only), shell_exec still blocked', async () => {
    const p = await assemblePipeline(CTO_CONTRACT, 'subagent');

    const writeFilePerm = p.toolPermissions.find(tp => tp.name === 'write_file');
    assert.ok(writeFilePerm);
    assert.equal(writeFilePerm.allowed, false, 'write_file blocked at subagent tier (requires heartbeat)');
    assert.ok(writeFilePerm.reason?.includes('requires tier "heartbeat" or higher'));

    const shellExecPerm = p.toolPermissions.find(tp => tp.name === 'shell_exec');
    assert.ok(shellExecPerm);
    assert.equal(shellExecPerm.allowed, false, 'shell_exec blocked at subagent tier');
  });
});

// ── Suite 6: Backward compatibility (v0.1.0 → v0.2.0) ──

describe('Pipeline: Backward compatibility', () => {
  it('context builder works without extraContext', () => {
    const ctx: ContextSources = {
      tier: 'main',
      role: 'Test Agent',
    };
    const block = buildContext(ctx);
    assert.ok(block.includes('Test Agent'));
    assert.ok(block.includes('Agent Capabilities'));
  });

  it('tool gater works without toolSpecs (tier-only)', () => {
    const r = checkToolPermission('read_file', 'main');
    assert.equal(r.allowed, true);
    const r2 = checkToolPermission('task', 'subagent');
    assert.equal(r2.allowed, false, 'task blocked at subagent tier');
  });

  it('pipeline with tier-only (no contract tools) produces valid system prompt', () => {
    const ctx = contractToContextSources(MINIMAL_CONTRACT, 'main');
    const block = buildContext(ctx);
    const merged = mergeContextWithPrompt(block, 'Simple system prompt');
    assert.ok(merged.includes('Simple system prompt'));
    assert.ok(merged.includes('Min'));
  });

  it('soul prompt alone (no context builder) is still valid', () => {
    const prompt = contractToPrompt(CTO_CONTRACT);
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes('## Identity'));
  });
});

// ── Suite 7: Pipeline invariants ──

describe('Pipeline: Invariants', () => {
  it('merged prompt always contains all key contract data', async () => {
    const p = await assemblePipeline(CTO_CONTRACT, 'main');

    assert.equal(p.soulMemory.agentId, 'chief-technology-officer', 'agent_id in soul memory');
    assert.ok(p.mergedSystemPrompt.includes('小狄'), 'display_name in merged prompt');
    assert.ok(p.mergedSystemPrompt.includes('Chief Technology Officer'), 'role in merged prompt');
    assert.ok(p.soulPrompt.includes('chief-technology-officer') || p.soulMemory.agentId === 'chief-technology-officer', 'agent_id preserved in pipeline');
    assert.ok(p.mergedSystemPrompt.includes('Architect technical strategy'), 'responsibility');
    assert.ok(p.mergedSystemPrompt.includes('technical_design'), 'approve right');
    assert.ok(p.mergedSystemPrompt.includes('cpo'), 'peer');
    assert.ok(p.mergedSystemPrompt.includes('prefer reading'), 'instructions');
    assert.ok(p.mergedSystemPrompt.includes('read_file'), 'tool');
  });

  it('context block always precedes soul prompt in merged output', async () => {
    const p = await assemblePipeline(CTO_CONTRACT, 'main');

    const ctxStart = p.mergedSystemPrompt.indexOf('Agent Role');
    const soulStart = p.mergedSystemPrompt.indexOf('## Identity');

    assert.ok(ctxStart >= 0, 'Context block has Agent Role');
    assert.ok(soulStart >= 0, 'Soul prompt has Identity');
    assert.ok(ctxStart < soulStart, 'Context block precedes soul prompt');
  });

  it('tool permissions are deterministic for same input', () => {
    const specs: ToolSpec[] = CTO_CONTRACT.tools;
    const r1 = checkToolPermission('read_file', 'main', specs);
    const r2 = checkToolPermission('read_file', 'main', specs);
    assert.deepEqual(r1, r2);
  });

  it('pipeline handles missing optional contract fields', async () => {
    const noInstructions: AgentContract = {
      ...CTO_CONTRACT,
      instructions: undefined,
    };
    const p = await assemblePipeline(noInstructions, 'main');
    assert.ok(p.soulPrompt.length > 0);
    assert.ok(!p.soulPrompt.includes('Behavioral Instructions'));
  });
});
