import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;

describe('TriMMC chat endpoint', () => {
  let port: number;
  let serverUrl: string;
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };

  before(async () => {
    // Set required env for provider registration
    process.env.DEEPSEEK_API_KEY = 'sk-test-mock-key';
    
    // Mock DeepSeek API responses
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      // Pass through to local server
      if (url.includes('127.0.0.1')) {
        return originalFetch(input, init);
      }

      // Mock DeepSeek API
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const model = body.model ?? 'deepseek-chat';

      return new Response(JSON.stringify({
        id: `chatcmpl-${model}-mock`,
        model,
        choices: [{
          message: { role: 'assistant', content: `Mock response from ${model}` },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
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

  it('GET /healthz returns ok', async () => {
    const res = await fetch(`${serverUrl}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'trimc');
  });

  it('POST /internal/v1/chat with valid request returns response', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'Say hello in one word' }],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, 'deepseek-chat');
    assert.ok(typeof body.content === 'string');
    assert.ok(body.content.length > 0);
    assert.ok(body.id);
  });

  it('POST /internal/v1/chat with unknown model returns 422', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'definitely-unknown-model-xyz',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'unknown_model');
    assert.ok(body.available);
  });

  it('POST /internal/v1/chat with invalid body returns 400', async () => {
    const res = await fetch(`${serverUrl}/internal/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_json');
  });
});
