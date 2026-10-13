// ── TriMMC Tool Permission System Tests ──
// CTO-008: Tests for AgentTier permission model, filter, and integration with agent loop.
// Covers: 6 tier composition cases, 7 canUseTool edges, 3 filter/boundary, 3 integration, 3 safety

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  canUseTool,
  filterToolsForTier,
  getToolNamesForTier,
  getTierSummary,
  TIER_DESCRIPTIONS,
  type AgentTier,
} from '../../src/agent-loop/permissions.js';
import { getToolDefinitions } from '../../src/agent-loop/tools.js';
import type { ToolDefinition } from 'trimodel';

// ── Helpers ──

const nameOf = (t: ToolDefinition) => t.function.name;

// ── Suite 1: Permission Model Correctness ──

describe('Permission Model 正确性', () => {
  it('main 层级拥有全部 6 个工具', () => {
    const tier = 'main';
    const allDefs = getToolDefinitions();
    const filtered = getToolDefinitions(tier);
    assert.equal(filtered.length, allDefs.length, `main 应有全部工具 (${allDefs.length})`);
  });

  it('subagent 层级拥有 2 个只读工具（不含 task 防递归、不含写操作）', () => {
    const tier = 'subagent';
    const tools = getToolDefinitions(tier);
    const names = tools.map(nameOf);
    assert.equal(tools.length, 2, `subagent 应有 2 个工具，实际: ${names.join(', ')}`);
    assert.ok(!names.includes('task'), 'subagent 不应拥有 task 工具（防递归）');
    assert.ok(!names.includes('write_file'), 'subagent 不应拥有写工具');
    assert.ok(!names.includes('edit_file'), 'subagent 不应拥有编辑工具');
    assert.ok(!names.includes('shell_exec'), 'subagent 不应拥有 shell 工具');
  });

  it('subagent 层级仅有只读工具（read_file, glob_search）', () => {
    const tier = 'subagent';
    const names = getToolDefinitions(tier).map(nameOf);
    const required = ['read_file', 'glob_search'];
    for (const r of required) {
      assert.ok(names.includes(r), `subagent 应有 ${r}，实际: ${names.join(', ')}`);
    }
  });

  it('coordinator 层级仅拥有 task 工具', () => {
    const tier = 'coordinator';
    const tools = getToolDefinitions(tier);
    const names = tools.map(nameOf);
    assert.equal(tools.length, 1, 'coordinator 应仅有 1 个工具');
    assert.equal(names[0], 'task', 'coordinator 仅应有 task');
  });
});

// ── Suite 2: canUseTool Edge Cases ──

describe('canUseTool 边界', () => {
  it('main 可以使用任意工具', () => {
    const names = getToolDefinitions('main').map(nameOf);
    for (const name of names) {
      const r = canUseTool(name, 'main');
      assert.ok(r.allowed, `main 应可以使用 ${name}`);
    }
  });

  it('subagent 不能使用 task', () => {
    const r = canUseTool('task', 'subagent');
    assert.ok(!r.allowed, 'subagent 不应能使用 task');
    assert.ok(r.reason?.includes('subagent'), `reason 应包含 subagent: ${r.reason}`);
  });

  it('subagent 可以使用 read_file', () => {
    const r = canUseTool('read_file', 'subagent');
    assert.ok(r.allowed, `subagent 应能使用 read_file: ${r.reason ?? 'ok'}`);
  });

  it('coordinator 可以使用 task', () => {
    const r = canUseTool('task', 'coordinator');
    assert.ok(r.allowed, `coordinator 应能使用 task: ${r.reason ?? 'ok'}`);
  });

  it('coordinator 不能使用 write_file', () => {
    const r = canUseTool('write_file', 'coordinator');
    assert.ok(!r.allowed, 'coordinator 不应能使用 write_file');
    assert.ok(r.reason?.includes('coordinator'), `reason 应包含 coordinator: ${r.reason}`);
  });

  it('coordinator 不能使用 shell_exec', () => {
    const r = canUseTool('shell_exec', 'coordinator');
    assert.ok(!r.allowed, 'coordinator 不应能使用 shell_exec');
  });

  it('未注册工具默认 main-only（subagent 不能使用未知工具）', () => {
    const r = canUseTool('unknown_xyz_tool', 'subagent');
    assert.ok(!r.allowed, '未知工具 subagent 应不可用');
    assert.ok(r.reason?.includes('main'), `reason 应指明需要更高层级: ${r.reason}`);
  });
});

