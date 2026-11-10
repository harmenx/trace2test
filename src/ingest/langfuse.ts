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
import { parseTrace, type Message, type NormalizedTrace, type TokenUsage, type ToolDefinition, type ToolExchange } from "../schema.js";
import { addUsage, firstNumber, isRecord, parseMaybeJson, stringOf } from "../util.js";

export function ingestLangfuse(data: unknown, originFile: string): NormalizedTrace[] {
  const bundles = collectBundles(data);
  if (bundles.length === 0) {
    throw new Trace2TestError(`${originFile} is not a Langfuse trace export.`);
  }
  const traces = bundles.map((bundle, index) => bundleToTrace(bundle, originFile, index));
  if (traces.length === 0) {
    throw new Trace2TestError(`${originFile} did not contain any Langfuse observations.`);
  }
  return traces;
}

interface Bundle {
  trace: Record<string, unknown>;
  observations: Record<string, unknown>[];
}

function collectBundles(data: unknown): Bundle[] {
  if (Array.isArray(data)) return data.flatMap((entry) => collectBundles(entry));
  if (!isRecord(data)) return [];
  const wrappedObservations = data.observations ?? data.observations_v2;
  if (isRecord(data.trace) && Array.isArray(wrappedObservations)) {
    return [{ trace: data.trace, observations: wrappedObservations.filter(isRecord) }];
  }
  if (Array.isArray(wrappedObservations)) {
    return [{ trace: data, observations: wrappedObservations.filter(isRecord) }];
  }
  if (isLangfuseObservation(data)) return [];
  return [];
}

function isLangfuseObservation(value: Record<string, unknown>): boolean {
  const type = stringOf(value.type)?.toUpperCase();
  return type === "GENERATION" || type === "TOOL" || type === "SPAN" || type === "AGENT";
}

