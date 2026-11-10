import type { Message, Role, ToolCall, ToolDefinition, ToolExchange } from "./schema.js";
import { isRecord, parseMaybeJson } from "./util.js";

const ROLES = new Set<Role>(["system", "user", "assistant", "tool"]);

export function normalizeRole(value: unknown): Role | undefined {
  if (typeof value !== "string") return undefined;
  const role = value.toLowerCase();
  if (role === "developer") return "system";
  return ROLES.has(role as Role) ? (role as Role) : undefined;
}

export function messageText(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") return String(content);
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (part.type === "text" && typeof part.content === "string") return part.content;
        return "";
      })
      .filter((part) => part !== "");
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (isRecord(content)) return JSON.stringify(content);
  return String(content);
}

export function fromOpenAIMessage(raw: unknown): Message | null {
  if (!isRecord(raw)) return null;
  const role = normalizeRole(raw.role);
  if (!role) return null;
  if (Array.isArray(raw.parts)) return fromParts(role, raw);

  const toolCalls = readToolCalls(raw.tool_calls ?? raw.toolCalls);
  const message: Message = { role, content: messageText(raw.content) };
  if (typeof raw.name === "string") message.name = raw.name;
  const toolCallId = raw.tool_call_id ?? raw.toolCallId;
  if (typeof toolCallId === "string") message.toolCallId = toolCallId;
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return message;
}

function fromParts(role: Role, raw: Record<string, unknown>): Message {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let toolCallId: string | undefined;
  for (const part of Array.isArray(raw.parts) ? raw.parts : []) {
    if (!isRecord(part)) continue;
    if (part.type === "text" || (part.type === undefined && typeof part.content === "string")) {
      texts.push(String(part.content ?? ""));
    } else if (part.type === "tool_call") {
      toolCalls.push({
        id: typeof part.id === "string" ? part.id : `call_${toolCalls.length}`,
        name: typeof part.name === "string" ? part.name : "unknown",
        arguments: parseMaybeJson(part.arguments ?? {}),
      });
    } else if (part.type === "tool_call_response") {
      if (typeof part.id === "string") toolCallId = part.id;
      if (part.response !== undefined) {
        texts.push(typeof part.response === "string" ? part.response : JSON.stringify(part.response));
      }
    }
  }
  const message: Message = { role, content: texts.length > 0 ? texts.join("\n") : null };
  if (typeof raw.name === "string") message.name = raw.name;
  if (toolCallId) message.toolCallId = toolCallId;
  if (toolCalls.length > 0) message.toolCalls = toolCalls;
  return message;
}

function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const fn = isRecord(entry.function) ? entry.function : entry;
    const name = typeof fn.name === "string" ? fn.name : undefined;
    if (!name) continue;
    calls.push({
      id: typeof entry.id === "string" ? entry.id : `call_${calls.length}`,
      name,
      arguments: parseMaybeJson(fn.arguments ?? entry.arguments ?? {}),
    });
  }
  return calls;
}

export function parseToolDefinition(raw: unknown): ToolDefinition | null {
  if (!isRecord(raw)) return null;
  const fn = isRecord(raw.function) ? raw.function : raw;
  const name = typeof fn.name === "string" ? fn.name : typeof raw.name === "string" ? raw.name : undefined;
  if (!name) return null;
  const tool: ToolDefinition = { name };
  const description = fn.description ?? raw.description;
  if (typeof description === "string") tool.description = description;
  const parameters = fn.parameters ?? raw.parameters;
  if (isRecord(parameters)) tool.parameters = parameters;
  return tool;
}

export function readToolDefinitions(value: unknown): ToolDefinition[] {
  const parsed = parseMaybeJson(value);
  if (!Array.isArray(parsed)) return [];
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const tool = parseToolDefinition(entry);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
}

export function messagesFromUnknown(value: unknown): Message[] | null {
  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  if (typeof parsed === "string" && parsed.trim() !== "") {
    return [{ role: "user", content: parsed }];
  }
  if (Array.isArray(parsed)) {
    const messages = parsed.map((entry) => fromOpenAIMessage(entry)).filter((entry): entry is Message => entry !== null);
    return messages.length > 0 ? messages : null;
  }
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.messages)) return messagesFromUnknown(parsed.messages);
  if (parsed.role) {
    const message = fromOpenAIMessage(parsed);
    return message ? [message] : null;
  }
  return null;
}

export function outputToMessage(value: unknown): Message | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const interpreted = interpretOutput(JSON.parse(trimmed) as unknown);
        if (interpreted) return interpreted;
      } catch {
        // A string that merely looks like JSON is still assistant text.
      }
    }
    return { role: "assistant", content: value };
  }
  return interpretOutput(value);
}

function interpretOutput(value: unknown): Message | null {
  if (typeof value === "string") return { role: "assistant", content: value };
  if (Array.isArray(value)) {
    const messages = value.map((entry) => fromOpenAIMessage(entry)).filter((entry): entry is Message => entry !== null);
    if (messages.length > 0) return messages.find((message) => message.role === "assistant") ?? messages.at(-1) ?? null;
    return { role: "assistant", content: JSON.stringify(value) };
  }
  if (!isRecord(value)) return null;
  if (Array.isArray(value.choices)) {
    const choice = value.choices[0];
    if (isRecord(choice)) return fromOpenAIMessage(choice.message);
    return null;
  }
  if (value.role || value.tool_calls || value.toolCalls || "content" in value || Array.isArray(value.parts)) {
    return fromOpenAIMessage({ role: value.role ?? "assistant", ...value });
  }
  return { role: "assistant", content: JSON.stringify(value) };
}

export function exchangesFromMessages(messages: Message[]): ToolExchange[] {
  const results = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      results.set(message.toolCallId, parseMaybeJson(message.content));
    }
  }
  const exchanges: ToolExchange[] = [];
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      exchanges.push({
        id: call.id,
        name: call.name,
        arguments: parseMaybeJson(call.arguments),
        result: results.has(call.id) ? (results.get(call.id) ?? null) : null,
      });
    }
  }
  return exchanges;
}

export function finalAssistantText(messages: Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && !(message.toolCalls && message.toolCalls.length > 0)) {
      return message.content;
    }
  }
  return null;
}

export function promptPrefix(messages: Message[]): Message[] {
  const index = messages.findIndex((message) => message.role === "assistant");
  return index === -1 ? [...messages] : messages.slice(0, index);
}

export function mergeTools(groups: ToolDefinition[][]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const tool of group) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}
