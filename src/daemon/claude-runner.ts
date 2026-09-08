// ── LG-033 b 直上窗 1 件②：claude 进程封装（headless stream-json 流形态）──
// -p --input-format stream-json --output-format stream-json 长驻；cwd 钉
// /srv/fleet/TriMetaverse；env 注入位（duty-env .trimmc 路径对齐由调用方展开）；
// 台账钩子（换棒/工具调用审计接口预留）。
// 底座=ManagedProcessSupervisor（窗 1 件①：全旗标重传/重启退避/pause-resume）。
// 测试形态：binaryPath 参数化——echo 替身脚本（stream-json 往返）替代真 claude。

import { createInterface } from 'node:readline';
import { ManagedProcessSupervisor, type SupervisorSpawnConfig } from './supervisor.js';

export interface ClaudeRunnerOptions {
  /** claude 可执行路径（默认 'claude'；测试传 echo 替身脚本）。 */
  binaryPath?: string;
  /** 全旗标集合（--settings/crossSessionInbound 等——每次 spawn 全量重传）。 */
  args: string[];
  /** headless 形态旗标（默认 -p + 双向 stream-json；测试替身传 [] 免旗标毒害）。 */
  headlessArgs?: string[];
  /** 工作目录钉死（默认 /srv/fleet/TriMetaverse）。 */
  cwd?: string;
  /** duty-env 注入位（.trimmc 展开后的 env 键值）。 */
  env?: Record<string, string>;
  maxRestarts?: number;
}

/** stream-json 单行消息形态（user/assistant/system 事件族）。 */
export interface StreamJsonMessage {
  type: string;
  [key: string]: unknown;
}

/** 台账钩子接口（预留：换棒/工具调用审计——窗 2 接 token_stats/审计面）。 */
export interface ClaudeRunnerHooks {
  onToolUse?: (info: { tool: string; at: number }) => void;
  onRelay?: (info: { note: string; at: number }) => void;
  onSystemEvent?: (info: { subtype: string; at: number }) => void;
}

export class ClaudeSessionRunner {
  private supervisor: ManagedProcessSupervisor;
  private hooks: ClaudeRunnerHooks = {};
  private lineBuffer = '';

  constructor(options: ClaudeRunnerOptions) {
    const spawnConfig: SupervisorSpawnConfig = {
      binaryPath: options.binaryPath ?? 'claude',
      // headless stream-json 长驻形态（-p + 双向流；headlessArgs 可参数化供测试替身）
      args: [
        ...(options.headlessArgs ?? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']),
        ...options.args,
      ],
      cwd: options.cwd ?? '/srv/fleet/TriMetaverse',
      env: options.env,
      maxRestarts: options.maxRestarts,
    };
    this.supervisor = new ManagedProcessSupervisor(spawnConfig);
    this.supervisor.on('state', (s) => {
      if (s === 'running') this.attachLineReader();
    });
  }

  setHooks(hooks: ClaudeRunnerHooks): void {
    this.hooks = { ...hooks };
  }

  /** 台账/监控委托面（pause/resume/状态——rev2 ④ 协议位）。 */
  get supervisorApi(): {
    start: () => void; pause: () => void; resume: () => void; stop: () => void;
    getState: () => string; getRestarts: () => number; isAlive: () => boolean; getPid: () => number | null;
  } {
    return {
      start: () => this.supervisor.start(),
      pause: () => this.supervisor.pause(),
      resume: () => this.supervisor.resume(),
      stop: () => this.supervisor.stop(),
      getState: () => this.supervisor.getState(),
      getRestarts: () => this.supervisor.getRestarts(),
      isAlive: () => this.supervisor.isAlive(),
      getPid: () => this.supervisor.getPid(),
    };
  }

  /** 写一行 stream-json 到 claude stdin（user message 等输入事件）。 */
  sendLine(obj: StreamJsonMessage): boolean {
    const child = (this.supervisor as unknown as { child: { stdin: { write: (d: string) => boolean } | null } | null }).child;
    if (!child?.stdin) return false;
    return child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** stdout JSON 行解析→事件分发（tool_use/system/relay note 钩子位）。 */
  private attachLineReader(): void {
    const child = (this.supervisor as unknown as { child: { stdout: import('node:stream').Readable | null } | null }).child;
    if (!child?.stdout) return;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: StreamJsonMessage;
      try {
        msg = JSON.parse(trimmed) as StreamJsonMessage;
      } catch {
        return; // 非 JSON 行（CLI 杂音）忽略
      }
      this.dispatchMessage(msg);
    });
  }

  /** 事件分发（台账钩子预留位）。 */
  protected dispatchMessage(msg: StreamJsonMessage): void {
    const at = Date.now();
    if (msg.type === 'assistant') {
      const content = (msg as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content;
      for (const block of content ?? []) {
        if (block.type === 'tool_use' && block.name) this.hooks.onToolUse?.({ tool: block.name, at });
      }
    }
    if (msg.type === 'system') {
      const subtype = String((msg as { subtype?: string }).subtype ?? '');
      this.hooks.onSystemEvent?.({ subtype, at });
    }
    const note = (msg as { relayNote?: string }).relayNote;
    if (typeof note === 'string') this.hooks.onRelay?.({ note, at });
  }

  /** 原始行监听（测试 echo 往返断言用）。 */
  onLine(listener: (msg: StreamJsonMessage) => void): void {
    const child = (this.supervisor as unknown as { child: { stdout: import('node:stream').Readable | null } | null }).child;
    if (!child?.stdout) return;
    createInterface({ input: child.stdout }).on('line', (line) => {
      try { listener(JSON.parse(line.trim()) as StreamJsonMessage); } catch { /* 杂音 */ }
    });
  }
}