function bundleToTrace(bundle: Bundle, originFile: string, index: number): NormalizedTrace {
  const observations = [...bundle.observations].sort(byStart);
  const generations = observations.filter((observation) => typeOf(observation) === "GENERATION");
  const toolObservations = observations.filter((observation) => typeOf(observation) === "TOOL");
  if (generations.length === 0 && toolObservations.length === 0 && bundle.trace.input === undefined) {
    throw new Trace2TestError(`${originFile} has a Langfuse trace with no generations.`);
  }

  const stitched = stitchGenerations(generations, bundle.trace);
  const exchanges = mergeToolObservations(exchangesFromMessages(stitched.messages), toolObservations);
  const usage = generations.reduce<TokenUsage | undefined>((sum, observation) => addUsage(sum, usageOf(observation)), undefined);
  const model = [...generations].reverse().map((observation) => modelOf(observation)).find((value) => value !== undefined);
  const id = stringOf(bundle.trace.id) ?? stringOf(generations[0]?.traceId) ?? stringOf(generations[0]?.trace_id) ?? `langfuse-${index + 1}`;
  const name = stringOf(bundle.trace.name);
  const started = stringOf(bundle.trace.timestamp) ?? timeOf(observations[0]);
  const ended = timeOf(observations.at(-1), "end") ?? started;
  const duration = durationMs(started, ended);

  return parseTrace({
    id,
    source: "langfuse",
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(stringOf(bundle.trace.provider) ? { provider: stringOf(bundle.trace.provider) } : {}),
    ...(started ? { startedAt: started } : {}),
    ...(ended ? { endedAt: ended } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(usage ? { usage } : {}),
    inputMessages: stitched.input,
    messages: stitched.messages,
    tools: toolsFrom(generations),
    toolExchanges: exchanges,
    finalOutput: finalAssistantText(stitched.messages),
    originFile,
  });
}

function stitchGenerations(
  generations: Record<string, unknown>[],
  trace: Record<string, unknown>,
): { input: Message[]; messages: Message[] } {
  if (generations.length === 0) {
    const input = messagesFromUnknown(trace.input) ?? [];
    const output = outputToMessage(trace.output);
    return { input, messages: output ? [...input, output] : input };
  }

  const firstInput = messagesFromUnknown(generations[0]?.input) ?? messagesFromUnknown(trace.input) ?? [];
  const last = generations.at(-1);
  const lastInput = last ? messagesFromUnknown(last.input) : null;
  const lastOutput = last ? outputToMessage(last.output) : null;
  if (lastInput && lastInput.length > 0) {
    const messages = lastOutput ? [...lastInput, lastOutput] : [...lastInput];
    return { input: firstInput.length > 0 ? firstInput : promptPrefix(messages), messages };
  }

  const messages = [...firstInput];
  for (const generation of generations) {
    const output = outputToMessage(generation.output);
    if (output) messages.push(output);
  }
  return { input: firstInput.length > 0 ? firstInput : promptPrefix(messages), messages };
}

function mergeToolObservations(exchanges: ToolExchange[], observations: Record<string, unknown>[]): ToolExchange[] {
  const used = new Set<string>();
  for (const observation of observations) {
    const name = stringOf(observation.name) ?? "tool";
    const id = stringOf(observation.id) ?? `tool_${exchanges.length + 1}`;
    const result = observation.output === undefined ? null : parseMaybeJson(observation.output);
    const args = unwrapArgs(observation.input);
    const byId = exchanges.find((exchange) => exchange.id === id);
    if (byId) {
      if (byId.result == null) byId.result = result;
      used.add(byId.id);
      continue;
    }
    const byName = exchanges.find((exchange) => exchange.name === name && !used.has(exchange.id));
    if (byName) {
      if (byName.result == null) byName.result = result;
      if (byName.arguments == null || (isRecord(byName.arguments) && Object.keys(byName.arguments).length === 0)) {
        byName.arguments = args;
      }
      used.add(byName.id);
      continue;
    }
    const created: ToolExchange = { id, name, arguments: args, result };
    exchanges.push(created);
    used.add(id);
  }
  return exchanges;
}

function unwrapArgs(value: unknown): unknown {
  const parsed = parseMaybeJson(value);
  if (isRecord(parsed) && isRecord(parsed.args) && Object.keys(parsed).length === 1) return parsed.args;
  if (isRecord(parsed) && isRecord(parsed.arguments) && Object.keys(parsed).length === 1) return parsed.arguments;
  return parsed ?? {};
}

function toolsFrom(generations: Record<string, unknown>[]): ToolDefinition[] {
  return mergeTools(generations.map((generation) => {
    const input = parseMaybeJson(generation.input);
    const fromInput = isRecord(input) ? readToolDefinitions(input.tools) : [];
    const declared = readToolDefinitions(generation.toolDefinitions ?? generation.tool_definitions);
    return [...fromInput, ...declared];
  }));
}

function usageOf(observation: Record<string, unknown>): TokenUsage | undefined {
  const usage = isRecord(observation.usage) ? observation.usage : {};
  const details = isRecord(observation.usageDetails)
    ? observation.usageDetails
    : isRecord(observation.usage_details)
      ? observation.usage_details
      : {};
  const inputTokens = firstNumber([
    usage.promptTokens,
    usage.prompt_tokens,
    usage.input,
    details.input,
    observation.promptTokens,
  ]);
  const outputTokens = firstNumber([
    usage.completionTokens,
    usage.completion_tokens,
    usage.output,
    details.output,
    observation.completionTokens,
  ]);
  const totalTokens = firstNumber([usage.totalTokens, usage.total_tokens, usage.total, details.total, observation.totalTokens]);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

function modelOf(observation: Record<string, unknown>): string | undefined {
  return stringOf(observation.model ?? observation.providedModelName ?? observation.provided_model_name);
}

function typeOf(observation: Record<string, unknown>): string {
  return stringOf(observation.type)?.toUpperCase() ?? "";
}

function byStart(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const a = Date.parse(timeOf(left) ?? "");
  const b = Date.parse(timeOf(right) ?? "");
  if (Number.isNaN(a) && Number.isNaN(b)) return 0;
  if (Number.isNaN(a)) return 1;
  if (Number.isNaN(b)) return -1;
  return a - b;
}

function timeOf(observation: Record<string, unknown> | undefined, which: "start" | "end" = "start"): string | undefined {
  if (!observation) return undefined;
  if (which === "end") return stringOf(observation.endTime ?? observation.end_time);
  return stringOf(observation.startTime ?? observation.start_time ?? observation.timestamp);
}

function durationMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const delta = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(delta) || delta < 0) return undefined;
  return Math.round(delta);
}
