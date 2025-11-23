const JSON_HEADERS = { "Content-Type": "application/json" };
const OPENAI_MODEL = "gpt-4o-mini";
const MOTION_BASE_URL = "https://api.usemotion.com/v1";

function jsonResponse(body, status = 200, headers = JSON_HEADERS) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (_error) {
    return { error: "Invalid JSON body" };
  }
}

function uniqueTags(tags = []) {
  const seen = new Set();
  const list = [];
  for (const tag of tags) {
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      list.push(tag);
    }
  }
  return list;
}

function clampMinutes(value, fallback = 25) {
  const minutes = Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback;
  return Math.min(50, Math.max(5, Math.round(minutes)));
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseDueDate(due) {
  if (!due) return null;
  const parsed = new Date(due);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function commandDefaults(command) {
  switch (command) {
    case "legal":
      return { domain: "Legal", priority: "HIGH", tags: ["Legal"], dueOffset: 2 };
    case "biz":
      return { domain: "Business", priority: "MEDIUM", tags: ["Business"], dueOffset: 5 };
    case "personal":
      return { domain: "Personal", priority: "MEDIUM", tags: ["Personal"], dueOffset: null };
    default:
      return { domain: "General", priority: "MEDIUM", tags: [], dueOffset: null };
  }
}

function inferEnergyLabel(task) {
  const text = `${task.title ?? ""} ${task.notes ?? ""}`.toLowerCase();
  if (/(affidavit|complaint|subpoena|sworn|evidence|statement|draft order)/.test(text)) {
    return "Energy:High";
  }
  if (/(plan|outline|brief|strategy|architecture)/.test(text)) {
    return "Energy:Medium";
  }
  if (/(email|call|phone|admin|invoice|receipt|upload|sync|form|booking)/.test(text)) {
    return "Energy:Low";
  }
  return null;
}

function applyTaskDefaults(task, defaults) {
  const normalizedTags = uniqueTags([
    ...(Array.isArray(task.tags) ? task.tags : []),
    ...(Array.isArray(task.labels) ? task.labels : []),
    ...(defaults.tags ?? []),
  ]);

  const energyLabel = inferEnergyLabel(task);
  if (energyLabel) {
    normalizedTags.push(energyLabel);
  }

  const dueDate = parseDueDate(task.due ?? task.dueDate) ??
    (defaults.dueOffset != null ? dateOffset(defaults.dueOffset) : null);

  return {
    title: task.title ?? task.name ?? "Untitled task",
    notes: task.notes ?? task.description ?? "",
    minutes: clampMinutes(task.minutes ?? task.duration),
    priority: task.priority ?? defaults.priority ?? "MEDIUM",
    tags: uniqueTags(normalizedTags),
    due: dueDate,
    domain: task.domain ?? defaults.domain ?? "General",
  };
}

async function callOpenAIForTasks({ command, context, apiKey }) {
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY secret");
  }

  const prompt = [
    "Extract tasks from the user context. Return ONLY JSON with shape:",
    '{ "tasks": [ { "title": "", "minutes": 25, "tags": [], "due": "YYYY-MM-DD", "notes": "" } ] }',
    "- Each task duration must be 5-50 minutes.",
    "- Summarize titles succinctly; include key names/subjects.",
    "- Use tags based on entities (ICL, Evie, school, business, personal, legal, etc.).",
    "- Prefer due dates if explicit; otherwise leave null (the backend will set defaults).",
    "- If nothing actionable, return { \"tasks\": [] }.",
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({ command, context }, null, 2),
        },
      ],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${detail}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? "";

  try {
    return JSON.parse(content);
  } catch (_error) {
    throw new Error("OpenAI response was not valid JSON");
  }
}

async function postWithRetry(url, options, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, options);
    if (response.ok) {
      return response;
    }
    lastError = new Error(`HTTP ${response.status}: ${await response.text()}`);
    if (attempt < attempts) {
      const delayMs = 200 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

async function createMotionTask(task, env) {
  const motionApiKey = env.MOTION_API_KEY;
  const workspaceId = env.MOTION_WORKSPACE_ID;
  if (!motionApiKey) throw new Error("Missing MOTION_API_KEY secret");
  if (!workspaceId) throw new Error("Missing MOTION_WORKSPACE_ID secret");

  const payload = {
    name: task.title,
    workspaceId,
    description: task.notes ?? "",
    duration: task.minutes ?? 25,
    priority: task.priority ?? "MEDIUM",
    labels: task.tags ?? [],
    dueDate: task.due ?? null,
  };

  const response = await postWithRetry(`${MOTION_BASE_URL}/tasks`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      "X-API-Key": motionApiKey,
    },
    body: JSON.stringify(payload),
  });

  return response.json();
}

async function handleRoute(request, env) {
  const body = await readJson(request);
  if (body?.error) return new Response(body.error, { status: 400 });

  const command = (body.command ?? "add").toLowerCase();
  const context = body.context ?? "";
  const userId = body.userId ?? "unknown";
  const defaults = commandDefaults(command);

  let aiResult;
  try {
    aiResult = await callOpenAIForTasks({ command, context, apiKey: env.OPENAI_API_KEY });
  } catch (error) {
    return new Response(error.message, { status: 500 });
  }

  const tasks = Array.isArray(aiResult?.tasks) ? aiResult.tasks : [];
  const normalized = tasks.map((task) => applyTaskDefaults(task, defaults));

  const results = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const task = normalized[index];
    try {
      const created = await createMotionTask(task, env);
      results.push({ index, status: "ok", task: created });
    } catch (error) {
      results.push({ index, status: "error", message: error.message });
    }
  }

  return jsonResponse({
    userId,
    command,
    tasks: normalized,
    results,
  });
}

async function handleAddTasks(request, env) {
  const body = await readJson(request);
  if (body?.error) return new Response(body.error, { status: 400 });

  const tasks = Array.isArray(body.tasks) ? body.tasks : [];
  if (tasks.length === 0) {
    return new Response("Missing tasks array", { status: 400 });
  }

  const normalized = tasks.map((task) => {
    const inferredDomain =
      (task.domain ?? "").toLowerCase() ||
      (task.tags || []).find((tag) => ["legal", "business", "personal"].includes(String(tag).toLowerCase())) ||
      "general";

    const defaults = commandDefaults(
      inferredDomain.startsWith("legal")
        ? "legal"
        : inferredDomain.startsWith("business")
          ? "biz"
          : inferredDomain.startsWith("personal")
            ? "personal"
            : "add",
    );

    return applyTaskDefaults(task, defaults);
  });

  const results = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const task = normalized[index];
    try {
      const created = await createMotionTask(task, env);
      results.push({ index, status: "ok", task: created });
    } catch (error) {
      results.push({ index, status: "error", message: error.message });
    }
  }

  return jsonResponse({ results, count: results.length });
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Send POST", { status: 405 });
    }

    const { pathname } = new URL(request.url);
    if (pathname === "/route") {
      return handleRoute(request, env);
    }
    if (pathname === "/add-tasks") {
      return handleAddTasks(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};

