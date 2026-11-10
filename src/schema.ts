import { z } from "zod";

import { Trace2TestError } from "./errors.js";

export const TRACE_FORMATS = ["otel", "langfuse", "openai"] as const;
export type TraceFormat = (typeof TRACE_FORMATS)[number];

export const ROLES = ["system", "user", "assistant", "tool"] as const;
export type Role = (typeof ROLES)[number];

export const MATCH_MODES = ["exact", "subset", "any"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const MessageSchema = z.object({
  role: z.enum(ROLES),
  content: z.string().nullable(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(ToolCallSchema).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

export const TokenUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const ToolExchangeSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.unknown(),
  result: z.unknown(),
});
export type ToolExchange = z.infer<typeof ToolExchangeSchema>;

export const NormalizedTraceSchema = z.object({
  id: z.string().min(1),
  source: z.enum(TRACE_FORMATS),
  name: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  usage: TokenUsageSchema.optional(),
  inputMessages: z.array(MessageSchema),
  messages: z.array(MessageSchema),
  tools: z.array(ToolDefinitionSchema),
  toolExchanges: z.array(ToolExchangeSchema),
  finalOutput: z.string().nullable(),
  originFile: z.string().optional(),
});
export type NormalizedTrace = z.infer<typeof NormalizedTraceSchema>;

const ToolExpectationSchema = z.object({
  name: z.string(),
  arguments: z.unknown().optional(),
  match: z.enum(MATCH_MODES).default("subset"),
});
export type ToolExpectation = z.infer<typeof ToolExpectationSchema>;

export const FinalAssertionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exact"), value: z.string() }),
  z.object({ type: z.literal("contains"), value: z.string() }),
  z.object({
    type: z.literal("regex"),
    pattern: z.string(),
    flags: z.string().optional(),
  }),
  z.object({
    type: z.literal("json-schema"),
    schema: z.record(z.string(), z.unknown()),
  }),
]);
export type FinalAssertion = z.infer<typeof FinalAssertionSchema>;

export const TestCaseSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.object({
    format: z.enum(TRACE_FORMATS),
    id: z.string(),
    file: z.string().optional(),
  }),
  recorded: z
    .object({
      model: z.string().optional(),
      provider: z.string().optional(),
      startedAt: z.string().optional(),
      durationMs: z.number().optional(),
      usage: TokenUsageSchema.optional(),
    })
    .default({}),
  input: z.object({
    messages: z.array(MessageSchema),
    tools: z.array(ToolDefinitionSchema).default([]),
  }),
  fixtures: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        arguments: z.unknown().optional(),
        result: z.unknown(),
        match: z.enum(MATCH_MODES).default("subset"),
      }),
    )
    .default([]),
  assertions: z.object({
    toolSequence: z.object({
      mode: z.enum(["ordered", "exact"]).default("ordered"),
      expected: z.array(ToolExpectationSchema),
    }),
    finalAnswer: z.array(FinalAssertionSchema).default([]),
    judge: z
      .object({
        enabled: z.boolean().default(false),
        rubric: z.string(),
        minScore: z.number().min(0).max(1).default(0.7),
      })
      .optional(),
  }),
});
export type TestCase = z.infer<typeof TestCaseSchema>;
export type Fixture = TestCase["fixtures"][number];

export const ASSERTION_KINDS = [
  "tool-sequence",
  "exact",
  "contains",
  "regex",
  "json-schema",
  "judge",
  "fixture",
  "runner",
] as const;

export const AssertionResultSchema = z.object({
  name: z.string(),
  kind: z.enum(ASSERTION_KINDS),
  status: z.enum(["pass", "fail", "skipped"]),
  detail: z.string(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

const CalledToolSchema = z.object({
  name: z.string(),
  arguments: z.unknown(),
});

export const TestResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["pass", "fail", "error"]),
  model: z.string(),
  latencyMs: z.number().nonnegative(),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
  }),
  costUsd: z.number().nullable(),
  toolSequence: z.object({
    mode: z.enum(["ordered", "exact"]),
    similarity: z.number(),
    passed: z.boolean(),
    expected: z.array(CalledToolSchema),
    actual: z.array(CalledToolSchema),
  }),
  assertions: z.array(AssertionResultSchema),
  finalOutput: z.string().nullable(),
  error: z.string().optional(),
  transcript: z.array(MessageSchema),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const DiffEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  reason: z.string(),
});
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

export const DiffReportSchema = z.object({
  baseline: z.string(),
  baselineModel: z.string().optional(),
  regressions: z.array(DiffEntrySchema),
  improvements: z.array(DiffEntrySchema),
  scoreDrops: z.array(DiffEntrySchema),
  scoreGains: z.array(DiffEntrySchema),
  knownFailures: z.array(DiffEntrySchema),
  unchanged: z.number(),
  newTests: z.array(z.string()),
  removedTests: z.array(z.string()),
});
export type DiffReport = z.infer<typeof DiffReportSchema>;

export const SuiteResultSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    errors: z.number(),
    latencyMs: z.number(),
    costUsd: z.number().nullable(),
    inputTokens: z.number(),
    outputTokens: z.number(),
  }),
  tests: z.array(TestResultSchema),
  diff: DiffReportSchema.optional(),
});
export type SuiteResult = z.infer<typeof SuiteResultSchema>;

export function parseTestCase(data: unknown, file?: string): TestCase {
  const result = TestCaseSchema.safeParse(data);
  if (!result.success) {
    throw new SchemaError(file, result.error);
  }
  return result.data;
}

export function parseSuiteResult(data: unknown, file?: string): SuiteResult {
  const result = SuiteResultSchema.safeParse(data);
  if (!result.success) {
    throw new SchemaError(file, result.error);
  }
  return result.data;
}

export function parseTrace(data: NormalizedTrace): NormalizedTrace {
  return NormalizedTraceSchema.parse(data);
}

class SchemaError extends Trace2TestError {
  constructor(file: string | undefined, error: z.ZodError) {
    const detail = error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    super(`${file ? `${file}: ` : ""}invalid document: ${detail}`);
  }
}
