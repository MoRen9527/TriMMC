// ── TriMMC Agent Loop: Built-in Tool Registry ──
// CTO-008-C Phase C2: Registry layer delegates to @tricompany/agent-core.
// Concrete tool implementations (read_file, write_file, edit_file, shell_exec, glob_search, task)
// remain TriMMC-local and are registered into agent-core's shared registry.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { platform } from 'node:os';
import type { ToolDefinition } from 'trimodel';
import {
  register,
  getToolDefinitions as coreGetToolDefinitions,
  executeTool as coreExecuteTool,
  type ToolHandler,
  type ToolContext,
} from '@tricompany/agent-core';
import { createProcessSupervisor } from '@tricompany/agent-core';
import type { ProcessSupervisor } from '@tricompany/agent-core';

const shellSupervisor: ProcessSupervisor = createProcessSupervisor();

// ── Re-export agent-core registry primitives ──
export { register, type ToolHandler } from '@tricompany/agent-core';

// ── Tool Result Types ──

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

// ── Tier-aware getToolDefinitions (delegates to agent-core) ──

export function getToolDefinitions(tier?: import('./permissions.js').AgentTier): ToolDefinition[] {
  return coreGetToolDefinitions(tier);
}

// ── Safe executeTool (wraps agent-core's throw-based API) ──
// REQ-014b: third param passes the agent loop cwd through to tool handlers
// (ctx.cwd). No active call sites pass ctx today — legacy direct callers
// remain ctx-less and fall back to process.cwd() inside handlers.

export async function executeTool(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  try {
    return await coreExecuteTool(name, args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: msg });
  }
}

// ── Tool: read_file ──

register(
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to read.' },
        },
        required: ['path'],
      },
    },
  },
  async (args) => {
    const path = args.path as string;
    if (!path) return JSON.stringify({ error: 'path is required' });
    const content = await readFile(path, 'utf-8');
    return JSON.stringify({ path, content, size: content.length });
  },
);

// ── Tool: write_file ──

register(
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file, creating parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to write.' },
          content: { type: 'string', description: 'Content to write to the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  async (args) => {
    const path = args.path as string;
    const content = args.content as string;
    if (!path || content === undefined) return JSON.stringify({ error: 'path and content are required' });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    return JSON.stringify({ path, written: content.length, ok: true });
  },
);

// ── Tool: edit_file ──

register(
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace a specific string in a file. The old_str must match exactly one occurrence.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file to edit.' },
          old_str: { type: 'string', description: 'The exact string to replace.' },
          new_str: { type: 'string', description: 'The replacement string.' },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
  },
  async (args) => {
    const path = args.path as string;
    const oldStr = args.old_str as string;
    const newStr = args.new_str as string;
    if (!path || oldStr === undefined || newStr === undefined) {
      return JSON.stringify({ error: 'path, old_str, and new_str are required' });
    }
    const content = await readFile(path, 'utf-8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) return JSON.stringify({ error: 'old_str not found in file', path });
    if (count > 1) return JSON.stringify({ error: `old_str matches ${count} occurrences — must be unique`, path });
    const newContent = content.replace(oldStr, newStr);
    await writeFile(path, newContent, 'utf-8');
    return JSON.stringify({ path, replaced: true, ok: true });
  },
);

// ── Shell command wrapper (platform-aware) ──

function buildShellArgv(command: string): string[] {
  const isWindows = platform() === 'win32';
  if (isWindows) return ['cmd', '/c', command];
  return ['sh', '-c', command];
}

// ── Tool: shell_exec ──
// P3.4: Uses ProcessSupervisor for lifecycle management (cancel, proper timeout kill, runtime visibility).

const DEFAULT_ALLOWLIST = [
  'echo', 'ls', 'dir', 'cat', 'type', 'find', 'grep', 'findstr',
  'node', 'npm', 'npx', 'tsx', 'tsc',
  'git', 'python', 'pip', 'go', 'cargo', 'rustc',
  'mkdir', 'rmdir', 'mv', 'move', 'cp', 'copy',
  'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'curl', 'wget', 'nslookup', 'ping',
  'npx', 'pnpm', 'yarn',
  'where', 'which', 'whoami', 'hostname', 'date', 'time', 'pwd', 'cd',
  'printenv', 'env', 'set',
];

