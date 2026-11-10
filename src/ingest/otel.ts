import {
  exchangesFromMessages,
  finalAssistantText,
  fromOpenAIMessage,
  promptPrefix,
  readToolDefinitions,
} from "../messages.js";
import { parseTrace, type Message, type NormalizedTrace, type TokenUsage, type ToolExchange } from "../schema.js";
import { Trace2TestError } from "../errors.js";
import { addUsage, asArray, isRecord, numberOf, parseMaybeJson, stringOf } from "../util.js";

interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs?: number;
  endMs?: number;
  attributes: Record<string, unknown>;
}

const INFERENCE_OPS = new Set(["chat", "generate_content", "text_completion", "realtime_inference"]);

export function ingestOtel(data: unknown, originFile: string): NormalizedTrace[] {
  const spans = flattenSpans(data);
  if (spans.length === 0) {
    throw new Trace2TestError(`${originFile} did not contain any spans.`);
  }

  const groups = new Map<string, FlatSpan[]>();
  for (const span of spans) {
    const id = span.traceId || span.spanId;
    const group = groups.get(id) ?? [];
    group.push(span);
    groups.set(id, group);
  }

  const traces: NormalizedTrace[] = [];
  for (const [id, group] of groups) {
    const trace = traceFromSpans(id, group, originFile);
    if (trace) traces.push(trace);
  }
  if (traces.length === 0) {
    throw new Trace2TestError(`${originFile} has spans, but none carry GenAI attributes (gen_ai.*).`);
  }
  return traces;
}

function traceFromSpans(id: string, spans: FlatSpan[], originFile: string): NormalizedTrace | null {
  const inference = spans.filter(isInferenceSpan).sort(byStart);
  const toolSpans = spans.filter(isToolSpan);
  if (inference.length === 0 && toolSpans.length === 0) return null;

  const messages = reconstruct(inference);
  const firstInput = inference[0] ? readMessages(inference[0], "input") : [];
  const inputMessages = firstInput.length > 0 ? firstInput : promptPrefix(messages);
  const exchanges = applyToolSpans(exchangesFromMessages(messages), toolSpans);
  const usage = inference.reduce<TokenUsage | undefined>((sum, span) => addUsage(sum, usageOf(span.attributes)), undefined);
  const start = earliest(spans);
  const end = latest(spans);
  const modelSpan = inference.at(-1);
  const name = agentName(spans, inference);

  return parseTrace({
    id,
    source: "otel",
    ...(name ? { name } : {}),
    ...(modelOf(modelSpan) ? { model: modelOf(modelSpan) } : {}),
    ...(providerOf(spans) ? { provider: providerOf(spans) } : {}),
    ...(start !== undefined ? { startedAt: new Date(start).toISOString() } : {}),
    ...(end !== undefined ? { endedAt: new Date(end).toISOString() } : {}),
    ...(start !== undefined && end !== undefined ? { durationMs: Math.max(0, Math.round(end - start)) } : {}),
    ...(usage ? { usage } : {}),
    inputMessages,
    messages,
    tools: readToolDefinitions(spans.flatMap((span) => asArray(parseMaybeJson(span.attributes["gen_ai.tool.definitions"])))),
    toolExchanges: exchanges,
    finalOutput: finalAssistantText(messages),
    originFile,
  });
}

function reconstruct(inference: FlatSpan[]): Message[] {
  const last = inference.at(-1);
  if (!last) return [];
  const input = readMessages(last, "input");
  const output = readMessages(last, "output");
  if (input.length > 0 || output.length > 0) return [...input, ...output];

  const messages: Message[] = [];
  for (const span of inference) {
    const spanInput = readMessages(span, "input");
    if (spanInput.length >= messages.length) messages.splice(0, messages.length, ...spanInput);
    messages.push(...readMessages(span, "output"));
  }
  return messages;
}

