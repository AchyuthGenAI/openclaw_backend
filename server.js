const crypto = require("crypto");
const express = require("express");
const http = require("http");
const OpenAI = require("openai");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const CLOUD_MODE = /^true|1|yes$/i.test(process.env.CLOUD_MODE || "true");
const MODEL =
  process.env.OPENAI_MODEL ||
  process.env.GROQ_MODEL ||
  (process.env.GROQ_API_KEY ? "llama-3.3-70b-versatile" : "gpt-4o-mini");

const app = express();
app.use(express.json({ limit: "2mb" }));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const sessions = new Map();
const memory = new Map();

function createAIClient() {
  const apiKey =
    process.env.OPENAI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) return null;

  const baseURL =
    process.env.OPENAI_BASE_URL ||
    process.env.GROQ_BASE ||
    (process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1" : undefined) ||
    (process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : undefined);

  return new OpenAI({ apiKey, baseURL });
}

const ai = createAIClient();

const SYSTEM_PROMPT = `You are AURA, a proactive OpenClaw assistant connected to the user's iPhone.
You can chat naturally, navigate apps, run actions, and automate multi-step tasks by calling tools.
Use tools whenever the user asks to do something on the phone. Chain tools when needed.
For sensitive actions like sending messages, calls, calendar edits, contact edits, clipboard writes, and reminders, the iOS app will ask the user for confirmation.
Be concise after actions: say what you did and mention any limitation from iOS if a tool reports one.`;

const TOOLS = [
  tool("get_contacts", "Get all contacts from the user's iPhone", {}),
  tool("search_contacts", "Search contacts by name, phone, or email", {
    query: { type: "string", description: "Name, number, or email to search" },
  }, ["query"]),
  tool("send_message", "Send an iMessage or SMS", {
    to: { type: "string", description: "Phone number or contact name" },
    body: { type: "string", description: "Message body" },
  }, ["to", "body"]),
  tool("make_call", "Start a phone call", {
    number: { type: "string", description: "Phone number or contact name" },
  }, ["number"]),
  tool("get_photos", "Get recent photos", {
    limit: { type: "integer", description: "Maximum photos to return" },
  }),
  tool("take_photo", "Open camera and take a photo", {}),
  tool("take_screenshot", "Capture the current app screen", {}),
  tool("get_clipboard", "Read clipboard text", {}),
  tool("set_clipboard", "Copy text to clipboard", {
    text: { type: "string", description: "Text to copy" },
  }, ["text"]),
  tool("get_battery", "Get battery and charging status", {}),
  tool("get_device_info", "Get iPhone model, iOS version, screen and brightness", {}),
  tool("get_wifi_info", "Get current WiFi and network information", {}),
  tool("get_storage_info", "Get storage usage", {}),
  tool("set_volume", "Set system volume from 0.0 to 1.0", {
    level: { type: "string", description: "Volume level" },
  }, ["level"]),
  tool("set_brightness", "Set screen brightness from 0.0 to 1.0", {
    level: { type: "string", description: "Brightness level" },
  }, ["level"]),
  tool("vibrate_device", "Trigger haptic vibration", {}),
  tool("get_location", "Get GPS location", {}),
  tool("open_app", "Open an app or URL on iPhone", {
    app_name: { type: "string", description: "App name, URL, or known iOS app" },
  }, ["app_name"]),
  tool("get_installed_apps", "List known launchable apps", {}),
  tool("control_media", "Control media playback", {
    action: { type: "string", enum: ["play", "pause", "next", "previous", "stop"] },
  }, ["action"]),
  tool("get_calendar_events", "Get upcoming calendar events", {
    days: { type: "integer", description: "Days ahead" },
  }),
  tool("create_calendar_event", "Create a calendar event", {
    title: { type: "string" },
    start: { type: "string", description: "ISO8601 start date" },
    end: { type: "string", description: "ISO8601 end date" },
    location: { type: "string" },
    notes: { type: "string" },
  }, ["title", "start"]),
  tool("get_reminders", "Get reminders", {}),
  tool("create_reminder", "Create a reminder", {
    title: { type: "string" },
    notes: { type: "string" },
    due: { type: "string", description: "Optional ISO8601 due date" },
  }, ["title"]),
  tool("read_notifications", "Read notification summary available to AURA", {}),
  tool("web_search", "Search the web for current information", {
    query: { type: "string" },
    max_results: { type: "integer" },
  }, ["query"]),
  tool("remember", "Store a long-term memory for this user", {
    key: { type: "string" },
    value: { type: "string" },
  }, ["key", "value"]),
  tool("recall", "Recall one long-term memory", {
    key: { type: "string" },
  }, ["key"]),
  tool("recall_all", "Recall all long-term memories", {}),
  tool("schedule_task", "Schedule an iPhone tool/action to run later", {
    tool_name: { type: "string", description: "Exact tool name, e.g. open_app" },
    tool_args: { type: "object", description: "Arguments for the tool" },
    delay_seconds: { type: "integer", description: "Delay before running" },
    label: { type: "string", description: "Human-friendly label" },
  }, ["tool_name", "tool_args", "delay_seconds", "label"]),
  tool("list_scheduled_tasks", "List pending scheduled tasks", {}),
  tool("cancel_scheduled_task", "Cancel a scheduled task by id", {
    task_id: { type: "string" },
  }, ["task_id"]),
];