const DEFAULT_DENYLIST = [
  'rm -rf', 'rm -r', 'del /s', 'del /q', 'rd /s', 'rd /q',
  'format', 'shutdown', 'reboot', 'init', 'poweroff', 'halt',
  'chmod 777', 'chown',
  'sudo', 'su',
  ':(){ :|:& };:', // fork bomb
  'dd if=', 'mkfs', 'fdisk', 'parted',
  '> /dev/sda', '> /dev/nvme',
  'net user', 'net localgroup',
  'reg add', 'reg delete',
  'sc stop', 'sc config',
  'taskkill', 'Stop-Process',
];

function parsePolicyList(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar.split(',').map((s) => s.trim()).filter(Boolean);
}

function checkShellPolicy(command: string): { allowed: boolean; reason?: string } {
  const allowlistStr = process.env.TRIMC_SHELL_ALLOWLIST;
  const denylistStr = process.env.TRIMC_SHELL_DENYLIST;

  const allowlist = allowlistStr ? parsePolicyList(allowlistStr) : DEFAULT_ALLOWLIST;
  const denylist = denylistStr ? parsePolicyList(denylistStr) : DEFAULT_DENYLIST;

  const cmdLower = command.toLowerCase().trim();
  const baseCmd = cmdLower.split(/\s+/)[0];

  // 1. Denylist check (exact or pattern match)
  for (const blocked of denylist) {
    if (cmdLower === blocked || cmdLower.startsWith(blocked + ' ')) {
      return { allowed: false, reason: `blocked by denylist: "${blocked}"` };
    }
  }

  // 2. Allowlist check (base command match)
  const inAllowlist = allowlist.some(
    (allowed) => baseCmd === allowed || baseCmd.endsWith(`\\${allowed}`) || baseCmd.endsWith(`/${allowed}`)
  );

  if (!inAllowlist) {
    return { allowed: false, reason: `command "${baseCmd}" not in allowlist` };
  }

  return { allowed: true };
}

register(
  {
    type: 'function',
    function: {
      name: 'shell_exec',
      description:
        'Execute a shell command and return stdout+stderr. Commands are validated against a security policy (allowlist/denylist). Capped at 30s timeout.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory for the command.' },
        },
        required: ['command'],
      },
    },
  },
  async (args, ctx?: ToolContext) => {
    const command = args.command as string;
    // REQ-014b: model-explicit args.cwd wins (legacy semantics preserved),
    // then the agent loop cwd (ctx.cwd), then the daemon launch dir.
    const cwd = (args.cwd as string) || ctx?.cwd || process.cwd();
    if (!command) return JSON.stringify({ error: 'command is required' });

    // ── Policy gate check ──
    const policy = checkShellPolicy(command);
    if (!policy.allowed) {
      return JSON.stringify({ error: policy.reason, command: command.slice(0, 200) });
    }

    try {
      const isWindows = platform() === 'win32';
      const argv = isWindows ? ['cmd', '/c', command] : ['sh', '-c', command];
      const run = await shellSupervisor.spawn({
        argv,
        cwd,
        timeoutMs: 30_000,
        captureOutput: true,
      });
      const result = await run.wait();
      return JSON.stringify({
        stdout: result.stdout.slice(0, 50_000),
        stderr: result.stderr.slice(0, 10_000),
        exit_code: result.exitCode ?? 0,
      });
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return JSON.stringify({
        stdout: (execErr.stdout || '').slice(0, 50_000),
        stderr: (execErr.stderr || execErr.message || '').slice(0, 10_000),
        exit_code: execErr.code ?? 1,
      });
    }
  },
);

// ── Tool: glob_search ──

