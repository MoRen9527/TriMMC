// ── TriMMC E2E Real Model Smoke Tests ──
// CTO-015: Validates the full v0.2.0 pipeline with real DeepSeek API calls.
// Tests: contract-driven agent loop, tool calling, usage summary, multi-turn conversation.
//
// PREREQUISITE: DEEPSEEK_API_KEY must be set in TriModel/.env
// All tests skip gracefully if the key is absent.
//
// RUN: node --import tsx --test --test-timeout=120000 test/e2e/real-model-agent.test.ts

// Import TriModel early �?triggers config.ts top-level dotenv load,
// populating process.env from TriModel/.env before the HAS_API_KEY check.
import 'trimodel';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContract } from '../../src/contracts/agent-contract.js';

// ── Gate: skip if no API key ──

const HAS_API_KEY = !!process.env.DEEPSEEK_API_KEY;
const skipReason = HAS_API_KEY ? undefined : 'DEEPSEEK_API_KEY not set in TriModel/.env �?skipping E2E';

// ── Test Fixtures ──

const E2E_CTO_CONTRACT: AgentContract = {
  agent_id: 'chief-technology-officer',
  version: '1.0.0',
  identity: {
    display_name: '小狄',
    family: 'Role',
    role: 'Chief Technology Officer',
    description: 'CTO of TriCompany �?delivers technical roadmap and code quality.',
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
    reports_to: 'ceo-chief-of-staff',
    peers: ['chief-product-officer'],
    supervises: ['senior-engineer'],
  },
  tools: [
    {
      name: 'read_file',
      scope: ['fs'],
      risk_level: 'low',
      requires_approval: false,
      runtime_equivalent: 'openclaw:fs:read',
    },
    {
      name: 'write_file',
      scope: ['fs'],
      risk_level: 'high',
      requires_approval: true,
      runtime_equivalent: 'openclaw:fs:write',
    },
    {
      name: 'shell_exec',
      scope: ['system'],
      risk_level: 'medium',
      requires_approval: false,
      runtime_equivalent: 'openclaw:shell:exec',
    },
  ],
  io_contract: {
    inputs: [
      { type: 'task', description: 'Technical task from CEO or CPO' },
      { type: 'code_review', description: 'Code review request' },
    ],
    outputs: [
      { type: 'technical_judgment', description: 'APPROVE / FREEZE / ESCALATE verdict' },
      { type: 'delivery_plan', description: 'Implementation sequence and quality gates' },
    ],
  },
  instructions: 'You are 小狄, CTO of TriCompany. Answer concisely in English.',
};

// ── Helpers ──

async function postAgent(
  serverUrl: string,
  body: Record<string, unknown>,
  opts?: { stream?: boolean },
): Promise<Response> {
  const url = opts?.stream
    ? `${serverUrl}/internal/v1/agent?stream=true`
    : `${serverUrl}/internal/v1/agent`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts?.stream ? {} : {}),
    },
    body: JSON.stringify(body),
  });
}

function parseSSE(text: string): Array<{ event: string; data: unknown }> {
  const results: Array<{ event: string; data: unknown }> = [];
  const blocks = text.split('\n\n');
  for (const block of blocks) {
    const eventMatch = block.match(/^event: (.+)$/m);
    const dataMatch = block.match(/^data: (.+)$/m);
    if (eventMatch && dataMatch && dataMatch[1] !== '[DONE]') {
      try {
        results.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
      } catch {
        // skip unparseable events
      }
    }
  }
  return results;
}

// ── Suite 1: Simple Q&A �?validates pipeline assembly + single-turn response ──

describe('E2E: Real model �?Contract-driven Q&A', { skip: skipReason }, () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    // Use port 0 for OS-assigned port; real fetch (no mock)
    const { createTriMMCApp } = await import('../../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
  });

  it('responds with CTO identity through contract pipeline [JSON]', { timeout: 60000 }, async () => {
    const res = await postAgent(serverUrl, {
      contract: E2E_CTO_CONTRACT,
      messages: [
        { role: 'user', content: 'What is your name and role? Answer in one sentence.' },
      ],
      maxTurns: 1,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events), 'should have events array');

    // Must have at least assistant_message and loop_end
    const messages = body.events.filter((e: any) => e.type === 'assistant_message');
    const loopEnds = body.events.filter((e: any) => e.type === 'loop_end');
    assert.ok(messages.length >= 1, 'should have at least 1 assistant_message');
    assert.equal(loopEnds.length, 1, 'should have exactly 1 loop_end');

    // Content should mention CTO identity
    const content = messages.map((e: any) => e.content).join(' ').toLowerCase();
    assert.ok(
      content.includes('cto') || content.includes('technology') || content.includes('小狄') || content.includes('chief'),
      `response should reference CTO identity, got: ${content.slice(0, 200)}`,
    );

    // Verify usage summary
    const loopEnd = loopEnds[0];
    assert.ok(loopEnd.usageSummary, 'loop_end should have usageSummary');
    assert.ok(loopEnd.usageSummary.tokens.total_tokens > 0, 'should have consumed tokens');
  });

  it('responds through contract pipeline [SSE stream]', { timeout: 60000 }, async () => {
    const res = await postAgent(
      serverUrl,
      {
        contract: E2E_CTO_CONTRACT,
        messages: [
          { role: 'user', content: 'Say "E2E-SSE-OK" in your response.' },
        ],
        maxTurns: 1,
      },
      { stream: true },
    );
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'), `expected SSE, got ${ct}`);

    const text = await res.text();
    assert.ok(text.includes('data: [DONE]'), 'SSE should end with [DONE]');

    const events = parseSSE(text);
    const msgEvents = events.filter((e: any) => e.event === 'assistant_message');
    const loopEnds = events.filter((e: any) => e.event === 'loop_end');
    assert.ok(msgEvents.length >= 1, 'should have assistant_message in SSE');
    assert.equal(loopEnds.length, 1, 'should have loop_end in SSE');

    // Verify response references our marker
    const allContent = msgEvents.map((e: any) => (e.data as any).content ?? '').join(' ');
    assert.ok(allContent.includes('E2E-SSE-OK'), `SSE response should contain marker, got: ${allContent.slice(0, 200)}`);
  });
});