function tool(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}

app.get("/", (req, res) => {
  const host = req.get("host") || "";
  res.json({
    status: "OpenClaw Backend Running",
    protocol: "OpenClaw WebSocket v3",
    websocketURL: host ? `wss://${host}` : null,
    model: MODEL,
    aiConfigured: Boolean(ai),
    cloudMode: CLOUD_MODE,
  });
});

app.post("/api/chat", async (req, res) => {
  const content = String(req.body?.message || req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "message is required" });

  if (!ai) {
    const plan = fallbackPlan(content);
    return res.json({
      reply: plan.reply || "AI key is not configured. WebSocket tool mode can still run simple actions from the app.",
      plannedTools: plan.tools,
    });
  }

  try {
    const completion = await ai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "You are AURA. Reply concisely. No iPhone tools are connected on this REST endpoint." },
        { role: "user", content },
      ],
      temperature: 0.7,
      max_tokens: 600,
    });
    res.json({ reply: completion.choices?.[0]?.message?.content || "" });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

wss.on("connection", (ws, req) => {
  const session = new AURASession(ws, req);
  sessions.set(session.id, session);
  session.start();
  ws.on("message", (raw) => session.onMessage(raw.toString()));
  ws.on("close", () => sessions.delete(session.id));
  ws.on("error", () => sessions.delete(session.id));
});

class AURASession {
  constructor(ws, req) {
    this.ws = ws;
    this.id = crypto.randomUUID();
    this.userId = this.id;
    this.authenticated = false;
    this.pending = new Map();
    this.scheduled = new Map();
    this.capabilities = [];
    this.history = [{ role: "system", content: SYSTEM_PROMPT }];
    this.remote = req.socket.remoteAddress || "unknown";
  }

  start() {
    this.sendEvent("connect.challenge", { nonce: crypto.randomUUID() });
  }

  send(payload) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendEvent(event, payload = {}) {
    this.send({ event, payload });
  }

  sendRes(id, ok, payload = {}) {
    this.send({ type: "res", id, ok, payload });
  }

