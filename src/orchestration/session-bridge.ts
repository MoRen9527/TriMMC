// ── Session Bridge (M1 Phase-2) ──
// TriMMC 编排层 ↔ 官方 claude 会话桥：
//   spawn  → claude --bg -n <employeeId> "<task>"        → agentId
//   list   → claude agents --json                         → 注册表（agentId↔sessionId↔employeeId）
//   send   → claude -p --resume <sessionId> --fork-session "<msg>"  → 回复文本
//
// 降权纪律：triMC 以 root 跑 systemd 时，claude 子进程一律 runuser 到
// fleet 账号（root 下 claude 拒绝 --dangerously-skip-permissions 类权限展开，
// 且舰队会话应归属 fleet 的 ~/.claude 状态）。
// 来源：server-fleet-m0.md §三.7 / CTO M1 Phase-2 方案

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface AgentSession {
  /** 短 id，如 ad45d07b（--bg 返回） */
  agentId: string;
  /** 完整 session id（UUID） */
  sessionId: string;
  /** 会话显示名（= 员工名/员工 id） */
  name: string;
  /** 会话工作目录 */
  cwd: string;
  status: string;
  state: string;
  /** 注册表映射：name → employeeId（加载合同时注入） */
  employeeId?: string;
  lastSeenAt: string;
}

export interface SessionBridgeOptions {
  /** claude 可执行文件，默认 'claude' */
  claudeBin?: string;
  /** 降权账号（如 'fleet'）；不设则以当前用户直接跑（本地开发） */
  runAsUser?: string;
  /** 会话工作目录，默认 /srv/fleet */
  cwd?: string;
  /** claude agents --json 超时，默认 30s */
  agentsJsonTimeoutMs?: number;
  /** 消息桥超时，默认 120s */
  messageTimeoutMs?: number;
  /** spawn 超时，默认 90s */
  spawnTimeoutMs?: number;
}

export interface SpawnResult {
  ok: boolean;
  agentId?: string;
  name?: string;
  error?: string;
}

export interface SendMessageResult {
  ok: boolean;
  reply?: string;
  error?: string;
  timedOut?: boolean;
}

const DEFAULT_OPTIONS: Required<Pick<SessionBridgeOptions, 'claudeBin' | 'cwd' | 'agentsJsonTimeoutMs' | 'messageTimeoutMs' | 'spawnTimeoutMs'>> = {
  claudeBin: 'claude',
  cwd: '/srv/fleet',
  agentsJsonTimeoutMs: 30_000,
  messageTimeoutMs: 120_000,
  spawnTimeoutMs: 90_000,
};

/** 构造降权前缀：runuser -u <user> -- cmd args...；无 runAsUser 时直接执行 */
function buildArgs(
  cmdArgs: string[],
  opts: SessionBridgeOptions & typeof DEFAULT_OPTIONS,
): { bin: string; args: string[] } {
  if (opts.runAsUser) {
    return {
      bin: 'runuser',
      args: ['-u', opts.runAsUser, '--', opts.claudeBin, ...cmdArgs],
    };
  }
  return { bin: opts.claudeBin, args: cmdArgs };
}

/**
 * 启动一个官方 claude 后台会话（命名 = employeeId）。
 * 返回 agent 短 id；会话状态归 fleet 账号的 ~/.claude。
 */
export async function spawnSession(
  employeeId: string,
  task: string,
  opts: SessionBridgeOptions = {},
): Promise<SpawnResult> {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const { bin, args } = buildArgs(
    ['--bg', '-n', employeeId, task],
    o,
  );
  try {
    const { stdout } = await execFileP(bin, args, {
      cwd: o.cwd,
      timeout: o.spawnTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HOME: o.runAsUser ? `/home/${o.runAsUser}` : process.env.HOME },
    });
    const m = /backgrounded\s*[·•]\s*([0-9a-f]+)\s*[·•]\s*(.+)/.exec(stdout.trim());
    if (!m) {
      return { ok: false, error: `unparseable spawn output: ${stdout.trim().slice(0, 200)}` };
    }
    return { ok: true, agentId: m[1], name: m[2].trim() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 500) };
  }
}

/**
 * ListAgents：采集 fleet 账号下全部 claude 会话（含 bg 与历史），
 * 形成 agentId↔sessionId↔name 注册表快照。
 */
export async function listAgents(opts: SessionBridgeOptions = {}): Promise<AgentSession[]> {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const { bin, args } = buildArgs(['agents', '--json'], o);
  try {
    const { stdout } = await execFileP(bin, args, {
      cwd: o.cwd,
      timeout: o.agentsJsonTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HOME: o.runAsUser ? `/home/${o.runAsUser}` : process.env.HOME },
    });
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        agentId: String(r.id ?? ''),
        sessionId: String(r.sessionId ?? r.session_id ?? ''),
        name: String(r.name ?? ''),
        cwd: String(r.cwd ?? ''),
        status: String(r.status ?? ''),
        state: String(r.state ?? ''),
        lastSeenAt: new Date().toISOString(),
      };
    });
  } catch {
    return [];
  }
}

/**
 * SendMessage：向指定会话发消息（--fork-session 副本语义，官方对运行中
 * bg 会话的保护通道），120s 超时回收输出。回复 = stdout 文本。
 */
export async function sendMessage(
  sessionId: string,
  message: string,
  opts: SessionBridgeOptions = {},
): Promise<SendMessageResult> {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  const { bin, args } = buildArgs(
    ['-p', '--resume', sessionId, '--fork-session', message],
    o,
  );
  try {
    const { stdout } = await execFileP(bin, args, {
      cwd: o.cwd,
      timeout: o.messageTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, HOME: o.runAsUser ? `/home/${o.runAsUser}` : process.env.HOME },
    });
    const reply = stdout.trim();
    if (!reply) {
      return { ok: false, error: 'empty reply from session' };
    }
    return { ok: true, reply };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = /ETIMEDOUT|SIGKILL|timeout/i.test(msg);
    return { ok: false, error: msg.slice(0, 500), timedOut };
  }
}

/** 注册表解析：按 name（= employeeId）注入映射，供 /internal/v1/agents 使用 */
export function buildRegistry(sessions: AgentSession[], employeeNames: string[] = []): AgentSession[] {
  const nameSet = new Set(employeeNames);
  return sessions.map((s) => ({
    ...s,
    employeeId: nameSet.has(s.name) ? s.name : undefined,
  }));
}
