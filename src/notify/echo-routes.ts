// ── Q2 件①回声出向队列路由组（挂 /internal/* X-Internal-Token 门内）──
// 三端点：POST enqueue（服务域写入）/ GET queue（mc-echo-pull 拉取）/ POST ack
// （消账确认）。返回 true=已处理；false=非本组路径。字段白名单在路由层
// （红线①无 file/binary 传输字段——件③收箱端点同形）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ackEchoItem, echoQueuePath, enqueueEchoItem, pullEchoQueue, ECHO_QUEUE_FILE_ENV } from './echo-queue.js';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** enqueue 字段白名单（红线①：六键+可选 title/message_id——file/binary/其余=400）。 */
const ECHO_ENQUEUE_ALLOWED_KEYS = new Set(['target_endpoint', 'source_id', 'ts_machine', 'ref', 'text', 'title', 'message_id']);

export async function handleEchoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
): Promise<boolean> {
  const path = url.split('?')[0];
  const query = new URL(url, 'http://localhost').searchParams;

  // ── POST /internal/v1/echo/enqueue（服务域写入）──
  if (path === '/internal/v1/echo/enqueue' && req.method === 'POST') {
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json(res, 400, { ok: false, error: 'bad_json', message: 'Request body must be valid JSON' });
      return true;
    }
    const extraKeys = Object.keys(body).filter((k) => !ECHO_ENQUEUE_ALLOWED_KEYS.has(k));
    if (extraKeys.length > 0) {
      json(res, 400, { ok: false, error: 'forbidden_fields', fields: extraKeys, message: `字段白名单外（红线①无 file/binary 传输字段）：${extraKeys.join('、')}` });
      return true;
    }
    const str = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');
    const outcome = enqueueEchoItem({
      target_endpoint: str('target_endpoint').trim(),
      source_id: str('source_id').trim(),
      ts_machine: str('ts_machine').trim(),
      ref: str('ref').trim(),
      text: str('text'),
      ...(str('title').trim() ? { title: str('title').trim() } : {}),
      ...(str('message_id').trim() ? { message_id: str('message_id').trim() } : {}),
    });
    if (!outcome.ok) {
      json(res, outcome.statusCode, { ok: false, error: outcome.error, message: outcome.message });
      return true;
    }
    json(res, 201, {
      ok: true,
      accepted: outcome.duplicate ? 'duplicate' : 'accepted',
      message_id: outcome.item.message_id,
      enqueued_at: outcome.item.enqueued_at,
    });
    return true;
  }

  // ── GET /internal/v1/echo/queue?consumer=<id>（拉取方按消费方取）──
  if (path === '/internal/v1/echo/queue' && req.method === 'GET') {
    const consumer = query.get('consumer') ?? '';
    const outcome = pullEchoQueue(consumer);
    if (!outcome.ok) {
      json(res, outcome.statusCode, { ok: false, error: outcome.error, message: outcome.message });
      return true;
    }
    json(res, 200, { ok: true, count: outcome.items.length, items: outcome.items });
    return true;
  }

  // ── POST /internal/v1/echo/ack（消账确认）──
  if (path === '/internal/v1/echo/ack' && req.method === 'POST') {
    const raw = await readBody(req);
    let body: { message_id?: unknown; consumer?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      json(res, 400, { ok: false, error: 'bad_json', message: 'Request body must be valid JSON' });
      return true;
    }
    const messageId = typeof body.message_id === 'string' ? body.message_id.trim() : '';
    const consumer = typeof body.consumer === 'string' ? body.consumer.trim() : '';
    if (!messageId || !consumer) {
      json(res, 400, { ok: false, error: 'bad_request', message: 'message_id 与 consumer 必填' });
      return true;
    }
    const result = ackEchoItem(messageId, consumer);
    if (!result.ok) {
      json(res, result.reason === 'not_found' ? 404 : 403, { ok: false, error: result.reason });
      return true;
    }
    json(res, 200, { ok: true, duplicate: result.duplicate });
    return true;
  }

  // echo 队列存储路径 env 仅运维缝用（登记：TRIMC_ECHO_QUEUE_FILE=echoQueuePath）
  void ECHO_QUEUE_FILE_ENV;
  void echoQueuePath;
  return false;
}
