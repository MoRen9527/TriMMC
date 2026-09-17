// ── LG-036 notify 路由组（挂 /internal/* X-Internal-Token 门内；方案 acaae9fc）──
// 四端点：POST notify（源席入队）/ GET outbox（TriMLC 拉取）/ POST confirm（收端
// 状态确认）/ GET status（源席查询三态）。返回 true=已处理；false=非本组路径。
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  enqueueNotify,
  pullPending,
  queryStatus,
  transitionStatus,
} from './outbox.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleNotifyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<boolean> {
  const path = url.split('?')[0];
  const query = new URL(url, 'http://localhost').searchParams;

  // ── POST /internal/v1/notify（源席入队）──
  if (path === '/internal/v1/notify' && req.method === 'POST') {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json(res, 400, { ok: false, error: 'invalid_json', message: 'Request body must be valid JSON' });
      return true;
    }
    const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const input = {
      source_seat: str('source_seat'),
      target_daemon: str('target_daemon'),
      target_seat: str('target_seat'),
      urgent: str('urgent') === 'urgent' ? 'urgent' as const : str('urgent') === 'normal' ? 'normal' as const : '' as never,
      title: str('title'),
      body: str('body'),
      message_id: str('message_id') || undefined,
    };
    if (!input.source_seat || !input.target_daemon || !input.target_seat || !input.urgent || !input.title || !input.body) {
      json(res, 400, { ok: false, error: 'bad_request', message: 'source_seat/target_daemon/target_seat/urgent(urgent|normal)/title/body 全必填' });
      return true;
    }
    const outcome = enqueueNotify(input);
    if (!outcome.ok) {
      json(res, outcome.statusCode, { ok: false, error: outcome.error, message: outcome.message });
      return true;
    }
    json(res, 200, {
      ok: true,
      accepted: outcome.duplicate ? 'duplicate' : 'accepted',
      message_id: outcome.message.message_id,
      status: outcome.message.status,
      enqueued_at: outcome.message.enqueued_at,
    });
    return true;
  }

  // ── GET /internal/v1/notify/outbox（TriMLC 收端拉取）──
  if (path === '/internal/v1/notify/outbox' && req.method === 'GET') {
    const pending = pullPending();
    json(res, 200, { ok: true, count: pending.length, messages: pending });
    return true;
  }

  // ── POST /internal/v1/notify/confirm（收端状态确认）──
  if (path === '/internal/v1/notify/confirm' && req.method === 'POST') {
    const raw = await readBody(req);
    let body: { message_id?: unknown; to?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      json(res, 400, { ok: false, error: 'invalid_json', message: 'Request body must be valid JSON' });
      return true;
    }
    const messageId = typeof body.message_id === 'string' ? body.message_id : '';
    const to = body.to === 'forwarded' || body.to === 'delivered' ? body.to : null;
    if (!messageId || !to) {
      json(res, 400, { ok: false, error: 'bad_request', message: 'message_id 与 to(forwarded|delivered) 必填' });
      return true;
    }
    const result = transitionStatus(messageId, to);
    if (!result.ok) {
      json(res, result.reason === 'not_found' ? 404 : 409, { ok: false, error: result.reason });
      return true;
    }
    json(res, 200, { ok: true, message_id: messageId, status: to });
    return true;
  }

  // ── GET /internal/v1/notify/status（源席查询三态）──
  if (path === '/internal/v1/notify/status' && req.method === 'GET') {
    const messageId = query.get('message_id');
    const messages = queryStatus(messageId);
    json(res, 200, {
      ok: true,
      count: messages.length,
      messages: messages.map((m) => ({
        message_id: m.message_id,
        target_seat: m.target_seat,
        urgent: m.urgent,
        title: m.title,
        status: m.status,
        status_history: m.status_history,
        enqueued_at: m.enqueued_at,
        expired: m.expired ?? false,
      })),
    });
    return true;
  }

  return false;
}