register(
  {
    type: 'function',
    function: {
      name: 'glob_search',
      description: 'Search for files matching a glob pattern in a directory.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match (e.g. **/*.ts).' },
          path: { type: 'string', description: 'Directory to search in (defaults to cwd).' },
        },
        required: ['pattern'],
      },
    },
  },
  async (args, ctx?: ToolContext) => {
    const pattern = args.pattern as string;
    // REQ-014b: resolve relative paths against the agent loop cwd (ctx.cwd),
    // not the daemon launch dir. ctx is absent in legacy call sites → fall
    // back to process.cwd() (unchanged legacy behavior).
    const base = ctx?.cwd ?? process.cwd();
    const basePath = (args.path as string) || base;
    if (!pattern) return JSON.stringify({ error: 'pattern is required' });

    const results: string[] = [];
    const parts = pattern.replace(/\\/g, '/').split('/');

    function walk(dir: string, partIndex: number) {
      if (partIndex >= parts.length) return;
      const part = parts[partIndex];

      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (part === '**') {
            if (partIndex === parts.length - 1) {
              results.push(relative(basePath, resolve(dir, entry.name)));
            } else {
              const nextPart = parts[partIndex + 1];
              if (entry.name === nextPart || nextPart === '*') {
                walk(resolve(dir, entry.name), partIndex + 2);
              }
            }
            if (entry.isDirectory()) {
              walk(resolve(dir, entry.name), partIndex);
            }
          } else if (part === '*') {
            if (partIndex === parts.length - 1) {
              results.push(relative(basePath, resolve(dir, entry.name)));
            } else if (entry.isDirectory() && entry.name === parts[partIndex + 1]) {
              walk(resolve(dir, entry.name), partIndex + 2);
            }
          } else if (entry.name === part) {
            if (partIndex === parts.length - 1) {
              results.push(relative(basePath, resolve(dir, entry.name)));
            } else if (entry.isDirectory()) {
              walk(resolve(dir, entry.name), partIndex + 1);
            }
          }
        }
      } catch {
        // Directory doesn't exist — no results
      }
    }

    walk(basePath, 0);
    return JSON.stringify({ pattern, base: basePath, matches: results.slice(0, 200) });
  },
);

// ── Tool: task (sub-agent dispatch) ──
// P3T1: Integrated with sub-agent spawn system (AgentDefinition + tools resolve + permission inherit).

import { spawnAgent, type AgentType } from './sub-agent/index.js';

const SUBAGENT_TYPE_MAP: Record<string, AgentType> = {
  explore: 'explore',
  explorer: 'explore',
  plan: 'plan',
  planner: 'plan',
  verify: 'verification',
  verification: 'verification',
  general: 'general-purpose',
  'general-purpose': 'general-purpose',
  code: 'general-purpose',
};

function resolveAgentType(hint: string | undefined): AgentType {
  if (!hint) return 'general-purpose';
  const key = hint.toLowerCase().trim();
  return SUBAGENT_TYPE_MAP[key] ?? 'general-purpose';
}

register(
  {
    type: 'function',
    function: {
      name: 'task',
      description:
        'Launch a sub-agent to handle a complex multi-step task autonomously. Available agent types: general-purpose (full subagent tools, default), explore (read-only code search), plan (read-only analysis + step-by-step planning), verification (test/build validation, returns PASS/FAIL/PARTIAL). Sub-agents run at subagent tier (no task tool to prevent recursion).',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short description of the task (3-5 words).' },
          prompt: { type: 'string', description: 'The full task description for the sub-agent.' },
          subagent_type: { type: 'string', description: 'Agent type: "explore" (read-only search), "plan" (step-by-step planning), "verification" (test/build check), "general-purpose" (default, full tools).' },
        },
        required: ['description', 'prompt'],
      },
    },
  },
  async (args, ctx?: ToolContext) => {
    const description = args.description as string;
    const prompt = args.prompt as string;
    if (!description || !prompt) {
      return JSON.stringify({ error: 'description and prompt are required' });
    }

    const agentType = resolveAgentType(args.subagent_type as string | undefined);
    let collectedContent = '';

    try {
      for await (const event of spawnAgent({
        agentType,
        prompt,
        description,
        // REQ-014b: sub-agents inherit the parent loop cwd (ctx.cwd).
        cwd: ctx?.cwd ?? process.cwd(),
      })) {
        if (event.type === 'subagent_delta') {
          collectedContent += event.delta;
        }
        if (event.type === 'subagent_error') {
          return JSON.stringify({
            ok: false,
            description,
            agent_type: agentType,
            error: event.error,
          });
        }
        if (event.type === 'subagent_done') {
          const result = event.result;
          return JSON.stringify({
            ok: !result.error,
            description: result.description,
            agent_type: result.agentType,
            agent_id: result.agentId,
            tool_calls_made: result.toolCallsMade,
            turns_executed: result.turnsExecuted,
            finish_reason: result.finishReason,
            content: collectedContent || result.content || '(no output)',
            error: result.error ?? undefined,
          });
        }
      }

      return JSON.stringify({
        ok: true,
        description,
        agent_type: agentType,
        content: collectedContent || '(no output)',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        ok: false,
        error: `sub-agent failed: ${msg}`,
        description,
        agent_type: agentType,
      });
    }
  },
);
