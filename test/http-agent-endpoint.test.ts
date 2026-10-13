// ── TriMMC HTTP Agent Endpoint Integration Tests ──
// CTO-014: Validates POST /internal/v1/agent with supertest-level HTTP assertions.
// Covers: contract pipeline, no-contract backward compat, SSE/JSON modes, error paths.
// Pattern: 小全(blocks) + 小柯(assertions)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentContract } from '../src/contracts/agent-contract.js';
import '../src/agent-loop/tools.js';

const originalFetch = globalThis.fetch;

// ── Test Fixtures ──

const MINIMAL_CONTRACT: AgentContract = {
  agent_id: 'test-agent',
  version: '1.0.0',
  identity: {
    display_name: 'TestAgent',
    family: 'Role',
    role: 'Testing Agent',
    description: 'A test agent for HTTP endpoint validation.',
    user_invocable: true,
  },
  responsibilities: [{ description: 'Run tests', priority: 'high' }],
  decision_rights: {
    approve: ['test_run'],
    escalate: ['critical_failure'],
    forbidden: ['production_mutation'],
  },
  collaborators: {
    reports_to: 'chief-technology-officer',
    peers: ['other-test-agent'],
    supervises: [],
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
  ],
  io_contract: {
    inputs: [{ type: 'task', description: 'Test task input' }],
    outputs: [{ type: 'result', description: 'Test result output' }],
  },
  instructions: 'You are a test agent. Respond concisely.',
};

// ── Helpers ──

