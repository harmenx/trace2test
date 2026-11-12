import type { FinalAssertion, MatchMode, NormalizedTrace, TestCase, ToolExpectation } from "../schema.js";
import { isRecord } from "../util.js";

const STOPWORDS = new Set([
  "The", "This", "That", "There", "Then", "With", "From", "Your", "What", "When",
  "Where", "Have", "Will", "Would", "Could", "Should", "And", "But", "For", "You",
  "Are", "Was", "Were", "His", "Her", "Its", "Our", "Can", "May", "Did", "Does",
  "Not", "Yes", "She", "They", "Them", "Just", "Into", "Over", "After", "Before",
]);

export function traceToTestCase(trace: NormalizedTrace, options?: { judge?: boolean }): TestCase {
  const name = displayName(trace);
  const finalAnswer = inferFinalAnswer(trace.finalOutput);
  const expected = trace.toolExchanges.map((exchange) => expectation(exchange.name, exchange.arguments));
  const test: TestCase = {
    version: 1,
    id: name.slug,
    name: name.title,
    source: {
      format: trace.source,
      id: trace.id,
      ...(trace.originFile ? { file: trace.originFile } : {}),
    },
    recorded: {
      ...(trace.model ? { model: trace.model } : {}),
      ...(trace.provider ? { provider: trace.provider } : {}),
      ...(trace.startedAt ? { startedAt: trace.startedAt } : {}),
      ...(trace.durationMs !== undefined ? { durationMs: trace.durationMs } : {}),
      ...(trace.usage ? { usage: trace.usage } : {}),
    },
    input: {
      messages: trace.inputMessages,
      tools: trace.tools,
    },
    fixtures: trace.toolExchanges.map((exchange) => {
      const key = expectation(exchange.name, exchange.arguments);
      return {
        ...(exchange.id ? { id: exchange.id } : {}),
        name: exchange.name,
        arguments: key.arguments,
        result: exchange.result,
        match: key.match,
      };
    }),
    assertions: {
      toolSequence: {
        mode: "ordered",
        expected,
      },
      finalAnswer,
      judge: {
        enabled: options?.judge ?? false,
        rubric: inferRubric(trace),
        minScore: 0.7,
      },
    },
  };
  return test;
}

function displayName(trace: NormalizedTrace): { title: string; slug: string } {
  const user = [...trace.inputMessages].reverse().find((message) => message.role === "user")?.content?.trim();
  const title = trace.name && !isGeneric(trace.name) ? trace.name : user || trace.id;
  const compact = title.replace(/\s+/g, " ").trim();
  return {
    title: compact.length > 80 ? `${compact.slice(0, 77)}...` : compact,
    slug: slugFrom(compact || trace.id),
  };
}

function isGeneric(name: string): boolean {
  return /^(chat|generate_content|text_completion|openai\.chat)\b/i.test(name.trim());
}

function slugFrom(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "trace";
}

function expectation(name: string, args: unknown): ToolExpectation {
  const pruned = pruneArgs(args);
  const empty = isRecord(pruned) && Object.keys(pruned).length === 0;
  const match: MatchMode = empty ? "any" : "subset";
  return {
    name,
    arguments: empty ? {} : pruned,
    match,
  };
}

function pruneArgs(value: unknown): unknown {
  if (typeof value === "string") return value.length > 120 ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => pruneArgs(item)).filter((item) => item !== undefined);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const next = pruneArgs(child);
      if (next !== undefined) out[key] = next;
    }
    return out;
  }
  return undefined;
}

export function inferFinalAnswer(output: string | null): FinalAssertion[] {
  if (output === null || output.trim() === "") return [];
  const parsed = parseJsonOutput(output);
  if (parsed !== undefined) {
    return [{ type: "json-schema", schema: inferSchema(parsed) }];
  }
  const facts = salientFacts(output).slice(0, 5);
  if (facts.length > 0) return facts.map(factToAssertion);
  if (output.trim().length <= 40) return [{ type: "exact", value: output.trim() }];
  const sentence = output.trim().split(/(?<=[.!?])\s/)[0]?.trim() ?? output.trim();
  const snippet = sentence.length > 120 ? sentence.slice(0, 120) : sentence;
  return [{ type: "contains", value: snippet }];
}

