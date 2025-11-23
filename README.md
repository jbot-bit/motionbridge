# MotionBridge Worker

This Cloudflare Worker exposes two POST endpoints to connect Motion with OpenAI:

- `POST /bridge` — accepts a simple message payload, calls OpenAI for a concise reply, and can optionally forward that reply to a Motion webhook you provide.
- `POST /add-tasks` — accepts an array of task payloads and creates them in Motion, returning per-task success/error details.

## Required environment
Configure these secrets/vars in your Worker (via `wrangler secret put` or dashboard):

- `OPENAI_API_KEY` — OpenAI API key used by `/bridge`.
- `MOTION_API_KEY` — Motion API key (sent as `X-API-Key` for `/add-tasks`, or as `Authorization: Bearer` when forwarding in `/bridge`).
- `MOTION_WORKSPACE_ID` — Motion workspace ID required for `/add-tasks`.

## Example requests

### /bridge
```bash
curl -X POST https://<your-worker>.workers.dev/bridge \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Summarize this task update",
    "motionWebhook": "https://example.com/receive",
    "motionPayload": { "taskId": "123" }
  }'
```
Returns `{ "reply": "...", "motionForwarded": true|false }`.

### /add-tasks
```bash
curl -X POST https://<your-worker>.workers.dev/add-tasks \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      { "title": "Draft contract", "minutes": 30, "tags": ["Legal"] },
      { "title": "Plan sprint", "priority": "LOW" }
    ]
  }'
```
- Missing titles yield an error entry, but other tasks still attempt to create.
- Tasks labeled `Legal` are auto-upgraded to `HIGH` priority.

## Local dev & deploy
1. Install deps: `npm install`
2. Log in once: `npx wrangler login`
3. Set secrets: `npx wrangler secret put OPENAI_API_KEY`, `npx wrangler secret put MOTION_API_KEY`, `npx wrangler secret put MOTION_WORKSPACE_ID`
4. Dev server: `npx wrangler dev`
5. Deploy: `npx wrangler deploy` (ensure `name` is set in `wrangler.jsonc`)

Logs and errors appear in the Wrangler console; non-POST paths return `404`, and JSON parse errors return `400`.
All error responses are JSON objects shaped like `{ "error": "message" }`.