function readMessages(span: FlatSpan, side: "input" | "output"): Message[] {
  const directKey = side === "input" ? "gen_ai.input.messages" : "gen_ai.output.messages";
  const legacyKey = side === "input" ? "gen_ai.prompt" : "gen_ai.completion";
  const direct = parseMaybeJson(span.attributes[directKey] ?? span.attributes[legacyKey]);
  if (Array.isArray(direct)) {
    const messages = direct
      .map((entry) => fromOpenAIMessage(entry))
      .filter((entry): entry is Message => entry !== null);
    if (messages.length > 0) return prependSystem(messages, span, side);
  }
  const indexed = readIndexed(span.attributes, legacyKey);
  if (indexed.length > 0) return prependSystem(indexed, span, side);
  return side === "input" ? prependSystem([], span, side) : [];
}

function prependSystem(messages: Message[], span: FlatSpan, side: "input" | "output"): Message[] {
  if (side !== "input" || messages.some((message) => message.role === "system")) return messages;
  const instructions = parseMaybeJson(span.attributes["gen_ai.system_instructions"]);
  if (!Array.isArray(instructions)) return messages;
  const text = instructions
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.content === "string") return part.content;
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
  if (!text) return messages;
  return [{ role: "system", content: text }, ...messages];
}

interface IndexedCall {
  id?: string;
  name?: string;
  arguments?: unknown;
}

interface IndexedBucket {
  role?: string;
  content?: string;
  calls: Map<number, IndexedCall>;
}

function readIndexed(attributes: Record<string, unknown>, prefix: string): Message[] {
  const buckets = new Map<number, IndexedBucket>();
  const head = `${prefix}.`;
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(head)) continue;
    const rest = key.slice(head.length).split(".");
    const index = Number(rest[0]);
    if (!Number.isInteger(index)) continue;
    const bucket = buckets.get(index) ?? { calls: new Map<number, IndexedCall>() };
    buckets.set(index, bucket);
    const field = rest[1];
    if (field === "role" && typeof value === "string") bucket.role = value;
    if (field === "content") bucket.content = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    if (field !== "tool_calls") continue;
    const callIndex = Number(rest[2]);
    if (!Number.isInteger(callIndex)) continue;
    const call = bucket.calls.get(callIndex) ?? {};
    bucket.calls.set(callIndex, call);
    const leaf = rest.slice(3).join(".");
    if (leaf === "id") call.id = String(value);
    if (leaf === "name" || leaf === "function.name") call.name = String(value);
    if (leaf === "arguments" || leaf === "function.arguments") call.arguments = parseMaybeJson(value);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([index, bucket]) => {
      const role = bucket.role?.toLowerCase();
      if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") return [];
      const toolCalls = [...bucket.calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, call]) => call.name)
        .map(([callIndex, call]) => ({
          id: call.id || `call_${index}_${callIndex}`,
          name: call.name ?? "unknown",
          arguments: call.arguments ?? {},
        }));
      const message: Message = { role, content: bucket.content ?? null };
      if (toolCalls.length > 0) message.toolCalls = toolCalls;
      return [message];
    });
}

function applyToolSpans(exchanges: ToolExchange[], toolSpans: FlatSpan[]): ToolExchange[] {
  const byId = new Map(exchanges.map((exchange) => [exchange.id, exchange]));
  for (const span of [...toolSpans].sort(byStart)) {
    const id = stringAttr(span.attributes, ["gen_ai.tool.call.id"]) ?? span.spanId;
    const name = stringAttr(span.attributes, ["gen_ai.tool.name"]) ?? toolNameFromSpan(span.name);
    if (!name) continue;
    const args = parseMaybeJson(span.attributes["gen_ai.tool.call.arguments"] ?? {});
    const hasResult = "gen_ai.tool.call.result" in span.attributes;
    const result = hasResult ? parseMaybeJson(span.attributes["gen_ai.tool.call.result"]) : null;
    const existing = byId.get(id);
    if (existing) {
      if ((existing.result === null || existing.result === undefined) && hasResult) existing.result = result;
      continue;
    }
    const pending = exchanges.find((exchange) => exchange.name === name && exchange.result == null);
    if (pending && hasResult) {
      pending.result = result;
      continue;
    }
    const created: ToolExchange = { id, name, arguments: args, result };
    exchanges.push(created);
    byId.set(id, created);
  }
  return exchanges;
}

function toolNameFromSpan(name: string): string | undefined {
  const match = /^execute_tool\s+(.+)$/i.exec(name);
  return match?.[1]?.trim() || undefined;
}

