// ── Session Initializer Unit Test (v3 contracts) ──
// 6.4 (r13-2 收敛): TriMMC server-side employee session initialization from
// same-source v3 contracts via agent-core loadContractV3.
// O3: W_OK workspace check with negative path.
// Uses a self-built fixture — does not depend on the TriCompany repo path.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSession, loadV2Contracts, SessionInitError } from '../src/onboarding/session-initializer.js';

describe('Session Initializer (v3 contracts)', () => {
  let sourceAgentsDir: string | undefined;
  let workspaceRoot: string | undefined;

  before(async () => {
    sourceAgentsDir = await mkdtemp(join(tmpdir(), 'trimc-session-init-'));
    const agentDir = join(sourceAgentsDir, 'sample-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'Sample soul', 'utf-8'),
      writeFile(join(agentDir, 'agent-body.agent.md'), 'Sample body', 'utf-8'),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), 'tools:\n  - read', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), 'Sample memory', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), 'Sample colleagues', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), 'Sample social', 'utf-8'),
      writeFile(
        join(agentDir, 'sample-agent.contract.yaml'),
        [
          'contract:',
          '  version: "3.0"',
          '  type: agent-contract',
          '  agent_id: sample-agent',
          '  family: Role',
          'identity:',
          '  display_name: sample',
          '  role: SampleAgent',
          '  description: test agent',
          'paths:',
          '  soul: sample-agent/soul.agent.md',
          '  agent_body: sample-agent/agent-body.agent.md',
          '  agent_frontmatter: sample-agent/agent-frontmatter.agent.md',
          '  memory: sample-agent/memory.agent.md',
          '  colleagues: sample-agent/colleagues.agent.md',
          '  social: sample-agent/social.agent.md',
          'responsibilities:',
          '  - test duty',
          'decision_rights:',
          '  approve:',
          '    - release',
          '  forbidden:',
          '    - skip tests',
          'collaborators:',
          '  reports_to: ceo',
          'io_contract:',
          '  inputs:',
          '    - type: msg',
          '      description: test input',
          '  outputs:',
          '    - type: res',
          '      description: test output',
          'runtime_baseline:',
          '  host: tri-mc',
        ].join('\n'),
        'utf-8',
      ),
    ]);
  });

  after(async () => {
    for (const dir of [sourceAgentsDir, workspaceRoot]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('loads v3 contracts from a source-agents directory', () => {
    const contracts = loadV2Contracts(sourceAgentsDir!);
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0].agentId, 'sample-agent');
    assert.equal(contracts[0].systemPrompt, 'Sample soul\n\nSample body');
    assert.deepEqual(contracts[0].decisionRights, {
      approve: ['release'],
      freeze: [],
      escalate: [],
      forbidden: ['skip tests'],
    });
    assert.deepEqual(contracts[0].toolControl, { tools: ['read'] });
  });

  it('rejects v2-shaped contracts (negative path: no compat branch)', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'trimc-session-v2-'));
    const agentDir = join(legacyDir, 'legacy-agent');
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, 'legacy-agent.contract.yaml'),
      [
        'contract:',
        '  version: "2.0"',
        '  agent_id: legacy-agent',
        '  family: Role',
        'paths:',
        '  soul: legacy-agent/soul.agent.md',
      ].join('\n'),
      'utf-8',
    );

    assert.equal(loadV2Contracts(legacyDir).length, 0);
    await rm(legacyDir, { recursive: true, force: true });
  });

  it('initializes a session with workspace ready under workspaceRoot/<agentId>', async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'trimc-session-ws-'));
    const config = initializeSession('sample-agent', {
      sourceAgentsDir: sourceAgentsDir!,
      workspaceRoot,
    });

    assert.equal(config.agentId, 'sample-agent');
    assert.match(config.readyAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(config.workspaceRoot.endsWith(join('sample-agent')), 'workspace is per-agent');

    // Workspace directory created and writable
    await access(config.workspaceRoot, constants.W_OK);
  });

  it('throws SessionInitError for an unknown agent', () => {
    assert.throws(
      () => initializeSession('no-such-agent', {
        sourceAgentsDir: sourceAgentsDir!,
        workspaceRoot: tmpdir(),
      }),
      (err: unknown) => err instanceof SessionInitError && err.agentId === 'no-such-agent',
    );
  });

  // Windows 的 chmod 只读位不映射 Node W_OK 检查（FILE_ATTRIBUTE_READONLY 语义不同），
  // 负路径在 Linux（TriMMC 生产环境/CI）验证，本地 win32 跳过。
  const o3Negative = process.platform === 'win32' ? it.skip : it;
  o3Negative('O3: throws SessionInitError when workspace is not writable', async () => {
    // 读只目录负路径：chmod 只读 → W_OK 失败 → SessionInitError
    const readOnlyRoot = await mkdtemp(join(tmpdir(), 'trimc-session-ro-'));
    await chmod(readOnlyRoot, 0o555); // r-xr-xr-x
    try {
      assert.throws(
        () => initializeSession('sample-agent', {
          sourceAgentsDir: sourceAgentsDir!,
          workspaceRoot: readOnlyRoot,
        }),
        (err: unknown) => err instanceof SessionInitError,
      );
    } finally {
      await chmod(readOnlyRoot, 0o755);
      await rm(readOnlyRoot, { recursive: true, force: true });
    }
  });
});