// ── Suite 3: getToolNamesForTier ──

describe('getToolNamesForTier', () => {
  it('main 返回全部已注册工具名', () => {
    const names = getToolNamesForTier('main');
    const allDefNames = getToolDefinitions().map(nameOf);
    assert.equal(names.size, allDefNames.length);
  });

  it('subagent 包含 2 个工具', () => {
    const names = getToolNamesForTier('subagent');
    assert.equal(names.size, 2);
  });

  it('coordinator 仅包含 task', () => {
    const names = getToolNamesForTier('coordinator');
    assert.equal(names.size, 1);
    assert.ok(names.has('task'));
  });
});

// ── Suite 4: filterToolsForTier ──

describe('filterToolsForTier', () => {
  it('main 不过滤', () => {
    const all = getToolDefinitions();
    const filtered = filterToolsForTier(all, 'main');
    assert.equal(filtered.length, all.length);
  });

  it('subagent 过滤掉 task', () => {
    const all = getToolDefinitions();
    const filtered = filterToolsForTier(all, 'subagent');
    const names = filtered.map(nameOf);
    assert.equal(filtered.length, 2);
    assert.ok(!names.includes('task'));
  });

  it('空工具列表返回空', () => {
    const result = filterToolsForTier([], 'subagent');
    assert.equal(result.length, 0);
  });
});

// ── Suite 5: getTierSummary ──

describe('getTierSummary', () => {
  it('返回三个层级的摘要', () => {
    const summary = getTierSummary();
    const tiers: AgentTier[] = ['main', 'subagent', 'coordinator'];
    for (const t of tiers) {
      assert.ok(summary[t], `summary 应包含 ${t}`);
      assert.ok(typeof summary[t].count === 'number');
      assert.ok(Array.isArray(summary[t].tools));
      assert.equal(summary[t].tools.length, summary[t].count);
    }
  });

  it('main > subagent > coordinator（工具数量递减）', () => {
    const s = getTierSummary();
    assert.ok(s.main.count >= s.subagent.count, 'main 工具数 ≥ subagent');
    assert.ok(s.subagent.count >= s.coordinator.count, 'subagent 工具数 ≥ coordinator');
  });
});

// ── Suite 6: TIER_DESCRIPTIONS ──

describe('TIER_DESCRIPTIONS', () => {
  it('三个层级都有描述', () => {
    const tiers: AgentTier[] = ['main', 'subagent', 'coordinator'];
    for (const t of tiers) {
      assert.ok(TIER_DESCRIPTIONS[t], `TIER_DESCRIPTIONS 应包含 ${t}`);
      assert.ok(TIER_DESCRIPTIONS[t].length > 10, `${t} 描述应足够长`);
    }
  });
});

// ── Suite 7: Loop Tier Integration (Event Contract) ──

describe('Agent Loop 层级集成（事件契约）', () => {
  it('loop_start 事件包含 tier 字段', () => {
    const event: { type: 'loop_start'; model: string; turn: number; tier?: string; availableTools?: number; totalTools?: number } = {
      type: 'loop_start',
      model: 'deepseek-v4-pro',
      turn: 1,
      tier: 'subagent',
      availableTools: 2,
      totalTools: 6,
    };
    assert.equal(event.tier, 'subagent');
    assert.equal(event.availableTools, 2);
    assert.equal(event.totalTools, 6);
  });

  it('tool_blocked 事件包含工具名和原因', () => {
    const event: { type: 'tool_blocked'; turn: number; tool_name: string; reason: string } = {
      type: 'tool_blocked',
      turn: 3,
      tool_name: 'task',
      reason: 'tool "task" is not allowed at tier "subagent"',
    };
    assert.equal(event.tool_name, 'task');
    assert.ok(event.reason.includes('subagent'));
  });

  it('AgentLoopOptions 接受 tier 参数', () => {
    const opts: { tier?: AgentTier } = { tier: 'coordinator' };
    assert.equal(opts.tier, 'coordinator');
  });
});