  async onMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type !== "req") return;

    const id = data.id || crypto.randomUUID();
    const method = data.method || "";
    const params = data.params || {};

    if (method === "connect") {
      const token = String(params.auth?.token || "").trim();
      const bearer = String(process.env.BEARER_TOKEN || "").trim();

      if (CLOUD_MODE ? token.length >= 8 : token && token === bearer) {
        this.authenticated = true;
        this.userId = CLOUD_MODE ? hashUser(token) : "local";
        this.sendRes(id, true, { type: "hello-ok" });
        this.sendEvent("status", { message: "AURA cloud gateway connected." });
      } else {
        this.sendRes(id, false, { error: "Unauthorized" });
      }
      return;
    }

    if (!this.authenticated) {
      this.sendRes(id, false, { error: "Not authenticated" });
      return;
    }

    if (method === "node.capabilities") {
      this.capabilities = params.capabilities || params.caps || [];
      this.sendRes(id, true, { received: this.capabilities.length });
      return;
    }

    if (method === "node.heartbeat") {
      this.sendRes(id, true, { status: "ok" });
      return;
    }

    if (method === "node.pending.pull") {
      this.sendRes(id, true, { invokes: [] });
      return;
    }

    if (method === "message.send") {
      const content = String(params.content || "").trim();
      this.sendRes(id, true, {});
      if (content) this.processUserMessage(content).catch((error) => {
        this.sendEvent("error", { message: String(error.message || error) });
      });
      return;
    }

    if (method === "tool.result" || method === "node.invoke.result") {
      const callId = params.callId || params.toolCallId || params.invokeId || "";
      this.resolveToolResult(callId, params);
      this.sendRes(id, true, {});
      return;
    }

    this.sendRes(id, true, {});
  }

  resolveToolResult(callId, params) {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    pending.resolve({
      success: params.success !== false,
      result: String(params.result || params.output || ""),
    });
  }

  async processUserMessage(content) {
    this.sendEvent("status", { message: "Thinking..." });
    this.history.push({ role: "user", content });

    if (!ai) {
      await this.runFallback(content);
      return;
    }

    for (let turn = 0; turn < 6; turn += 1) {
      const completion = await ai.chat.completions.create({
        model: MODEL,
        messages: this.withMemory(),
        tools: TOOLS,
        tool_choice: "auto",
        temperature: Number(process.env.TEMPERATURE || 0.7),
        max_tokens: Number(process.env.MAX_TOKENS || 1400),
      });

      const message = completion.choices?.[0]?.message || {};
      const toolCalls = message.tool_calls || [];

      if (!toolCalls.length) {
        const reply = message.content || "Done.";
        this.history.push({ role: "assistant", content: reply });
        this.sendEvent("message.complete", { content: reply, role: "assistant" });
        return;
      }

      this.history.push({
        role: "assistant",
        content: message.content || null,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const name = call.function?.name || "";
        const args = safeJSON(call.function?.arguments || "{}");
        const result = await this.executeTool(name, args);
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
      }
    }

    this.sendEvent("message.complete", {
      role: "assistant",
      content: "I ran the available steps, but the task needs more turns. Tell me to continue and I will keep going.",
    });
  }

  withMemory() {
    const userMem = memory.get(this.userId);
    if (!userMem || Object.keys(userMem).length === 0) return this.history;
    const memText = Object.entries(userMem)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    return [
      { role: "system", content: `${SYSTEM_PROMPT}\n\nLong-term memory:\n${memText}` },
      ...this.history.slice(1),
    ];
  }

  async runFallback(content) {
    const plan = fallbackPlan(content);
    if (!plan.tools.length) {
      this.sendEvent("message.complete", {
        role: "assistant",
        content: plan.reply || "I am connected, but no AI provider key is configured on the backend yet. Add OPENAI_API_KEY or GROQ_API_KEY in Railway for full OpenClaw intelligence.",
      });
      return;
    }

    const outputs = [];
    for (const call of plan.tools) {
      outputs.push(await this.executeTool(call.name, call.arguments));
    }
    this.sendEvent("message.complete", {
      role: "assistant",
      content: `${plan.reply}\n\n${outputs.join("\n")}`,
    });
  }

  async executeTool(name, args) {
    if (name === "remember") {
      const userMem = memory.get(this.userId) || {};
      userMem[String(args.key || "note")] = String(args.value || "");
      memory.set(this.userId, userMem);
      return "Memory saved.";
    }

    if (name === "recall") {
      const userMem = memory.get(this.userId) || {};
      return userMem[String(args.key || "")] || "No memory found.";
    }

    if (name === "recall_all") {
      const userMem = memory.get(this.userId) || {};
      return Object.keys(userMem).length ? JSON.stringify(userMem, null, 2) : "No memories saved.";
    }

    if (name === "web_search") {
      return "Web search is not enabled in this Node deployment yet.";
    }

    if (name === "schedule_task") {
      return this.scheduleTask(args);
    }

    if (name === "list_scheduled_tasks") {
      const active = [...this.scheduled.values()].filter((task) => task.timeout);
      return active.length
        ? active.map((task) => `${task.id.slice(0, 8)}: ${task.label}`).join("\n")
        : "No pending scheduled tasks.";
    }

    if (name === "cancel_scheduled_task") {
      const taskId = String(args.task_id || "");
      const task = [...this.scheduled.values()].find((item) => item.id.startsWith(taskId));
      if (!task) return `No scheduled task found for ${taskId}.`;
      clearTimeout(task.timeout);
      this.scheduled.delete(task.id);
      return `Cancelled ${task.label}.`;
    }

    return this.callPhoneTool(name, args);
  }

  scheduleTask(args) {
    const id = crypto.randomUUID();
    const label = String(args.label || args.tool_name || "scheduled task");
    const delay = Math.max(1, Number(args.delay_seconds || 1));
    const toolName = String(args.tool_name || "");
    const toolArgs = typeof args.tool_args === "object" && args.tool_args ? args.tool_args : {};

    const timeout = setTimeout(async () => {
      this.sendEvent("message.complete", {
        role: "assistant",
        content: `Running scheduled task: ${label}`,
      });
      await this.executeTool(toolName, toolArgs);
      this.scheduled.delete(id);
    }, delay * 1000);

    this.scheduled.set(id, { id, label, timeout });
    return `Scheduled ${label} in ${delay} seconds. Task ID: ${id.slice(0, 8)}`;
  }

  callPhoneTool(name, args) {
    const id = crypto.randomUUID();
    this.sendEvent("tool.call", { id, name, arguments: args || {} });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        resolve(`Tool ${name} timed out after 45 seconds.`);
      }, 45_000);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value.success ? value.result || `${name} completed.` : `${name} failed: ${value.result}`);
        },
      });
    });
  }
}