function isInferenceSpan(span: FlatSpan): boolean {
  const op = stringAttr(span.attributes, ["gen_ai.operation.name"]);
  if (op === "execute_tool") return false;
  if (op && INFERENCE_OPS.has(op)) return true;
  if (span.attributes["gen_ai.input.messages"] || span.attributes["gen_ai.output.messages"]) return true;
  if (Object.keys(span.attributes).some((key) => key.startsWith("gen_ai.prompt.") || key.startsWith("gen_ai.completion."))) {
    return true;
  }
  return Boolean(span.attributes["gen_ai.request.model"] || span.attributes["gen_ai.response.model"]);
}

function isToolSpan(span: FlatSpan): boolean {
  return stringAttr(span.attributes, ["gen_ai.operation.name"]) === "execute_tool" || (
    typeof span.attributes["gen_ai.tool.name"] === "string" && !isInferenceSpan(span)
  );
}

function usageOf(attributes: Record<string, unknown>): TokenUsage | undefined {
  const inputTokens = numberAttr(attributes, ["gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"]);
  const outputTokens = numberAttr(attributes, ["gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"]);
  const totalTokens = numberAttr(attributes, ["gen_ai.usage.total_tokens"]);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function modelOf(span: FlatSpan | undefined): string | undefined {
  if (!span) return undefined;
  return stringAttr(span.attributes, ["gen_ai.response.model", "gen_ai.request.model"]);
}

function providerOf(spans: FlatSpan[]): string | undefined {
  for (const span of spans) {
    const provider = stringAttr(span.attributes, ["gen_ai.provider.name", "gen_ai.system"]);
    if (provider) return provider;
  }
  return undefined;
}

function agentName(spans: FlatSpan[], inference: FlatSpan[]): string | undefined {
  const wrapper = spans.find((span) => !isInferenceSpan(span) && !isToolSpan(span) && span.name);
  if (wrapper && !isGenericName(wrapper.name)) return wrapper.name;
  const named = inference.find((span) => span.name && !isGenericName(span.name));
  return named?.name;
}

function isGenericName(name: string): boolean {
  return /^(chat|generate_content|text_completion|openai\.chat)\b/i.test(name.trim());
}

function byStart(left: FlatSpan, right: FlatSpan): number {
  return (left.startMs ?? 0) - (right.startMs ?? 0);
}

function earliest(spans: FlatSpan[]): number | undefined {
  const times = spans.map((span) => span.startMs).filter((value): value is number => value !== undefined);
  return times.length > 0 ? Math.min(...times) : undefined;
}

function latest(spans: FlatSpan[]): number | undefined {
  const times = spans.map((span) => span.endMs).filter((value): value is number => value !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

function stringAttr(attributes: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringOf(attributes[key]);
    if (value) return value;
  }
  return undefined;
}

function numberAttr(attributes: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = numberOf(attributes[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function flattenSpans(data: unknown): FlatSpan[] {
  return collectRawSpans(data).flatMap((raw) => {
    const span = toFlatSpan(raw);
    return span ? [span] : [];
  });
}

function collectRawSpans(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];
  if (Array.isArray(data.spans)) return data.spans;
  const resources = asArray(data.resourceSpans ?? data.resource_spans);
  const spans: unknown[] = [];
  for (const resource of resources) {
    if (!isRecord(resource)) continue;
    const scopes = asArray(resource.scopeSpans ?? resource.scope_spans ?? resource.instrumentationLibrarySpans);
    for (const scope of scopes) {
      if (!isRecord(scope)) continue;
      spans.push(...asArray(scope.spans));
    }
  }
  if (spans.length > 0) return spans;
  if (looksLikeSpan(data)) return [data];
  return [];
}

function looksLikeSpan(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return "attributes" in value || "traceId" in value || "trace_id" in value || "spanId" in value;
}

function toFlatSpan(raw: unknown): FlatSpan | null {
  if (!isRecord(raw)) return null;
  const attributes = attributesToMap(raw.attributes);
  const events = asArray(raw.events).flatMap((event) => {
    if (!isRecord(event)) return [];
    return [{ name: stringOf(event.name) ?? "", attributes: attributesToMap(event.attributes) }];
  });
  foldEvents(attributes, events);
  if (!Object.keys(attributes).some((key) => key.startsWith("gen_ai."))) return null;
  const spanId = stringOf(raw.spanId ?? raw.span_id) ?? "span";
  const parent = stringOf(raw.parentSpanId ?? raw.parent_span_id);
  return {
    traceId: stringOf(raw.traceId ?? raw.trace_id) ?? spanId,
    spanId,
    ...(parent ? { parentSpanId: parent } : {}),
    name: stringOf(raw.name) ?? "span",
    ...(timeOf(raw, "start") !== undefined ? { startMs: timeOf(raw, "start") } : {}),
    ...(timeOf(raw, "end") !== undefined ? { endMs: timeOf(raw, "end") } : {}),
    attributes,
  };
}

function foldEvents(
  attributes: Record<string, unknown>,
  events: { name: string; attributes: Record<string, unknown> }[],
): void {
  const inputs: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.attributes["gen_ai.input.messages"] && attributes["gen_ai.input.messages"] === undefined) {
      attributes["gen_ai.input.messages"] = event.attributes["gen_ai.input.messages"];
    }
    if (event.attributes["gen_ai.output.messages"] && attributes["gen_ai.output.messages"] === undefined) {
      attributes["gen_ai.output.messages"] = event.attributes["gen_ai.output.messages"];
    }
    for (const [key, value] of Object.entries(event.attributes)) {
      if (key.startsWith("gen_ai.") && attributes[key] === undefined) attributes[key] = value;
    }
    const role = /^gen_ai\.(system|user|assistant|tool)\.message$/.exec(event.name)?.[1];
    if (!role) continue;
    inputs.push({
      role,
      content: event.attributes["content"] ?? event.attributes["gen_ai.message.content"] ?? null,
    });
  }
  if (attributes["gen_ai.input.messages"] === undefined && inputs.length > 0) {
    attributes["gen_ai.input.messages"] = inputs;
  }
}

function timeOf(span: Record<string, unknown>, which: "start" | "end"): number | undefined {
  const nano = span[which === "start" ? "startTimeUnixNano" : "endTimeUnixNano"]
    ?? span[which === "start" ? "start_time_unix_nano" : "end_time_unix_nano"];
  const nanos = numberOf(nano);
  if (nanos !== undefined) return nanos / 1e6;
  const iso = span[which === "start" ? "startTime" : "endTime"] ?? span[which === "start" ? "start_time" : "end_time"];
  if (typeof iso === "string") {
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return ms;
  }
  return numberOf(span[which === "start" ? "startTimeMillis" : "endTimeMillis"]);
}

function attributesToMap(attributes: unknown): Record<string, unknown> {
  if (Array.isArray(attributes)) {
    const map: Record<string, unknown> = {};
    for (const entry of attributes) {
      if (!isRecord(entry) || typeof entry.key !== "string") continue;
      map[entry.key] = decodeValue(entry.value);
    }
    return map;
  }
  if (!isRecord(attributes)) return {};
  const map: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    map[key] = looksLikeOtlpValue(value) ? decodeValue(value) : value;
  }
  return map;
}

function looksLikeOtlpValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    "stringValue" in value ||
    "string_value" in value ||
    "intValue" in value ||
    "int_value" in value ||
    "doubleValue" in value ||
    "double_value" in value ||
    "boolValue" in value ||
    "bool_value" in value ||
    "arrayValue" in value ||
    "array_value" in value ||
    "kvlistValue" in value ||
    "kvlist_value" in value
  );
}

function decodeValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("stringValue" in value || "string_value" in value) return String(value.stringValue ?? value.string_value ?? "");
  const intValue = numberOf(value.intValue ?? value.int_value);
  if ("intValue" in value || "int_value" in value) return intValue ?? 0;
  const doubleValue = numberOf(value.doubleValue ?? value.double_value);
  if ("doubleValue" in value || "double_value" in value) return doubleValue ?? 0;
  if ("boolValue" in value || "bool_value" in value) return Boolean(value.boolValue ?? value.bool_value);
  const array = value.arrayValue ?? value.array_value;
  if (isRecord(array)) return asArray(array.values).map((entry) => decodeValue(entry));
  const kv = value.kvlistValue ?? value.kvlist_value;
  if (isRecord(kv)) return attributesToMap(kv.values);
  return value;
}