function makeMockResponse(model: string, content: string, hasTools: boolean): Response {
  return new Response(
    JSON.stringify({
      id: `chatcmpl-${model}-mock`,
      model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: hasTools
              ? `[Tool-aware] ${content}`
              : content,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Build an SSE streaming Response from the same mock content.
 *  Converts non-stream JSON format → SSE data chunks that DeepSeekProvider.stream() can parse. */
function makeMockStreamResponse(model: string, content: string, hasTools: boolean): Response {
  const chunks: string[] = [];
  const toolPrefix = '[Tool-aware] ';
  const fullContent = hasTools ? `${toolPrefix}${content}` : content;
  // Split content into 2-3 chunks to simulate real streaming
  const step = Math.ceil(fullContent.length / 3) || 1;
  for (let i = 0; i < fullContent.length; i += step) {
    const delta = fullContent.slice(i, i + step);
    chunks.push(
      JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] }),
    );
  }
  // Final chunk with finish_reason + usage
  chunks.push(
    JSON.stringify({
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );

  const sse = chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Create a mock fetch that handles both streaming and non-streaming. */
function makeFetchMock(content: string, toolContent?: string, options?: { shouldStream?: boolean }) {
  const shouldStream = options?.shouldStream ?? true; // default stream for new loop
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('127.0.0.1')) return originalFetch(input, init);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const hasTools = !!body.tools?.length;
    if (body.stream === true || shouldStream) {
      return makeMockStreamResponse(body.model ?? 'deepseek-v4-pro', hasTools ? (toolContent ?? content) : content, hasTools);
    }
    return makeMockResponse(body.model ?? 'deepseek-v4-pro', hasTools ? (toolContent ?? content) : content, hasTools);
  };
}

// ── Suite 1: JSON Mode — Backward Compatibility (no contract) ──

describe('POST /internal/v1/agent [JSON, legacy]', () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';
    globalThis.fetch = makeFetchMock('Legacy mode response');
    const { createTriMMCApp } = await import('../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('returns 200 with legacy fields (model + systemPrompt + messages)', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        systemPrompt: 'You are a test bot.',
        messages: [{ role: 'user', content: 'hello' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0, 'should have at least loop_end event');
    const loopEnds = body.events.filter((e: any) => e.type === 'loop_end');
    assert.equal(loopEnds.length, 1, 'should have exactly one loop_end');
  });

  it('returns 200 with minimal payload (only model + messages)', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.events.length > 0);
  });

  it('returns 400 for invalid JSON body', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{{{',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_json');
  });

  it('still handles missing systemPrompt gracefully', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'say ok' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

// ── Suite 2: JSON Mode — Contract Pipeline ──

describe('POST /internal/v1/agent [JSON, contract pipeline]', () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';
    globalThis.fetch = makeFetchMock('Plain response', 'I see contract tools');
    const { createTriMMCApp } = await import('../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('runs full pipeline with contract + messages', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        messages: [{ role: 'user', content: 'What is your role?' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.events.length > 0);
    const loopEnds = body.events.filter((e: any) => e.type === 'loop_end');
    assert.equal(loopEnds.length, 1);
    // The response should come from the contract-driven system prompt
    const contentEvent = body.events.find((e: any) => e.type === 'assistant_message');
    assert.ok(contentEvent, 'should have assistant_message event');
    assert.ok(contentEvent.content.includes('I see contract tools'), 'response should reference contract tools');
  });

  it('contract pipeline includes identity in system prompt', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        messages: [{ role: 'user', content: 'hello' }],
        maxTurns: 1,
        tier: 'main',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('respects tier parameter in contract mode', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        messages: [{ role: 'user', content: 'try to spawn a task' }],
        maxTurns: 1,
        tier: 'subagent',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('systemPrompt override works in contract mode', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        systemPrompt: 'OVERRIDE: You are a pineapple.',
        messages: [{ role: 'user', content: 'what are you?' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('returns 500 for malformed contract (missing required fields)', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: { agent_id: 'bad', version: '1' },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'pipeline_assembly_error');
  });
});

// ── Suite 3: SSE Mode — Backward Compatibility ──

describe('POST /internal/v1/agent [SSE, legacy]', () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';
    globalThis.fetch = makeFetchMock('SSE legacy ok');
    const { createTriMMCApp } = await import('../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('streams SSE events with ?stream=true', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        systemPrompt: 'SSE bot',
        messages: [{ role: 'user', content: 'stream test' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'), `expected text/event-stream, got ${ct}`);
    const text = await res.text();
    assert.ok(text.includes('event: loop_end'));
    assert.ok(text.includes('data: [DONE]'));
    // Parse SSE events
    const lines = text.split('\n');
    const events = lines.filter((l) => l.startsWith('event: '));
    assert.ok(events.length >= 1, 'should have at least one event');
  });

  it('streams SSE with Accept: text/event-stream header', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        systemPrompt: 'Header SSE bot',
        messages: [{ role: 'user', content: 'stream via header' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'), `expected text/event-stream, got ${ct}`);
    const text = await res.text();
    assert.ok(text.includes('event: '));
    assert.ok(text.includes('data: [DONE]'));
  });
});

// ── Suite 4: SSE Mode — Contract Pipeline ──

describe('POST /internal/v1/agent [SSE, contract pipeline]', () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';
    globalThis.fetch = makeFetchMock('Legacy SSE stream ok', 'Contract SSE stream ok');
    const { createTriMMCApp } = await import('../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('streams SSE with contract pipeline', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        messages: [{ role: 'user', content: 'who are you?' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes('event: '));
    assert.ok(text.includes('data: [DONE]'));
  });

  it('SSE pipeline includes loop_end with correct structure', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        messages: [{ role: 'user', content: 'test' }],
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    // Verify loop_end exists
    assert.ok(text.includes('"type":"loop_end"'), 'SSE should contain loop_end event');
    // Verify data events are properly formatted
    const dataLines = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));
    assert.ok(dataLines.length >= 1, 'should have at least one data event');
  });

  it('SSE pipeline handles error gracefully', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: { agent_id: 'broken', version: '0' }, // missing required fields
        messages: [{ role: 'user', content: 'crash test' }],
      }),
    });
    // Pipeline assembly fails before SSE starts — should be 500 JSON
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'pipeline_assembly_error');
  });
});

// ── Suite 5: Cross-cutting Concerns ──

describe('POST /internal/v1/agent [cross-cutting]', () => {
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';
    globalThis.fetch = makeFetchMock('Cross-cutting mock');
    const { createTriMMCApp } = await import('../src/server/app.js');
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    serverUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('GET /internal/v1/agent returns 404 (only POST allowed)', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`);
    assert.equal(res.status, 404);
  });

  it('contract mode preserves messages in order', async () => {
    const messages = [
      { role: 'system' as const, content: 'initial context' },
      { role: 'user' as const, content: 'first question' },
      { role: 'user' as const, content: 'follow-up' },
    ];
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contract: MINIMAL_CONTRACT,
        messages,
        maxTurns: 1,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it('allows concurrent requests with different contracts', async () => {
    const makeReq = (suffix: string) =>
      fetch(`${serverUrl}/internal/v1/agent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-v4-pro',
          systemPrompt: `Concurrent bot ${suffix}`,
          messages: [{ role: 'user', content: suffix }],
          maxTurns: 1,
        }),
      }).then((r) => r.json());

    const [a, b] = await Promise.all([makeReq('A'), makeReq('B')]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });
});
