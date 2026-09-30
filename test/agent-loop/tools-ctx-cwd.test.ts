// ── TriMMC tools ctx.cwd propagation tests (r4-1 A-TriMMC) ──
// Same REQ-014b gate as TriRLC, two shapes:
//   1. ctx.cwd present → relative bases resolve against the agent loop cwd.
//   2. ctx absent (legacy direct callers) → falls back to process.cwd().
// Also pins the executeTool wrapper third-param passthrough.
// Existing agent-tools.test.ts expectations are untouched — this file only adds.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDir: string;
let dirA: string;
let dirB: string;
let executeTool: (name: string, args: Record<string, unknown>, ctx?: { cwd?: string }) => Promise<string>;

before(async () => {
  const mod = await import('../../src/agent-loop/tools.js');
  executeTool = mod.executeTool;
  testDir = mkdtempSync(join(tmpdir(), 'trimc-ctx-cwd-'));
  dirA = join(testDir, 'dirA');
  dirB = join(testDir, 'dirB');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'a.ts'), 'export const a = 1;\n', 'utf-8');
  writeFileSync(join(dirB, 'b.ts'), 'export const b = 2;\n', 'utf-8');
});

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('ctx.cwd propagation — TriMMC built-in tools (A-TriMMC)', () => {
  it('glob_search: relative base resolves against ctx.cwd', async () => {
    // TriMMC glob_search matches literal segments (and ** wildcards) — use the
    // literal filename so the test pins the cwd resolution, not wildcard
    // semantics (which are covered by existing agent-tools tests).
    const result = JSON.parse(await executeTool('glob_search', { pattern: 'a.ts' }, { cwd: dirA }));
    assert.equal(result.base.toLowerCase(), dirA.toLowerCase());
    assert.ok(result.matches.includes('a.ts'), `expected a.ts in ${JSON.stringify(result.matches)}`);
    assert.ok(!result.matches.includes('b.ts'), `b.ts must not leak from dirB: ${JSON.stringify(result.matches)}`);
  });

  it('glob_search: dirB file invisible from dirA ctx.cwd', async () => {
    const result = JSON.parse(await executeTool('glob_search', { pattern: 'b.ts' }, { cwd: dirA }));
    assert.equal(result.base.toLowerCase(), dirA.toLowerCase());
    assert.deepEqual(result.matches, [], `b.ts must not be found under dirA: ${JSON.stringify(result.matches)}`);
  });

  it('shell_exec: args.cwd wins over ctx.cwd (legacy semantics preserved)', async () => {
    const result = JSON.parse(await executeTool('shell_exec', { command: 'cd', cwd: dirB }, { cwd: dirA }));
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.toLowerCase().includes(dirB.toLowerCase()), `stdout=${result.stdout}`);
  });

  it('shell_exec: ctx.cwd used when args.cwd omitted', async () => {
    const result = JSON.parse(await executeTool('shell_exec', { command: 'cd' }, { cwd: dirA }));
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.toLowerCase().includes(dirA.toLowerCase()), `stdout=${result.stdout}`);
  });

  it('read_file: absolute path unaffected by ctx (unchanged shape)', async () => {
    const result = JSON.parse(await executeTool('read_file', { path: join(dirA, 'a.ts') }, { cwd: dirB }));
    assert.ok(result.content.includes('export const a'));
  });
});

describe('ctx absent — legacy fallback to process.cwd() (A-TriMMC)', () => {
  it('glob_search without ctx defaults to process.cwd()', async () => {
    const result = JSON.parse(await executeTool('glob_search', { pattern: '*.ts' }));
    assert.equal(result.base.toLowerCase(), process.cwd().toLowerCase());
    assert.ok(Array.isArray(result.matches));
  });

  it('shell_exec without ctx falls back to process.cwd()', async () => {
    const result = JSON.parse(await executeTool('shell_exec', { command: 'cd' }));
    assert.equal(result.exit_code, 0);
    assert.ok(result.stdout.toLowerCase().includes(process.cwd().toLowerCase()), `stdout=${result.stdout}`);
  });
});
