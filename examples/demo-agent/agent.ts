/**
 * A small support agent used to record and replay traces.
 *
 *   npx tsx examples/demo-agent/agent.ts --scripted
 *   npx tsx examples/demo-agent/agent.ts --serve
 *   OPENAI_API_KEY=... npx tsx examples/demo-agent/agent.ts "Where is order A-1001?"
 *
 * --scripted records a fixed session with no API key.
 * --serve speaks the OpenAI chat-completions API on 127.0.0.1 and answers
 * the three sample traces with the same fixed policy.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const GIFT_QUESTION = "What's the status of order A-1001 and the gift-card balance for customer c_9?";
export const ORDER_QUESTION = "What is the status of order A-1001? Reply with JSON.";
export const WEATHER_QUESTION = "Weather in Paris?";

export const WEATHER_FINAL = "The weather in Paris is currently rainy with a temperature of 57°F.";
export const ORDER_FINAL = {
  orderId: "A-1001",
  status: "shipped",
  eta: "2026-04-02",
  carrier: "UPS",
};
export const GIFT_FINAL =
  "Order A-1001 is shipped via UPS and should arrive by 2026-04-02. The gift-card balance for customer c_9 is $25.00.";

const SUPPORT_SYSTEM = "You are a support agent. Use tools before answering. Do not invent order status or balances.";

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "lookup_order",
      description: "Look up the status of an order by id",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balance",
      description: "Look up a customer's gift-card balance",
      parameters: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather in a city",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name" } },
        required: ["location"],
        additionalProperties: false,
      },
    },
  },
];

export function scriptedMessage(messages: WireMessage[]): WireMessage {
  const user = lastUserText(messages);
  const done = satisfiedTools(messages);
  const scenario = scenarioFor(user);
  if (!scenario) {
    return { role: "assistant", content: "I can help with order A-1001, gift-card balance, or the weather in Paris." };
  }
  const next = scenario.steps.find((step) => !done.has(step.name));
  if (!next) return { role: "assistant", content: scenario.final };
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: next.id,
        type: "function",
        function: { name: next.name, arguments: JSON.stringify(next.arguments) },
      },
    ],
  };
}

function scenarioFor(user: string): { steps: ScriptedStep[]; final: string } | undefined {
  if (/weather/i.test(user) || /\bparis\b/i.test(user)) {
    return {
      steps: [{ id: "call_weather_paris", name: "get_weather", arguments: { location: "Paris" } }],
      final: WEATHER_FINAL,
    };
  }
  if (/gift[- ]card/i.test(user)) {
    return {
      steps: [
        { id: "call_lookup_order", name: "lookup_order", arguments: { orderId: "A-1001" } },
        { id: "call_get_balance", name: "get_balance", arguments: { customerId: "c_9" } },
      ],
      final: GIFT_FINAL,
    };
  }
  if (/A-1001/.test(user)) {
    return {
      steps: [{ id: "call_lookup_order", name: "lookup_order", arguments: { orderId: "A-1001" } }],
      final: JSON.stringify(ORDER_FINAL),
    };
  }
  return undefined;
}

interface ScriptedStep {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

function lastUserText(messages: WireMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user" && message.content) return message.content;
  }
  return "";
}

function satisfiedTools(messages: WireMessage[]): Set<string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
  }
  const done = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id && names.has(message.tool_call_id)) {
      const name = names.get(message.tool_call_id);
      if (name) done.add(name);
    }
  }
  return done;
}

function runTool(name: string, args: Record<string, unknown>): unknown {
  if (name === "get_weather") {
    return String(args.location).toLowerCase() === "paris" ? "rainy, 57°F" : `No weather cached for ${String(args.location)}`;
  }
  if (name === "lookup_order") {
    if (args.orderId === "A-1001") {
      return { orderId: "A-1001", status: "shipped", eta: "2026-04-02", carrier: "UPS", customerId: "c_9" };
    }
    return { error: "order not found" };
  }
  if (name === "get_balance") {
    if (args.customerId === "c_9") return { customerId: "c_9", currency: "USD", amount: 25 };
    return { error: "customer not found" };
  }
  return { error: `unknown tool ${name}` };
}

export function recordScripted(question = GIFT_QUESTION): string {
  const messages: WireMessage[] = [
    { role: "system", content: SUPPORT_SYSTEM },
    { role: "user", content: question },
  ];
  const lines: string[] = [];
  const started = Date.parse("2026-03-18T15:10:00.000Z");
  for (let step = 0; step < 6; step += 1) {
    const message = scriptedMessage(messages);
    const usage = { prompt_tokens: 80 + step * 45, completion_tokens: message.tool_calls ? 18 : 36, total_tokens: 0 };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    lines.push(JSON.stringify({
      trace_id: "sess_order_balance_001",
      name: "order-and-balance",
      timestamp: new Date(started + step * 1000).toISOString(),
      latency_ms: message.tool_calls ? 280 : 460,
      request: {
        model: "gpt-4o-mini",
        messages,
        tools: TOOLS.filter((tool) => tool.function.name !== "get_weather"),
      },
      response: {
        id: `chatcmpl-demo-${step + 1}`,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
            message,
          },
        ],
        usage,
      },
    }));
    messages.push(message);
    if (!message.tool_calls?.length) break;
    for (const call of message.tool_calls) {
      const result = runTool(call.function.name, JSON.parse(call.function.arguments) as Record<string, unknown>);
      messages.push({
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  return `${lines.join("\n")}\n`;
}

export function startDemoServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const bound = address && typeof address === "object" ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${bound}/v1`,
        close: () => new Promise((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      });
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || !request.url?.startsWith("/v1/chat/completions")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  let body: { model?: string; messages?: WireMessage[] };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string; messages?: WireMessage[] };
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid JSON" } }));
    return;
  }
  const message = scriptedMessage(body.messages ?? []);
  const promptTokens = 120 + (body.messages?.length ?? 0) * 30;
  const completionTokens = message.tool_calls ? 18 : 42;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "chatcmpl-demo",
    object: "chat.completion",
    model: body.model ?? "demo",
    choices: [
      {
        index: 0,
        finish_reason: message.tool_calls ? "tool_calls" : "stop",
        message,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }));
}

async function liveMessage(messages: WireMessage[], model: string): Promise<WireMessage> {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Set OPENAI_API_KEY, or pass --scripted.");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, temperature: 0 }),
  });
  if (!response.ok) throw new Error(`Model request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);
  const json = (await response.json()) as { choices?: { message?: WireMessage }[] };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("Model response did not include a message.");
  return message;
}

async function runAgent(question: string, scripted: boolean, model: string, outFile: string): Promise<void> {
  const body = scripted ? recordScripted(question) : await recordLive(question, model);
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, body, "utf8");
  const last = body.trim().split("\n").at(-1);
  const parsed = last ? (JSON.parse(last) as { response?: { choices?: { message?: WireMessage }[] } }) : undefined;
  const text = parsed?.response?.choices?.[0]?.message?.content;
  console.log(`wrote ${outFile}`);
  if (text) console.log(text);
}

async function recordLive(question: string, model: string): Promise<string> {
  const messages: WireMessage[] = [
    { role: "system", content: SUPPORT_SYSTEM },
    { role: "user", content: question },
  ];
  const lines: string[] = [];
  for (let step = 0; step < 6; step += 1) {
    const started = Date.now();
    const message = await liveMessage(messages, model);
    lines.push(JSON.stringify({
      trace_id: `sess_${started.toString(36)}`,
      timestamp: new Date(started).toISOString(),
      latency_ms: Date.now() - started,
      request: { model, messages, tools: TOOLS },
      response: { model, choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] },
    }));
    messages.push(message);
    if (!message.tool_calls?.length) break;
    for (const call of message.tool_calls) {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result = runTool(call.function.name, args);
      messages.push({
        role: "tool",
        name: call.function.name,
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  return `${lines.join("\n")}\n`;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  const scripted = args.includes("--scripted");
  const serve = args.includes("--serve");
  const out = option(args, "--out") ?? "examples/demo-agent/last-trace.jsonl";
  const model = option(args, "--model") ?? "gpt-4o-mini";
  const port = Number(option(args, "--port") ?? 8787);
  if (serve) {
    const server = await startDemoServer(port);
    console.log(`demo model listening on ${server.url}`);
    return;
  }
  await runAgent(positional(args) ?? GIFT_QUESTION, scripted, model, out);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function positional(args: string[]): string | undefined {
  const skip = new Set<number>();
  args.forEach((arg, index) => {
    if (arg === "--out" || arg === "--port" || arg === "--model") skip.add(index + 1);
  });
  return args.find((arg, index) => !arg.startsWith("--") && !skip.has(index));
}

if (isMain()) {
  cli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