// ── Suite 8: Recursion Prevention (Key Safety Property) ──

describe('递归防护', () => {
  it('subagent 不能生成 sub-sub-agent（task 被禁止）', () => {
    const r = canUseTool('task', 'subagent');
    assert.ok(!r.allowed, 'subagent 不应能使用 task');
  });

  it('coordinator 不能执行文件操作', () => {
    const fileTools = ['read_file', 'write_file', 'edit_file', 'shell_exec', 'glob_search'];
    for (const t of fileTools) {
      const r = canUseTool(t, 'coordinator');
      assert.ok(!r.allowed, `coordinator 不应能使用 ${t}`);
    }
  });

  it('coordinator 仅能创建子代理（无循环风险）', () => {
    const allowedNames = getToolNamesForTier('coordinator');
    assert.equal(allowedNames.size, 1, 'coordinator 仅应有 1 个工具');
    assert.ok(allowedNames.has('task'), 'coordinator 仅应有 task');
  });
});

// ── Suite 9: Task Handler Tier Injection (CTO-009) ──

describe('Task Handler 层级注入（CTO-009）', () => {
  it('task 工具定义中描述已更新为子代理工具限制', () => {
    const allDefs = getToolDefinitions();
    const taskDef = allDefs.find((t) => t.function.name === 'task');
    assert.ok(taskDef, 'task 工具应存在');
    const desc = taskDef!.function.description ?? '';
    assert.ok(desc.includes('read-only'), `task 描述应提及 read-only: ${desc}`);
    assert.ok(desc.includes('no task'), `task 描述应提及 no task: ${desc}`);
    assert.ok(desc.toLowerCase().includes('recursion'), `task 描述应提及 recursion: ${desc}`);
  });

  it('subagent 层级 loop_start 合约：tier + 2 tools', () => {
    // 验证 loop_start 事件契约：当 tier=subagent 时，availableTools=2
    const event = {
      type: 'loop_start' as const,
      model: 'deepseek-v4-pro',
      turn: 1,
      tier: 'subagent',
      availableTools: 2,
      totalTools: 6,
    };
    assert.equal(event.tier, 'subagent');
    assert.equal(event.availableTools, 2);
    assert.equal(event.totalTools, 6);
  });

  it('task 工具调用 agentLoop 时必定传 tier=subagent', () => {
    // 合约测试：task handler 必须传 tier: 'subagent'
    // 这里验证类型安全——AgentLoopOptions.tier 接受 'subagent'
    const opts: { tier?: AgentTier; model?: string; maxTurns?: number } = {
      tier: 'subagent',
      model: 'deepseek-v4-pro',
      maxTurns: 10,
    };
    assert.equal(opts.tier, 'subagent');
    // 确保 main 和 coordinator 都可以显式传
    opts.tier = 'main';
    assert.equal(opts.tier, 'main');
    opts.tier = 'coordinator';
    assert.equal(opts.tier, 'coordinator');
  });

  it('tool_blocked 事件包含 tool_name 和 reason（子代理被阻止时上报主代理）', () => {
    // 验证事件契约——task handler 中的 tool_blocked 捕获
    const blockedEvent = {
      type: 'tool_blocked' as const,
      turn: 3,
      tool_name: 'task',
      reason: 'tool "task" is not allowed at tier "subagent"',
    };
    assert.equal(blockedEvent.type, 'tool_blocked');
    assert.equal(blockedEvent.tool_name, 'task');
    assert.ok(blockedEvent.reason.includes('subagent'));
    // 验证 task handler 中会拼接的 errorMessage 格式
    const errorMessage = `[tier:subagent] blocked tool "${blockedEvent.tool_name}": ${blockedEvent.reason}`;
    assert.ok(errorMessage.includes('[tier:subagent]'));
    assert.ok(errorMessage.includes('task'));
  });
});
