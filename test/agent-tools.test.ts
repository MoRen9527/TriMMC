// ── Agent Loop Built-in Tools Tests ──
// Validates tool handlers work correctly without a model call.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalFetch = globalThis.fetch;

let testDir: string;
let executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
let getToolDefinitions: () => Array<{ function: { name: string } }>;

describe('Agent Loop Tools', () => {
  before(async () => {
    // Mock DeepSeek API for task sub-agent dispatch
    process.env.DEEPSEEK_API_KEY = 'sk-test-task-tool';
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      // Pass through real network calls (none expected in these tests)
      if (!url.includes('api.deepseek.com') && !url.includes('deepseek')) {
        return originalFetch(input, init);
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-task-mock',
        model: 'deepseek-v4-pro',
        choices: [{
          message: { role: 'assistant', content: 'Task completed: mocked sub-agent response.' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const mod = await import('../src/agent-loop/tools.js');
    executeTool = mod.executeTool;
    getToolDefinitions = mod.getToolDefinitions;
    testDir = join(tmpdir(), `trimc-tool-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
    await rm(testDir, { recursive: true, force: true });
  });
  it('should register 6 tools', () => {
    const defs = getToolDefinitions();
    assert.ok(defs.length >= 6, `expected >=6 tools, got ${defs.length}`);
    const names = defs.map((d) => d.function.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('shell_exec'));
    assert.ok(names.includes('glob_search'));
    assert.ok(names.includes('task'));
  });

  it('write_file + read_file roundtrip', async () => {
    const filePath = join(testDir, 'hello.txt');
    const writeResult = await executeTool('write_file', { path: filePath, content: 'Hello TriMMC!' });
    const writeParsed = JSON.parse(writeResult);
    assert.equal(writeParsed.ok, true);

    const readResult = await executeTool('read_file', { path: filePath });
    const readParsed = JSON.parse(readResult);
    assert.ok(readParsed.content.includes('Hello TriMMC!'));
  });

  it('edit_file replaces unique string', async () => {
    const filePath = join(testDir, 'edit-test.txt');
    await writeFile(filePath, 'Hello World', 'utf-8');

    const editResult = await executeTool('edit_file', {
      path: filePath,
      old_str: 'Hello World',
      new_str: 'Hello TriMMC!',
    });
    const parsed = JSON.parse(editResult);
    assert.equal(parsed.ok, true);

    const readResult = await executeTool('read_file', { path: filePath });
    const readParsed = JSON.parse(readResult);
    assert.equal(readParsed.content, 'Hello TriMMC!');
  });

  it('edit_file returns error for non-unique old_str', async () => {
    const filePath = join(testDir, 'dup-test.txt');
    await writeFile(filePath, 'dup dup dup', 'utf-8');
    const result = await executeTool('edit_file', { path: filePath, old_str: 'dup', new_str: 'x' });
    const parsed = JSON.parse(result);
    assert.ok(parsed.error.includes('matches'));
  });

  it('shell_exec runs echo', async () => {
    const result = await executeTool('shell_exec', { command: 'echo hello from trimc' });
    const parsed = JSON.parse(result);
    assert.equal(parsed.exit_code, 0);
    assert.ok(parsed.stdout.includes('hello from trimc'));
  });

  it('shell_exec blocked command rejected by policy gate', async () => {
    // rm -rf is in denylist
    const result = await executeTool('shell_exec', { command: 'rm -rf /tmp/test' });
    const parsed = JSON.parse(result);
    assert.ok(parsed.error.includes('blocked by denylist'));
  });

  it('shell_exec unknown command rejected by allowlist', async () => {
    // Some random command not in allowlist
    const result = await executeTool('shell_exec', { command: 'some_unknown_command_xyz --flag' });
    const parsed = JSON.parse(result);
    assert.ok(parsed.error.includes('not in allowlist'));
  });

  it('shell_exec captures stderr', async () => {
    // `where`/`which` with a nonexistent target reliably writes to stderr on
    // failure, and both base commands are in the shell allowlist. This avoids
    // two problems with `node -e "..."`: (1) cmd.exe mangles the nested quotes
    // so stderr ends up empty, (2) node may be absent from cmd's PATH.
    const cmd = process.platform === 'win32'
      ? 'where nonexistent_xyz_123'
      : 'which nonexistent_xyz_123';
    const result = await executeTool('shell_exec', { command: cmd });
    const parsed = JSON.parse(result);
    assert.notEqual(parsed.exit_code, 0);
    assert.ok(parsed.stderr.length > 0, `expected non-empty stderr, got: ${parsed.stderr}`);
  });

  it('glob_search finds .ts files', async () => {
    const result = await executeTool('glob_search', { pattern: '**/*.ts', path: testDir });
    const parsed = JSON.parse(result);
    assert.ok(Array.isArray(parsed.matches));
  });

  it('glob_search with specific pattern', async () => {
    // Create file first to ensure it exists (tests can run in any order)
    await executeTool('write_file', { path: join(testDir, 'hello-search.txt'), content: 'test' });
    const result = await executeTool('glob_search', { pattern: 'hello-search.txt', path: testDir });
    const parsed = JSON.parse(result);
    assert.ok(parsed.matches.includes('hello-search.txt'));
  });

  it('task dispatches sub-agent and returns result', async () => {
    const result = await executeTool('task', { description: 'test task', prompt: 'Say hello.' });
    const parsed = JSON.parse(result);
    // Real sub-agent dispatch via agentLoop → modelClient.chat → mock fetch
    assert.equal(parsed.ok, true);
    assert.equal(parsed.description, 'test task');
    assert.ok(typeof parsed.content === 'string');
    assert.ok(parsed.content.length > 0);
    assert.equal(parsed.error, undefined);
  });

  it('unknown tool returns error', async () => {
    const result = await executeTool('nonexistent_tool', {});
    const parsed = JSON.parse(result);
    assert.ok(parsed.error.includes('Unknown tool'));
  });

  it('read_file missing path returns error', async () => {
    const result = await executeTool('read_file', {});
    const parsed = JSON.parse(result);
    assert.ok(parsed.error.includes('required'));
  });
});
