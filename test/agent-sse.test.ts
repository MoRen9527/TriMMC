import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

describe('TriMMC agent SSE endpoint', () => {
  let port: number;
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';

    // Mock DeepSeek API — return a simple text response (no tool calls)
    // so the agent loop completes in one turn
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      // Pass through to local server
      if (url.includes('127.0.0.1')) {
        return originalFetch(input, init);
      }

      // Check if the request contains tool definitions (agent mode)
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const hasTools = body.tools && body.tools.length > 0;

      return new Response(JSON.stringify({
        id: 'chatcmpl-agent-mock',
        model: body.model ?? 'deepseek-v4-pro',
        choices: [{
          message: {
            role: 'assistant',
            content: hasTools
              ? 'Hello! I see you have given me tools to use.' // simple response, no tool calls
              : `Mock response from ${body.model}`,
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const { createTriMMCApp } = await import('../src/server/app.js');
    // Use port 0 to let the OS assign a free port
    app = createTriMMCApp({ port: 0 } as never);
    await app.start();
    port = app.port;
    serverUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await app.stop();
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
  });

  it('POST /internal/v1/agent?stream=true returns SSE stream', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Say hello briefly.' }],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));

    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);

    // Should have at least event:data pairs plus [DONE]
    assert.ok(lines.length >= 2, `Expected at least 2 lines, got ${lines.length}`);

    // Parse SSE events
    let currentEvent: string | null = null;
    const events: Array<{ event: string; data: unknown }> = [];

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7);
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6);
        if (currentEvent && dataStr !== '[DONE]') {
          events.push({ event: currentEvent, data: JSON.parse(dataStr) });
        }
        currentEvent = null;
      }
    }

    // Verify expected events
    const eventTypes = events.map((e) => e.event);
    assert.ok(eventTypes.includes('loop_start'), 'Missing loop_start event');
    assert.ok(eventTypes.includes('request_start'), 'Missing request_start event');
    assert.ok(eventTypes.includes('assistant_message'), 'Missing assistant_message event');
    assert.ok(eventTypes.includes('loop_end'), 'Missing loop_end event');

    // Verify loop_end reason
    const loopEnd = events.find((e) => e.event === 'loop_end');
    assert.ok(loopEnd);
    assert.equal((loopEnd!.data as Record<string, unknown>).reason, 'done');

    // Verify [DONE] marker
    assert.ok(text.includes('data: [DONE]'));
  });

  it('POST /internal/v1/agent with Accept: text/event-stream uses SSE', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    const text = await res.text();
    assert.ok(text.includes('data: [DONE]'));
  });

  it('POST /internal/v1/agent without stream param returns JSON (backward compat)', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length > 0);

    const eventTypes = body.events.map((e: { type: string }) => e.type);
    assert.ok(eventTypes.includes('loop_start'));
    assert.ok(eventTypes.includes('assistant_message'));
    assert.ok(eventTypes.includes('loop_end'));
  });
});
