import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import worker from '../src/index.js';

const BASE_ENV = {
  OPENAI_API_KEY: 'openai-key',
  MOTION_API_KEY: 'motion-key',
  MOTION_WORKSPACE_ID: 'workspace-123',
};

describe('MotionBridge worker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an OpenAI reply on /bridge', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      if (typeof input === 'string' && input.includes('openai.com')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Bridged reply' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      throw new Error(`Unexpected fetch: ${input}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://example.com/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ reply: 'Bridged reply', motionForwarded: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns JSON error when payload is invalid JSON', async () => {
    const request = new Request('https://example.com/bridge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data).toEqual({ error: 'Invalid JSON body' });
  });

  it('creates Motion tasks on /add-tasks and returns per-task status', async () => {
    const fetchMock = vi.fn(async (input, init) => {
      if (typeof input === 'string' && input.includes('usemotion.com')) {
        return new Response(JSON.stringify({ id: 'task-1', name: 'New task' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected fetch: ${input}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('https://example.com/add-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          { title: 'Write docs', minutes: 30 },
        ],
      }),
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.created).toEqual([
      {
        index: 0,
        status: 'ok',
        task: { id: 'task-1', name: 'New task' },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unsupported paths', async () => {
    const request = new Request('https://example.com/', { method: 'POST' });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
  });
});
