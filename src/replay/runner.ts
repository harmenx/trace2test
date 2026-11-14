import type { Message, SuiteResult, TestCase, TestResult, TokenUsage } from "../schema.js";
import { emptyUsage, jsonText } from "../util.js";
import type { ModelClient } from "./client.js";
import { estimateCost, type PriceTable } from "./pricing.js";
import { scoreFinalAnswer, scoreToolSequence, takeFixture, type CalledTool } from "./score.js";

export interface RunOptions {
  tests: TestCase[];
  model: string;
  client: ModelClient;
  prices: PriceTable;
  judge?: boolean;
  judgeModel?: string;
  maxSteps?: number;
  now?: Date;
  baseUrl?: string;
}

const JUDGE_SYSTEM = [
  "You grade one assistant reply against a rubric.",
  'Return only JSON of the form {"score": <number from 0 to 1>, "reason": "<one sentence>"}.',
].join(" ");

export async function runSuite(options: RunOptions): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  for (const test of options.tests) {
    tests.push(await runOne(test, options));
  }
  return {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    model: options.model,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    summary: summarize(tests),
    tests,
  };
}

async function runOne(test: TestCase, options: RunOptions): Promise<TestResult> {
  const started = performance.now();
  try {
    return await replay(test, options, started);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: test.id,
      name: test.name,
      status: "error",
      model: options.model,
      latencyMs: Math.round(performance.now() - started),
      usage: emptyUsage(),
      costUsd: null,
      toolSequence: {
        mode: test.assertions.toolSequence.mode,
        similarity: 0,
        passed: false,
        expected: test.assertions.toolSequence.expected.map((call) => ({
          name: call.name,
          arguments: call.arguments ?? {},
        })),
        actual: [],
      },
      assertions: [{ name: "runner", kind: "runner", status: "fail", detail: message }],
      finalOutput: null,
      error: message,
      transcript: test.input.messages,
    };
  }
}

async function replay(test: TestCase, options: RunOptions, started: number): Promise<TestResult> {
  const messages: Message[] = test.input.messages.map((message) => ({ ...message }));
  const used = new Set<number>();
  const actual: CalledTool[] = [];
  const fixtureMisses: string[] = [];
  const usage = emptyUsage();
  let finalOutput: string | null = null;
  let exhausted = false;
  const maxSteps = options.maxSteps ?? 8;

  for (let step = 0; step < maxSteps; step += 1) {
    const response = await options.client.complete({
      model: options.model,
      messages,
      tools: test.input.tools,
      temperature: 0,
    });
    add(usage, response.usage);
    messages.push(response.message);
    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      finalOutput = response.message.content;
      break;
    }
    for (const call of calls) {
      const called: CalledTool = { name: call.name, arguments: call.arguments ?? {} };
      actual.push(called);
      const fixture = takeFixture(test.fixtures, called, used);
      if (!fixture) {
        fixtureMisses.push(`${call.name}(${JSON.stringify(called.arguments)})`);
      }
      const result = fixture ? fixture.result : { error: `No fixture matched ${call.name}` };
      messages.push({
        role: "tool",
        name: call.name,
        toolCallId: call.id,
        content: jsonText(result),
      });
    }
    if (step === maxSteps - 1) exhausted = true;
  }

  const toolScore = scoreToolSequence(test, actual);
  const assertions = [
    toolScore.assertion,
    ...fixtureMisses.map((miss) => ({
      name: "fixture",
      kind: "fixture" as const,
      status: "fail" as const,
      detail: `no fixture matched ${miss}`,
    })),
    ...(exhausted
      ? [{
          name: "runner",
          kind: "runner" as const,
          status: "fail" as const,
          detail: `stopped after ${maxSteps} model calls without a final answer`,
        }]
      : []),
    ...scoreFinalAnswer(finalOutput, test.assertions.finalAnswer),
  ];

  const rubric = test.assertions.judge;
  if (rubric?.rubric && (options.judge || rubric.enabled)) {
    assertions.push(await judge(test, finalOutput, options, usage));
  } else if (rubric?.rubric) {
    assertions.push({
      name: "llm judge",
      kind: "judge",
      status: "skipped",
      detail: "rubric present; pass --judge to score it",
    });
  }

  const failed = assertions.some((assertion) => assertion.status === "fail");
  const costUsd = estimateCost(options.model, usage, options.prices);
  return {
    id: test.id,
    name: test.name,
    status: failed ? "fail" : "pass",
    model: options.model,
    latencyMs: Math.round(performance.now() - started),
    usage,
    costUsd,
    toolSequence: {
      mode: toolScore.mode,
      similarity: toolScore.similarity,
      passed: toolScore.passed,
      expected: toolScore.expected,
      actual: toolScore.actual,
    },
    assertions,
    finalOutput,
    transcript: messages,
  };
}

async function judge(
  test: TestCase,
  output: string | null,
  options: RunOptions,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number },
): Promise<TestResult["assertions"][number]> {
  const rubric = test.assertions.judge?.rubric ?? "";
  const minScore = test.assertions.judge?.minScore ?? 0.7;
  if (output === null) {
    return { name: "llm judge", kind: "judge", status: "fail", detail: "no final answer to judge" };
  }
  const response = await options.client.complete({
    model: options.judgeModel ?? options.model,
    temperature: 0,
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: `Rubric:\n${rubric}\n\nAssistant reply:\n${output}` },
    ],
  });
  add(usage, response.usage);
  const text = response.message.content ?? "";
  const parsed = extractScore(text);
  if (!parsed) {
    return { name: "llm judge", kind: "judge", status: "fail", detail: "judge did not return a score" };
  }
  const passed = parsed.score >= minScore;
  return {
    name: "llm judge",
    kind: "judge",
    status: passed ? "pass" : "fail",
    detail: `score ${parsed.score.toFixed(2)} / ${minScore.toFixed(2)}${parsed.reason ? `: ${parsed.reason}` : ""}`,
  };
}

function extractScore(text: string): { score: number; reason?: string } | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const value = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!value || typeof value !== "object" || !("score" in value)) return undefined;
    const score = (value as { score: unknown }).score;
    if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
    const reason = (value as { reason?: unknown }).reason;
    return { score: Math.min(1, Math.max(0, score)), ...(typeof reason === "string" ? { reason } : {}) };
  } catch {
    return undefined;
  }
}

function add(target: { inputTokens: number; outputTokens: number; totalTokens: number }, extra: TokenUsage | undefined): void {
  target.inputTokens += extra?.inputTokens ?? 0;
  target.outputTokens += extra?.outputTokens ?? 0;
  target.totalTokens += extra?.totalTokens ?? (extra?.inputTokens ?? 0) + (extra?.outputTokens ?? 0);
}

export function summarize(tests: TestResult[]): SuiteResult["summary"] {
  const failed = tests.filter((test) => test.status === "fail").length;
  const errors = tests.filter((test) => test.status === "error").length;
  const priced = tests.some((test) => (test.usage.inputTokens > 0 || test.usage.outputTokens > 0) && test.costUsd === null);
  const cost = tests.reduce((sum, test) => sum + (test.costUsd ?? 0), 0);
  return {
    total: tests.length,
    passed: tests.filter((test) => test.status === "pass").length,
    failed,
    errors,
    latencyMs: tests.reduce((sum, test) => sum + test.latencyMs, 0),
    costUsd: priced ? null : round(cost),
    inputTokens: tests.reduce((sum, test) => sum + test.usage.inputTokens, 0),
    outputTokens: tests.reduce((sum, test) => sum + test.usage.outputTokens, 0),
  };
}

function round(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
