const JSON_HEADERS = { "Content-Type": "application/json" };
const MOTION_TASKS_URL = "https://api.usemotion.com/v1/tasks";

function jsonResponse(body, status = 200, headers = JSON_HEADERS) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (error) {
    return { error: "Invalid JSON body" };
  }
}

async function callOpenAI(message, apiKey) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY secret");
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are MotionBridge, a concise assistant that summarizes or responds to Motion task updates.",
        },
        { role: "user", content: message ?? "Hello" },
      ],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${detail}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content ?? "No reply";
}

async function forwardToMotion(webhookUrl, payload, motionApiKey) {
  const headers = { ...JSON_HEADERS };
  if (motionApiKey) {
    headers.Authorization = `Bearer ${motionApiKey}`;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Motion webhook error (${response.status}): ${detail}`);
  }
}

async function createMotionTask(taskPayload, motionApiKey) {
  if (!motionApiKey) {
    throw new Error("Missing MOTION_API_KEY secret");
  }

  const response = await fetch(MOTION_TASKS_URL, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      "X-API-Key": motionApiKey,
    },
    body: JSON.stringify(taskPayload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Motion API error (${response.status}): ${detail}`);
  }

  return response.json();
}

async function handleBridge(request, env) {
  const body = await readJson(request);
  if (body?.error) {
    return new Response(body.error, { status: 400 });
  }

  const message = body.message ?? body.text ?? "Hello";
  const motionWebhook = body.motionWebhook;
  const motionPayload = body.motionPayload;

  try {
    const reply = await callOpenAI(message, env.OPENAI_API_KEY);

    if (motionWebhook) {
      const payload = motionPayload ?? {};
      payload.reply = reply;
      await forwardToMotion(motionWebhook, payload, env.MOTION_API_KEY);
    }

    return jsonResponse({ reply, motionForwarded: Boolean(motionWebhook) });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }
}

async function handleAddTasks(request, env) {
  const body = await readJson(request);
  if (body?.error) {
    return new Response(body.error, { status: 400 });
  }

  const tasks = body.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return new Response("Missing tasks array", { status: 400 });
  }

  const workspaceId = env.MOTION_WORKSPACE_ID;
  const motionApiKey = env.MOTION_API_KEY;
  if (!workspaceId) {
    return new Response("Missing MOTION_WORKSPACE_ID secret", { status: 500 });
  }
  if (!motionApiKey) {
    return new Response("Missing MOTION_API_KEY secret", { status: 500 });
  }

  const created = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const name = task?.title ?? task?.name;

    if (!name) {
      created.push({ index, status: "error", message: "Task missing title/name" });
      continue;
    }

    const payload = {
      name,
      workspaceId,
      description: task?.notes ?? task?.description ?? "",
      duration: task?.minutes ?? task?.duration ?? 0,
      priority: task?.priority ?? "MEDIUM",
      labels: task?.tags ?? task?.labels ?? [],
      dueDate: task?.due ?? task?.dueDate ?? null,
    };

    if ((payload.labels || []).includes("Legal")) {
      payload.priority = "HIGH";
    }

    try {
      const response = await createMotionTask(payload, motionApiKey);
      created.push({ index, status: "ok", task: response });
    } catch (error) {
      created.push({ index, status: "error", message: error.message });
    }
  }

  return jsonResponse({ created });
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Send POST", { status: 405 });
    }

    const { pathname } = new URL(request.url);

    if (pathname === "/bridge") {
      return handleBridge(request, env);
    }

    if (pathname === "/add-tasks") {
      return handleAddTasks(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