function factToAssertion(fact: string): FinalAssertion {
  if (/[°$€£%]/.test(fact) || (/\d/.test(fact) && /[A-Za-z]/.test(fact))) {
    return { type: "regex", pattern: flexiblePattern(fact), flags: "i" };
  }
  return { type: "contains", value: fact };
}

function flexiblePattern(fact: string): string {
  return fact
    .trim()
    .split(/\s+/)
    .map((part) => escapeRegExp(part).replaceAll("°", "\\s*°\\s*"))
    .join("\\s*");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function salientFacts(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /[$€£]\d+(?:[.,]\d{2})?/g,
    /\d+(?:[.,]\d+)?\s?°\s?[CF]\b/gi,
    /\d+(?:[.,]\d+)?%/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const fact = match[0]?.replace(/\s+/g, "");
      if (fact) found.push(fact);
    }
  }
  for (const match of text.matchAll(/\b[A-Z]{2,}\b/g)) {
    const token = match[0];
    if (token && !STOPWORDS.has(token)) found.push(token);
  }
  for (const match of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (!token || STOPWORDS.has(token) || isSentenceStart(text, index)) continue;
    found.push(token);
  }
  const unique: string[] = [];
  for (const fact of found) {
    if (unique.some((existing) => existing === fact || existing.includes(fact))) continue;
    const covered = unique.findIndex((existing) => fact.includes(existing) && fact !== existing);
    if (covered >= 0) unique.splice(covered, 1, fact);
    else unique.push(fact);
  }
  return unique;
}

function isSentenceStart(text: string, index: number): boolean {
  const previous = text.slice(0, index).trimEnd();
  return previous === "" || /[.!?]$/.test(previous);
}

function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value && typeof value === "object") return value;
  } catch {
    return undefined;
  }
  return undefined;
}

export function inferSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: "array" };
    const first = value[0];
    if (value.every((item) => typeof item === typeof first)) {
      return { type: "array", minItems: 1, items: inferSchema(first) };
    }
    return { type: "array", minItems: 1 };
  }
  if (isRecord(value)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      properties[key] = inferSchema(child);
      required.push(key);
    }
    return { type: "object", additionalProperties: true, required, properties };
  }
  if (typeof value === "string") return stringSchema(value);
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number", const: value };
  if (typeof value === "boolean") return { type: "boolean", const: value };
  return {};
}

function stringSchema(value: string): Record<string, unknown> {
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  if (value.length <= 80 && words <= 8) return { type: "string", const: value };
  return { type: "string" };
}

function inferRubric(trace: NormalizedTrace): string {
  const user = [...trace.inputMessages].reverse().find((message) => message.role === "user")?.content?.trim();
  const tools = trace.toolExchanges
    .map((exchange) => `${exchange.name}(${summarize(exchange.arguments)})`)
    .join("; ");
  const facts = salientFacts(trace.finalOutput ?? "").slice(0, 6);
  return [
    `The assistant was asked: ${user || "(no user message recorded)"}`,
    tools
      ? `It should take the same kind of action as the recording: ${tools}.`
      : "It should answer directly, without calling tools.",
    facts.length > 0
      ? `The answer should stay consistent with the recorded outcome, including: ${facts.join(", ")}.`
      : "The answer should stay consistent with the recorded outcome.",
    "Wording can differ. The facts, the tool choice, and whether the request was answered cannot.",
  ].join("\n");
}

function summarize(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  return Object.entries(value)
    .map(([key, child]) => `${key}=${JSON.stringify(child)}`)
    .join(", ");
}
