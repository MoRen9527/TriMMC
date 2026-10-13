// TriMMC Memory Injector Tests
// CTO-006: Validates four-layer memory injection (soul/memory/colleagues/social)
// and buildMemoryContext integration with Context Builder pipeline.

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';

import {
  injectSoul,
  injectMemories,
  injectColleagues,
  injectSocial,
  injectAll,
  buildMemoryContext,
  contractToSoulMemory,
  type SoulMemory,
  type EpisodicMemory,
  type ColleagueMemory,
  type SocialMemory,
  type MemoryPayload,
} from '../../src/memory-injector/memory-injector.js';

import type { AgentContract } from '../../src/contracts/agent-contract.js';

// Test Helpers

let memdirRoot: string;

before(async () => {
  memdirRoot = await mkdtemp(join(tmpdir(), 'trimc-memory-test-'));
});

after(async () => {
  await rm(memdirRoot, { recursive: true, force: true });
});

function memdir(sub: string): string {
  return join(memdirRoot, sub);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// Fixtures

const CTO_SOUL: SoulMemory = {
  agentId: 'cto-xiaodi',
  displayName: 'XiaoDi',
  family: 'Role',
  role: 'Chief Technology Officer',
  description: 'CTO responsible for MVP delivery path and quality gates.',
  instructions: 'Always check BusinessStrategy and code-state.md before giving technical judgment.',
};

const EPISODIC: EpisodicMemory[] = [
  {
    key: 'prefers_go_backend',
    value: 'User prefers Go for backend, avoids Python.',
    timestamp: 1720000000000,
  },
  {
    key: 'registry_convention',
    value: 'Registry Agents use <Module>Registry naming convention.',
  },
];

const COLLEAGUES: ColleagueMemory[] = [
  {
    agentId: 'cpo-xiaoqiao',
    displayName: 'XiaoQiao',
    family: 'Role',
    role: 'Chief Product Officer',
    description: 'CPO responsible for product scope and user stories.',
    responsibilities: ['Define MVP scope', 'Maintain product backlog', 'Acceptance testing'],
    reportsTo: 'CEO',
  },
  {
    agentId: 'business-strategy',
    displayName: 'BusinessStrategy',
    family: 'Registry',
    role: 'Central Business Strategy Registry',
    description: 'Central Strategy Registry for the entire TriMetaverse.',
    responsibilities: ['Business model arbitration', 'Module boundary definition', 'Delivery priority'],
    reportsTo: 'CEO',
  },
];

const SOCIAL: SocialMemory = {
  agentId: 'cto-xiaodi',
  reportsTo: 'CEO',
  peers: ['cpo-xiaoqiao', 'ceo-chief-of-staff'],
  supervises: [],
  collaborationNotes: 'Forms minimum closed loop with CPO on product scope, delivery path, and quality gates.',
};

const FULL_PAYLOAD: MemoryPayload = {
  agentId: 'cto-xiaodi',
  soul: CTO_SOUL,
  memories: EPISODIC,
  colleagues: COLLEAGUES,
  social: SOCIAL,
};

// Suite 1: injectSoul

describe('injectSoul', () => {
  it('writes soul/SOUL.md with identity sections', async () => {
    const result = await injectSoul(CTO_SOUL, memdir('s1'));
    assert.equal(result.count, 1);
    assert.ok(result.files[0].endsWith('SOUL.md'));
    assert.ok(result.files[0].includes('soul'));

    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(content.includes('type: soul'));
    assert.ok(content.includes('agent_id: cto-xiaodi'));
    assert.ok(content.includes('# XiaoDi'));
    assert.ok(content.includes('**Family**: Role'));
    assert.ok(content.includes('## Description'));
    assert.ok(content.includes('## Instructions'));
    assert.ok(content.includes('BusinessStrategy'));
  });

  it('omits Instructions section when none provided', async () => {
    const noInstructions: SoulMemory = { ...CTO_SOUL, instructions: undefined };
    const result = await injectSoul(noInstructions, memdir('s1b'));
    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(!content.includes('## Instructions'));
  });

  it('omits Instructions section when blank', async () => {
    const blankInstructions: SoulMemory = { ...CTO_SOUL, instructions: '' };
    const result = await injectSoul(blankInstructions, memdir('s1c'));
    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(!content.includes('## Instructions'));
  });
});

// Suite 2: injectMemories

describe('injectMemories', () => {
  it('writes one .md file per memory with key as filename', async () => {
    const result = await injectMemories(EPISODIC, 'cto-xiaodi', memdir('s2'));
    assert.equal(result.count, 2);
    assert.ok(result.files[0].endsWith('prefers_go_backend.md'));
    assert.ok(result.files[1].endsWith('registry_convention.md'));

    const content0 = await readFile(result.files[0], 'utf-8');
    assert.ok(content0.includes('type: memory'));
    assert.ok(content0.includes('agent_id: cto-xiaodi'));
    assert.ok(content0.includes('Go'));
  });

  it('returns empty result for empty array', async () => {
    const result = await injectMemories([], 'cto-xiaodi', memdir('s2b'));
    assert.equal(result.count, 0);
    assert.deepEqual(result.files, []);
  });

  it('sanitizes key names for safe filenames', async () => {
    const trickyKey: EpisodicMemory[] = [
      { key: 'user/prefs: go?!', value: 'sanitized.' },
    ];
    const result = await injectMemories(trickyKey, 'test', memdir('s2c'));
    const name = result.files[0].split(/[\\/]/).pop();
    assert.ok(name);
    assert.ok(!name!.includes('/'));
    assert.ok(!name!.includes(':'));
    assert.ok(!name!.includes('?'));
    assert.ok(name!.endsWith('.md'));
  });
});

// Suite 3: injectColleagues

describe('injectColleagues', () => {
  it('writes one .md per colleague with responsibilities', async () => {
    const result = await injectColleagues(COLLEAGUES, memdir('s3'));
    assert.equal(result.count, 2);
    assert.ok(result.files[0].endsWith('cpo-xiaoqiao.md'));
    assert.ok(result.files[1].endsWith('business-strategy.md'));

    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(content.includes('type: colleagues'));
    assert.ok(content.includes('# XiaoQiao'));
    assert.ok(content.includes('**Family**: Role'));
    assert.ok(content.includes('**Reports to**: CEO'));
    assert.ok(content.includes('## Responsibilities'));
    assert.ok(content.includes('- Define MVP scope'));
  });

  it('returns empty result for empty array', async () => {
    const result = await injectColleagues([], memdir('s3b'));
    assert.equal(result.count, 0);
  });
});

// Suite 4: injectSocial

describe('injectSocial', () => {
  it('writes social/graph.md with peers and supervises', async () => {
    const result = await injectSocial(SOCIAL, memdir('s4'));
    assert.equal(result.count, 1);
    assert.ok(result.files[0].endsWith('graph.md'));
    assert.ok(result.files[0].includes('social'));

    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(content.includes('type: social'));
    assert.ok(content.includes('# Social Graph: cto-xiaodi'));
    assert.ok(content.includes('**Reports to**: CEO'));
    assert.ok(content.includes('## Peers'));
    assert.ok(content.includes('- cpo-xiaoqiao'));
    assert.ok(content.includes('- ceo-chief-of-staff'));
    assert.ok(content.includes('## Supervises'));
    assert.ok(content.includes('(none)'));
    assert.ok(content.includes('## Collaboration Notes'));
  });

  it('handles empty peers and supervises lists', async () => {
    const noRelations: SocialMemory = {
      agentId: 'lonely-agent',
      reportsTo: 'CEO',
      peers: [],
      supervises: [],
    };
    const result = await injectSocial(noRelations, memdir('s4b'));
    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(content.includes('(none)'));
  });

  it('omits Collaboration Notes when not provided', async () => {
    const noNotes: SocialMemory = { ...SOCIAL, collaborationNotes: undefined };
    const result = await injectSocial(noNotes, memdir('s4c'));
    const content = await readFile(result.files[0], 'utf-8');
    assert.ok(!content.includes('## Collaboration Notes'));
  });
});

// Suite 5: injectAll

describe('injectAll', () => {
  it('writes all four layers for a full payload', async () => {
    const result = await injectAll(FULL_PAYLOAD, memdir('s5'));
    // soul(1) + memories(2) + colleagues(2) + social(1) = 6
    assert.equal(result.count, 6);

    const dir = memdir('s5');
    assert.ok(await fileExists(join(dir, 'soul', 'SOUL.md')));
    assert.ok(await fileExists(join(dir, 'memory', 'prefers_go_backend.md')));
    assert.ok(await fileExists(join(dir, 'colleagues', 'cpo-xiaoqiao.md')));
    assert.ok(await fileExists(join(dir, 'social', 'graph.md')));
  });

  it('handles payload with only soul layer', async () => {
    const partial: MemoryPayload = { agentId: 'test', soul: CTO_SOUL };
    const result = await injectAll(partial, memdir('s5b'));
    assert.equal(result.count, 1);
    assert.ok(result.files[0].endsWith('SOUL.md'));
    assert.ok(result.files[0].includes('soul'));
  });

  it('handles payload with only memories', async () => {
    const partial: MemoryPayload = { agentId: 'test', memories: EPISODIC };
    const result = await injectAll(partial, memdir('s5c'));
    assert.equal(result.count, 2);
  });

  it('handles payload with only colleagues', async () => {
    const partial: MemoryPayload = { agentId: 'test', colleagues: COLLEAGUES };
    const result = await injectAll(partial, memdir('s5d'));
    assert.equal(result.count, 2);
  });

  it('handles payload with only social', async () => {
    const partial: MemoryPayload = { agentId: 'test', social: SOCIAL };
    const result = await injectAll(partial, memdir('s5e'));
    assert.equal(result.count, 1);
  });

  it('returns empty result for empty payload', async () => {
    const empty: MemoryPayload = { agentId: 'empty' };
    const result = await injectAll(empty, memdir('s5f'));
    assert.equal(result.count, 0);
    assert.deepEqual(result.files, []);
  });

  it('skips empty memories array in full payload', async () => {
    const noMems: MemoryPayload = { ...FULL_PAYLOAD, memories: [] };
    const result = await injectAll(noMems, memdir('s5g'));
    // soul(1) + colleagues(2) + social(1) = 4
    assert.equal(result.count, 4);
  });

  it('skips empty colleagues array in full payload', async () => {
    const noColleagues: MemoryPayload = { ...FULL_PAYLOAD, colleagues: [] };
    const result = await injectAll(noColleagues, memdir('s5h'));
    // soul(1) + memories(2) + social(1) = 4
    assert.equal(result.count, 4);
  });
});

// Suite 6: buildMemoryContext

describe('buildMemoryContext', () => {
  it('returns manifest lines for populated memdir', async () => {
    const mdir = memdir('s6');
    await injectAll(FULL_PAYLOAD, mdir);

    const lines = await buildMemoryContext(mdir);
    assert.ok(lines.length >= 6);

    const soulLine = lines.find(l => l.includes('SOUL.md'));
    assert.ok(soulLine);
    assert.ok(soulLine!.includes('[soul]'));

    const memLine = lines.find(l => l.includes('prefers_go_backend'));
    assert.ok(memLine);
    assert.ok(memLine!.includes('[memory]'));

    const colLine = lines.find(l => l.includes('cpo-xiaoqiao'));
    assert.ok(colLine);
    assert.ok(colLine!.includes('[colleagues]'));

    const socLine = lines.find(l => l.includes('graph.md'));
    assert.ok(socLine);
    assert.ok(socLine!.includes('[social]'));
  });

  it('returns empty array for nonexistent directory', async () => {
    const lines = await buildMemoryContext(memdir('nonexistent'));
    assert.deepEqual(lines, []);
  });

  it('returns empty array for empty memdir', async () => {
    const emptyDir = memdir('s6c');
    const lines = await buildMemoryContext(emptyDir);
    assert.deepEqual(lines, []);
  });
});

// Suite 7: contractToSoulMemory

describe('contractToSoulMemory', () => {
  it('extracts SoulMemory from an AgentContract', () => {
    const contract: AgentContract = {
      agent_id: 'cto-xiaodi',
      version: '1.0',
      identity: {
        display_name: 'XiaoDi',
        family: 'Role',
        role: 'Chief Technology Officer',
        description: 'CTO description',
        user_invocable: true,
      },
      responsibilities: [{ description: 'Deliver MVP', priority: 'high' }],
      decision_rights: {
        approve: ['tech'],
        freeze: [],
        escalate: ['strategy'],
        forbidden: ['product'],
      },
      collaborators: {
        reports_to: 'CEO',
        peers: ['cpo-xiaoqiao'],
        supervises: [],
      },
      tools: [],
      io_contract: { inputs: [], outputs: [] },
      instructions: 'Always check BusinessStrategy first.',
    };

    const soul = contractToSoulMemory(contract);
    assert.equal(soul.agentId, 'cto-xiaodi');
    assert.equal(soul.displayName, 'XiaoDi');
    assert.equal(soul.family, 'Role');
    assert.equal(soul.role, 'Chief Technology Officer');
    assert.equal(soul.instructions, 'Always check BusinessStrategy first.');
  });

  it('handles contract without instructions', () => {
    const contract: AgentContract = {
      agent_id: 'registry-agent',
      version: '1.0',
      identity: {
        display_name: 'TestRegistry',
        family: 'Registry',
        role: 'Data Index',
        description: 'Index only',
        user_invocable: false,
      },
      responsibilities: [],
      decision_rights: {
        approve: [],
        freeze: [],
        escalate: [],
        forbidden: [],
      },
      collaborators: {
        reports_to: 'nobody',
        peers: [],
        supervises: [],
      },
      tools: [],
      io_contract: { inputs: [], outputs: [] },
    };

    const soul = contractToSoulMemory(contract);
    assert.equal(soul.family, 'Registry');
    assert.equal(soul.instructions, undefined);
  });
});

// Suite 8: Integration - memory into context pipeline

describe('Memory to Context Pipeline', () => {
  it('injectAll then buildMemoryContext produces valid extraContext', async () => {
    const mdir = memdir('s8');
    await injectAll(FULL_PAYLOAD, mdir);
    const context = await buildMemoryContext(mdir);

    for (const line of context) {
      assert.ok(line.startsWith('- '));
    }

    const text = context.join('\n');
    assert.ok(text.includes('[soul]'));
    assert.ok(text.includes('[memory]'));
    assert.ok(text.includes('[colleagues]'));
    assert.ok(text.includes('[social]'));
  });
});