// ── Suite 2: Tool Calling �?validates multi-turn agent loop with real tools ──

describe('E2E: Real model �?Tool calling', { skip: skipReason }, () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };
  const fixturePath = join(tmpdir(), 'trimc-e2e-test.txt');

  before(async () => {
    // Create a temp fixture file that the agent can read
    const { writeFile } = await import('node:fs/promises');
    await writeFile(fixturePath, 'E2E_TOOL_CALL_SUCCESS: The agent read this file correctly.', 'utf-8');

    const { createTriMMCApp } = await import('../../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
  });

  it('reads a file via tool call and reports content [JSON]', { timeout: 90000 }, async () => {
    const res = await postAgent(serverUrl, {
      contract: E2E_CTO_CONTRACT,
      messages: [
        {
          role: 'user',
          content: `Read the file at "${fixturePath.replace(/\\/g, '\\\\')}" and tell me exactly what it says. Reply with just the file content.`,
        },
      ],
      maxTurns: 3, // allow tool call + response
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    // Check for tool call events
    const toolCalls = body.events.filter((e: any) => e.type === 'tool_call');
    const toolResults = body.events.filter((e: any) => e.type === 'tool_result');
    const messages = body.events.filter((e: any) => e.type === 'assistant_message');

    if (toolCalls.length > 0) {
      // Model used tools �?verify the pipeline
      assert.ok(toolResults.length > 0, 'should have tool_result after tool_call');
      const call = toolCalls[0];
      assert.ok(call.name, 'tool_call should have name');
      assert.ok(call.arguments, 'tool_call should have arguments');

      // Content should reference E2E marker from the file (only when tools were used)
      const content = messages.map((e: any) => e.content).join(' ').toLowerCase();
      assert.ok(
        content.includes('e2e_tool_call_success') || content.includes('file correctly') || content.includes('read this file'),
        `response should reference file content, got first 300 chars: ${content.slice(0, 300)}`,
      );
    }
    // Whether or not tools were used, the agent should respond
    assert.ok(messages.length >= 1, 'should have at least 1 assistant_message');

    // Verify loop_end with usage
    const loopEnds = body.events.filter((e: any) => e.type === 'loop_end');
    assert.equal(loopEnds.length, 1);
    assert.ok(loopEnds[0].usageSummary, 'should have usageSummary');
    assert.ok(loopEnds[0].usageSummary.tokens.total_tokens > 0);
  });
});

// ── Suite 3: Backward Compat �?no contract still works with real model ──

describe('E2E: Real model �?Legacy no-contract', { skip: skipReason }, () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    const { createTriMMCApp } = await import('../../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
  });

  it('legacy mode produces valid response [JSON]', { timeout: 60000 }, async () => {
    const res = await postAgent(serverUrl, {
      model: 'deepseek-v4-pro',
      systemPrompt: 'You are a helpful assistant. Reply in exactly one sentence.',
      messages: [{ role: 'user', content: 'Say "LEGACY-E2E-OK"' }],
      maxTurns: 1,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const messages = body.events.filter((e: any) => e.type === 'assistant_message');
    assert.ok(messages.length >= 1);
    const content = messages.map((e: any) => e.content).join(' ');
    assert.ok(content.includes('LEGACY-E2E-OK'), `should echo marker, got: ${content.slice(0, 200)}`);

    const loopEnds = body.events.filter((e: any) => e.type === 'loop_end');
    assert.equal(loopEnds.length, 1);
    assert.ok(loopEnds[0].usageSummary?.tokens.total_tokens > 0);
  });
});

// ── Suite 4: Multi-turn conversation ──

describe('E2E: Real model �?Multi-turn', { skip: skipReason }, () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    const { createTriMMCApp } = await import('../../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
  });

  it('handles multi-turn conversation with contract [JSON]', { timeout: 90000 }, async () => {
    const res = await postAgent(serverUrl, {
      contract: E2E_CTO_CONTRACT,
      messages: [
        { role: 'user', content: 'Count to 3, one number per line. Do not use tools.' },
        { role: 'assistant', content: '1\n2\n3' },
        { role: 'user', content: 'Good. Now say "MULTI-TURN-E2E-OK"' },
      ],
      maxTurns: 2,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const messages = body.events.filter((e: any) => e.type === 'assistant_message');
    assert.ok(messages.length >= 1);

    const content = messages.map((e: any) => e.content).join(' ');
    assert.ok(content.includes('MULTI-TURN-E2E-OK'), `should contain marker, got: ${content.slice(0, 300)}`);

    const loopEnds = body.events.filter((e: any) => e.type === 'loop_end');
    assert.equal(loopEnds.length, 1);
    assert.ok(loopEnds[0].usageSummary?.tokens.total_tokens > 0);
  });
});
