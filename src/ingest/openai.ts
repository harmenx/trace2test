import { Trace2TestError } from "../errors.js";
import {
  exchangesFromMessages,
  finalAssistantText,
  mergeTools,
  messagesFromUnknown,
  outputToMessage,
  promptPrefix,
  readToolDefinitions,
} from "../messages.js";
import { parseTrace, type Message, type NormalizedTrace, type TokenUsage } from "../schema.js";
import { addUsage, isRecord, numberOf, parseJsonText, stringOf } from "../util.js";

interface Turn {
  traceId?: string;
  name?: string;
  timestamp?: string;
  latencyMs?: number;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  line: number;
}

export function ingestOpenAI(text: string, originFile: string): NormalizedTrace[] {
  const turns = parseTurns(text, originFile);
  if (turns.length === 0) {
    throw new Trace2TestError(`${originFile} did not contain any request/response pairs.`);
  }
  const groups = new Map<string, Turn[]>();
  for (const turn of turns) {
    const id = turn.traceId ?? originFile;
    const group = groups.get(id) ?? [];
    group.push(turn);
    groups.set(id, group);
  }
  return [...groups.entries()].map(([id, group]) => sessionToTrace(id, sortTurns(group), originFile));
}

function parseTurns(text: string, originFile: string): Turn[] {
  const trimmed = text.trim();
  if (!isJsonLines(trimmed)) {
    const data = parseJsonText(trimmed, originFile);
    const entries = Array.isArray(data) ? data : [data];
    return entries.map((entry, index) => parseTurn(entry, originFile, index + 1));
  }
  const turns: Turn[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "") continue;
    let data: unknown;
    try {
      data = JSON.parse(line) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Trace2TestError(`${originFile}:${index + 1} is not valid JSON: ${message}`);
    }
    turns.push(parseTurn(data, originFile, index + 1));
  }
  return turns;
}

function isJsonLines(text: string): boolean {
  const newline = text.indexOf("\n");
  if (newline === -1) return false;
  const first = text.slice(0, newline).trim();
  if (!first.startsWith("{") && !first.startsWith("[")) return false;
  try {
    JSON.parse(first);
    return true;
  } catch {
    return false;
  }
}

function parseTurn(value: unknown, file: string, line: number): Turn {
  if (!isRecord(value)) {
    throw new Trace2TestError(`${file}:${line} is not an object.`);
  }
  const request = isRecord(value.request) ? value.request : isRecord(value.body) ? value.body : undefined;
  const response = isRecord(value.response) ? value.response : isRecord(value.completion) ? value.completion : undefined;
  if (!request || !response) {
    throw new Trace2TestError(`${file}:${line} needs request and response objects.`);
  }
  return {
    ...(stringOf(value.trace_id ?? value.traceId ?? value.session_id ?? value.sessionId)
      ? { traceId: stringOf(value.trace_id ?? value.traceId ?? value.session_id ?? value.sessionId) }
      : {}),
    ...(stringOf(value.name) ? { name: stringOf(value.name) } : {}),
    ...(stringOf(value.timestamp ?? value.time) ? { timestamp: stringOf(value.timestamp ?? value.time) } : {}),
    ...(numberOf(value.latency_ms ?? value.latencyMs) !== undefined
      ? { latencyMs: numberOf(value.latency_ms ?? value.latencyMs) }
      : {}),
    request,
    response,
    line,
  };
}

function sortTurns(turns: Turn[]): Turn[] {
  return [...turns].sort((left, right) => {
    const a = left.timestamp ? Date.parse(left.timestamp) : Number.NaN;
    const b = right.timestamp ? Date.parse(right.timestamp) : Number.NaN;
    if (Number.isNaN(a) || Number.isNaN(b)) return left.line - right.line;
    return a - b || left.line - right.line;
  });
}

function sessionToTrace(id: string, turns: Turn[], originFile: string): NormalizedTrace {
  const first = turns[0];
  if (!first) {
    throw new Trace2TestError(`${originFile} produced an empty session.`);
  }
  let messages: Message[] = messagesFromUnknown(first.request.messages) ?? [];
  const input = [...messages];
  let usage: TokenUsage | undefined;
  for (const turn of turns) {
    const requestMessages = messagesFromUnknown(turn.request.messages);
    if (requestMessages && requestMessages.length >= messages.length) messages = [...requestMessages];
    const response = outputToMessage(turn.response);
    if (response) messages.push(response);
    usage = addUsage(usage, usageOf(turn.response));
  }

  const last = turns.at(-1) ?? first;
  const model = stringOf(last.response.model) ?? stringOf(last.request.model) ?? stringOf(first.request.model);
  const latency = turns.reduce((sum, turn) => sum + (turn.latencyMs ?? 0), 0);
  const hasLatency = turns.some((turn) => turn.latencyMs !== undefined);
  const started = turns.find((turn) => turn.timestamp)?.timestamp;
  const ended = [...turns].reverse().find((turn) => turn.timestamp)?.timestamp;
  const wall = started && ended ? Date.parse(ended) - Date.parse(started) : undefined;

  const name = turns.map((turn) => turn.name).find((value) => value !== undefined);
  return parseTrace({
    id,
    source: "openai",
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    provider: "openai",
    ...(started ? { startedAt: started } : {}),
    ...(ended ? { endedAt: ended } : {}),
    ...(hasLatency ? { durationMs: latency } : wall !== undefined && Number.isFinite(wall) ? { durationMs: Math.max(0, Math.round(wall)) } : {}),
    ...(usage ? { usage } : {}),
    inputMessages: input.length > 0 ? input : promptPrefix(messages),
    messages,
    tools: mergeTools(turns.map((turn) => readToolDefinitions(turn.request.tools))),
    toolExchanges: exchangesFromMessages(messages),
    finalOutput: finalAssistantText(messages),
    originFile,
  });
}

function usageOf(response: Record<string, unknown>): TokenUsage | undefined {
  const usage = isRecord(response.usage) ? response.usage : {};
  const inputTokens = numberOf(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = numberOf(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberOf(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}
