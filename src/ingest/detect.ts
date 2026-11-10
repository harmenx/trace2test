import { Trace2TestError } from "../errors.js";
import type { TraceFormat } from "../schema.js";
import { isRecord } from "../util.js";

export function detectFormat(data: unknown, file: string): TraceFormat {
  if (file.toLowerCase().endsWith(".jsonl")) return "openai";
  if (Array.isArray(data)) {
    const first = data[0];
    if (isRecord(first)) {
      if (isRecord(first.request) && isRecord(first.response)) return "openai";
      if (looksLikeSpan(first)) return "otel";
      if (looksLikeLangfuse(first)) return "langfuse";
    }
  }
  if (!isRecord(data)) {
    throw new Trace2TestError(`Could not detect a trace format for ${file}. Pass --format otel|langfuse|openai.`);
  }
  if (data.resourceSpans || data.resource_spans || (Array.isArray(data.spans) && data.spans.some(looksLikeSpan))) {
    return "otel";
  }
  if (looksLikeSpan(data)) return "otel";
  if (Array.isArray(data.observations) || Array.isArray(data.observations_v2) || (isRecord(data.trace) && Array.isArray(data.observations))) {
    return "langfuse";
  }
  if (isRecord(data.request) && isRecord(data.response)) return "openai";
  if (typeof data.id === "string" && ("input" in data || "output" in data) && !("attributes" in data)) return "langfuse";
  throw new Trace2TestError(`Could not detect a trace format for ${file}. Pass --format otel|langfuse|openai.`);
}

function looksLikeSpan(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const attributes = value.attributes;
  if (Array.isArray(attributes)) {
    return attributes.some((entry) => isRecord(entry) && typeof entry.key === "string" && entry.key.startsWith("gen_ai."));
  }
  if (isRecord(attributes)) {
    return Object.keys(attributes).some((key) => key.startsWith("gen_ai."));
  }
  return false;
}

function looksLikeLangfuse(value: Record<string, unknown>): boolean {
  if (Array.isArray(value.observations)) return true;
  const type = typeof value.type === "string" ? value.type.toUpperCase() : "";
  return type === "GENERATION" || type === "TOOL" || type === "SPAN" || type === "AGENT";
}
