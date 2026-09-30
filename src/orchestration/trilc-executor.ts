// ── 2.1/2.2: TriRLC HTTP Dispatch Executor ──
// Implements DispatchExecutor by POSTing tasks to TriRLC's /internal/v1/tasks/submit
// and consuming the SSE stream for real-time results.
// Used by TriMMC's dispatchAsync() to execute tasks on a remote TriRLC node.

import type { DispatchExecutor } from './dispatch-proxy.js';

const TASK_TIMEOUT_MS = 300_000; // 300s timeout

/**
 * TriRLCDispatchExecutor bridges TriMMC's dispatch pipeline to a TriRLC node.
 *
 * Flow:
 *   POST TriRLC /internal/v1/tasks/submit → get sessionId + streamEndpoint
 *   GET TriRLC /internal/v1/sessions/{id}/stream (SSE) → collect delta content
 *   On task_done → return { ok: true, output }
 *   On task_error → return { ok: false, error }
 *
 * The optional `taskResultCallback` fires after execution completes (success or
 * failure), enabling TriMMC's server layer to update TaskController independently.
 */
export class TriRLCDispatchExecutor implements DispatchExecutor {
  private trilcBaseUrl: string;
  private taskResultCallback?: (
    taskId: string, status: 'success' | 'failed', output?: string, error?: string,
  ) => void;

  constructor(
    trilcBaseUrl: string,
    taskResultCallback?: TriRLCDispatchExecutor['taskResultCallback'],
  ) {
    this.trilcBaseUrl = trilcBaseUrl.replace(/\/$/, '');
    this.taskResultCallback = taskResultCallback;
  }

  async execute(
    task: { type: string; description: string; priority: string; expectedOutputs: string[]; decisionType?: string },
    ctx: { taskId: string; employeeId: string; cwd: string },
  ): Promise<{ ok: boolean; output?: string; error?: string }> {
    const submitUrl = `${this.trilcBaseUrl}/internal/v1/tasks/submit`;
    const signal = AbortSignal.timeout(TASK_TIMEOUT_MS);

    try {
      // Step 1: Submit task to TriRLC
      const submitRes = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: task.description,
          conversationId: ctx.taskId,
          context: { workspaceRoot: ctx.cwd },
        }),
        signal,
      });

      if (!submitRes.ok) {
        const err = `TriRLC submit returned ${submitRes.status}`;
        this.notifyResult(ctx.taskId, 'failed', undefined, err);
        return { ok: false, error: err };
      }

      const submitBody = await submitRes.json() as {
        sessionId: string; streamEndpoint: string; status: string;
      };

      if (!submitBody.streamEndpoint) {
        const err = 'TriRLC did not return stream endpoint';
        this.notifyResult(ctx.taskId, 'failed', undefined, err);
        return { ok: false, error: err };
      }

      // Step 2: Consume SSE stream with timeout
      const sseUrl = `${this.trilcBaseUrl}${submitBody.streamEndpoint}`;
      const sseRes = await fetch(sseUrl, {
        headers: { accept: 'text/event-stream' },
        signal,
      });

      if (!sseRes.ok || !sseRes.body) {
        const err = `SSE stream failed: ${sseRes.status}`;
        this.notifyResult(ctx.taskId, 'failed', undefined, err);
        return { ok: false, error: err };
      }

      let accumulatedContent = '';
      let taskStatus: 'success' | 'failed' = 'success';
      let taskError: string | undefined;

      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);
            if (dataStr === '[DONE]') continue;
            try {
              const event = JSON.parse(dataStr) as {
                content?: string; status?: string; error?: string; summary?: string;
              };
              if (event.content) accumulatedContent += event.content;
              if (event.status === 'failed' || event.error) {
                taskStatus = 'failed';
                taskError = event.error ?? event.summary ?? 'task_error received';
              }
            } catch { /* non-JSON SSE data */ }
          }
        }
      }

      // Process remaining buffer
      if (buffer.startsWith('data: ') && buffer.length > 6) {
        try {
          const event = JSON.parse(buffer.slice(6)) as { content?: string };
          if (event.content) accumulatedContent += event.content;
        } catch { /* ignore */ }
      }

      if (taskStatus === 'failed') {
        this.notifyResult(ctx.taskId, 'failed', accumulatedContent || undefined, taskError);
        return { ok: false, error: taskError ?? 'task_error', output: accumulatedContent || undefined };
      }

      this.notifyResult(ctx.taskId, 'success', accumulatedContent || undefined);
      return { ok: true, output: accumulatedContent || 'Task completed' };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        const msg = `Task timeout after ${TASK_TIMEOUT_MS / 1000}s`;
        this.notifyResult(ctx.taskId, 'failed', undefined, msg);
        return { ok: false, error: msg };
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.notifyResult(ctx.taskId, 'failed', undefined, msg);
      return { ok: false, error: msg };
    }
  }

  private notifyResult(
    taskId: string, status: 'success' | 'failed', output?: string, error?: string,
  ): void {
    if (this.taskResultCallback) {
      try { this.taskResultCallback(taskId, status, output, error); } catch { /* best-effort */ }
    }
  }
}
