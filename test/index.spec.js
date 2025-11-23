diff --git a/test/index.spec.js b/test/index.spec.js
index e2807ff0f3952d8522dfc9dc57360bf4969012d6..3a6bd2196925339acaa70f29880dc33eac5287fe 100644
--- a/test/index.spec.js
+++ b/test/index.spec.js
@@ -1,20 +1,100 @@
-import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
-import { describe, it, expect } from 'vitest';
-import worker from '../src';
-
-describe('Hello World worker', () => {
-	it('responds with Hello World! (unit style)', async () => {
-		const request = new Request('http://example.com');
-		// Create an empty context to pass to `worker.fetch()`.
-		const ctx = createExecutionContext();
-		const response = await worker.fetch(request, env, ctx);
-		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
-		await waitOnExecutionContext(ctx);
-		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
-	});
-
-	it('responds with Hello World! (integration style)', async () => {
-		const response = await SELF.fetch('http://example.com');
-		expect(await response.text()).toMatchInlineSnapshot(`"Hello World!"`);
-	});
+import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
+import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
+import worker from '../src/index.js';
+
+const BASE_ENV = {
+  OPENAI_API_KEY: 'openai-key',
+  MOTION_API_KEY: 'motion-key',
+  MOTION_WORKSPACE_ID: 'workspace-123',
+};
+
+describe('MotionBridge worker', () => {
+  beforeEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  afterEach(() => {
+    vi.restoreAllMocks();
+  });
+
+  it('returns an OpenAI reply on /bridge', async () => {
+    const fetchMock = vi.fn(async (input, init) => {
+      if (typeof input === 'string' && input.includes('openai.com')) {
+        return new Response(
+          JSON.stringify({
+            choices: [{ message: { content: 'Bridged reply' } }],
+          }),
+          { status: 200, headers: { 'Content-Type': 'application/json' } },
+        );
+      }
+
+      throw new Error(`Unexpected fetch: ${input}`);
+    });
+
+    vi.stubGlobal('fetch', fetchMock);
+
+    const request = new Request('https://example.com/bridge', {
+      method: 'POST',
+      headers: { 'Content-Type': 'application/json' },
+      body: JSON.stringify({ message: 'hello' }),
+    });
+
+    const ctx = createExecutionContext();
+    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
+    await waitOnExecutionContext(ctx);
+
+    expect(response.status).toBe(200);
+    const data = await response.json();
+    expect(data).toEqual({ reply: 'Bridged reply', motionForwarded: false });
+    expect(fetchMock).toHaveBeenCalledTimes(1);
+  });
+
+  it('creates Motion tasks on /add-tasks and returns per-task status', async () => {
+    const fetchMock = vi.fn(async (input, init) => {
+      if (typeof input === 'string' && input.includes('usemotion.com')) {
+        return new Response(JSON.stringify({ id: 'task-1', name: 'New task' }), {
+          status: 200,
+          headers: { 'Content-Type': 'application/json' },
+        });
+      }
+
+      throw new Error(`Unexpected fetch: ${input}`);
+    });
+
+    vi.stubGlobal('fetch', fetchMock);
+
+    const request = new Request('https://example.com/add-tasks', {
+      method: 'POST',
+      headers: { 'Content-Type': 'application/json' },
+      body: JSON.stringify({
+        tasks: [
+          { title: 'Write docs', minutes: 30 },
+        ],
+      }),
+    });
+
+    const ctx = createExecutionContext();
+    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
+    await waitOnExecutionContext(ctx);
+
+    expect(response.status).toBe(200);
+    const data = await response.json();
+    expect(data.created).toEqual([
+      {
+        index: 0,
+        status: 'ok',
+        task: { id: 'task-1', name: 'New task' },
+      },
+    ]);
+    expect(fetchMock).toHaveBeenCalledTimes(1);
+  });
+
+  it('returns 404 for unsupported paths', async () => {
+    const request = new Request('https://example.com/', { method: 'POST' });
+    const ctx = createExecutionContext();
+    const response = await worker.fetch(request, { ...BASE_ENV }, ctx);
+    await waitOnExecutionContext(ctx);
+
+    expect(response.status).toBe(404);
+  });
 });