function hashUser(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}

function safeJSON(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function fallbackPlan(content) {
  const text = content.trim();
  const lower = text.toLowerCase();

  if (/\b(battery|charge|charging)\b/.test(lower)) {
    return plan("I will check your battery.", "get_battery");
  }
  if (/\b(location|where am i|gps)\b/.test(lower)) {
    return plan("I will get your current location.", "get_location");
  }
  if (/\b(device info|phone info|ios version)\b/.test(lower)) {
    return plan("I will check device information.", "get_device_info");
  }
  if (/\b(storage|space)\b/.test(lower)) {
    return plan("I will check storage.", "get_storage_info");
  }
  if (/\b(wifi|network)\b/.test(lower)) {
    return plan("I will check network information.", "get_wifi_info");
  }
  if (/\bclipboard\b/.test(lower) && /\b(read|get|what)\b/.test(lower)) {
    return plan("I will read the clipboard.", "get_clipboard");
  }
  if (/\b(copy|clipboard)\b/.test(lower)) {
    const textToCopy = text.replace(/^(copy|set clipboard to|copy this|clipboard)\s*/i, "").trim();
    if (textToCopy) return plan("I will copy that to the clipboard.", "set_clipboard", { text: textToCopy });
  }
  if (/\bvibrate\b/.test(lower)) {
    return plan("I will vibrate the device.", "vibrate_device");
  }
  if (/\bphoto|camera\b/.test(lower) && /\b(take|snap|open)\b/.test(lower)) {
    return plan("I will open the camera.", "take_photo");
  }
  if (/\bscreenshot\b/.test(lower)) {
    return plan("I will capture a screenshot.", "take_screenshot");
  }
  if (/\bcontacts\b/.test(lower) && /\b(list|show|get)\b/.test(lower)) {
    return plan("I will get your contacts.", "get_contacts");
  }

  const openMatch = text.match(/\bopen\s+(.+)$/i);
  if (openMatch) return plan(`I will open ${openMatch[1]}.`, "open_app", { app_name: openMatch[1].trim() });

  const callMatch = text.match(/\bcall\s+(.+)$/i);
  if (callMatch) return plan(`I will start a call to ${callMatch[1]}.`, "make_call", { number: callMatch[1].trim() });

  const messageMatch = text.match(/\b(?:message|text|sms|send)\s+(.+?)\s+(?:saying|that|:)\s+(.+)$/i);
  if (messageMatch) {
    return plan(`I will send that message to ${messageMatch[1]}.`, "send_message", {
      to: messageMatch[1].trim(),
      body: messageMatch[2].trim(),
    });
  }

  const brightnessMatch = lower.match(/\bbrightness\b.*?(\d{1,3})\s*%?/);
  if (brightnessMatch) {
    return plan("I will adjust brightness.", "set_brightness", {
      level: String(Math.min(100, Number(brightnessMatch[1])) / 100),
    });
  }

  const volumeMatch = lower.match(/\bvolume\b.*?(\d{1,3})\s*%?/);
  if (volumeMatch) {
    return plan("I will adjust volume.", "set_volume", {
      level: String(Math.min(100, Number(volumeMatch[1])) / 100),
    });
  }

  const reminderMatch = text.match(/\bremind me to\s+(.+)$/i);
  if (reminderMatch) {
    return plan("I will create that reminder.", "create_reminder", {
      title: reminderMatch[1].trim(),
    });
  }

  return {
    reply: "I am connected. Add OPENAI_API_KEY or GROQ_API_KEY in Railway to unlock full natural-language OpenClaw planning.",
    tools: [],
  };
}

function plan(reply, name, args = {}) {
  return { reply, tools: [{ name, arguments: args }] };
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenClaw backend running on port ${PORT}`);
  console.log(`AI configured: ${Boolean(ai)}; model: ${MODEL}`);
});
