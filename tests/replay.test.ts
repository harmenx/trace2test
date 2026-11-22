import { describe, expect, it } from "vitest";

import { scriptedMessage } from "../examples/demo-agent/agent.js";
import { traceToTestCase } from "../src/generate/index.js";
import { ingestPaths } from "../src/ingest/index.js";
import { fromOpenAIMessage } from "../src/messages.js";
import { DEFAULT_PRICES, lookupPrice } from "../src/replay/pricing.js";
import type { ModelClient } from "../src/replay/client.js";
import { runSuite } from "../src/replay/runner.js";
import { TestCaseSchema, type TestCase } from "../src/schema.js";

const recorded: ModelClient = {
  async complete(request) {
    const message = fromOpenAIMessage(scriptedMessage(request.messages.map((entry) => ({
      role: entry.role,
      content: entry.content,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.toolCallId ? { tool_call_id: entry.toolCallId } : {}),
      ...(entry.toolCalls
        ? {
            tool_calls: entry.toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.name,
                arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
              },
            })),
          }
        : {}),
    }))));
    if (!message) throw new Error("script returned an empty message");
    return {
      message,
      usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
      model: request.model,
    };
  },
};

async function cases(): Promise<TestCase[]> {
  const traces = await ingestPaths(["examples/traces"]);
  return traces.map((trace) => TestCaseSchema.parse(traceToTestCase(trace)));
}

describe("replay", () => {
  it("passes the sample traces against the scripted policy", async () => {
    const result = await runSuite({
      tests: await cases(),
      model: "gpt-4o-mini",
      client: recorded,
      prices: DEFAULT_PRICES,
      now: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(result.summary.passed).toBe(3);
    expect(result.summary.failed).toBe(0);
    expect(result.tests.every((test) => test.toolSequence.similarity === 1)).toBe(true);
    expect(result.summary.costUsd).toBeGreaterThan(0);
    expect(result.generatedAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("fails when the model calls the wrong tool or drops a fact", async () => {
    const [weather] = (await cases()).filter((test) => test.fixtures.some((fixture) => fixture.name === "get_weather"));
    if (!weather) throw new Error("missing weather test");

    const wrongTool = await runSuite({
      tests: [weather],
      model: "gpt-4o-mini",
      prices: DEFAULT_PRICES,
      client: {
        async complete() {
          return {
            message: {
              role: "assistant",
              content: null,
              toolCalls: [{ id: "call_x", name: "lookup_order", arguments: { orderId: "A-1001" } }],
            },
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      },
      maxSteps: 2,
    });
    expect(wrongTool.tests[0]?.status).toBe("fail");
    expect(wrongTool.tests[0]?.toolSequence.passed).toBe(false);

    const missingFact = await runSuite({
      tests: [weather],
      model: "gpt-4o-mini",
      prices: DEFAULT_PRICES,
      client: {
        async complete(request) {
          const called = request.messages.some((message) => message.role === "tool");
          if (!called) {
            return {
              message: {
                role: "assistant",
                content: null,
                toolCalls: [{ id: "call_weather_paris", name: "get_weather", arguments: { location: "Paris" } }],
              },
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            };
          }
          return {
            message: { role: "assistant", content: "I looked it up." },
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        },
      },
    });
    expect(missingFact.tests[0]?.assertions.some((assertion) => assertion.kind === "regex" && assertion.status === "fail")).toBe(true);
  });

  it("scores an LLM judge when asked", async () => {
    const [weather] = (await cases()).filter((test) => test.id.includes("weather") || test.fixtures.some((fixture) => fixture.name === "get_weather"));
    if (!weather) throw new Error("missing weather test");
    const judged = TestCaseSchema.parse({
      ...weather,
      assertions: { ...weather.assertions, judge: { ...weather.assertions.judge, enabled: true, rubric: "Mention the weather.", minScore: 0.7 } },
    });

    const pass = await runSuite({
      tests: [judged],
      model: "gpt-4o-mini",
      client: judgedClient(0.9),
      prices: DEFAULT_PRICES,
      judge: true,
    });
    expect(pass.tests[0]?.assertions.find((assertion) => assertion.kind === "judge")?.status).toBe("pass");

    const fail = await runSuite({
      tests: [judged],
      model: "gpt-4o-mini",
      client: judgedClient(0.2),
      prices: DEFAULT_PRICES,
      judge: true,
    });
    expect(fail.tests[0]?.status).toBe("fail");
  });

  it("flags a test that passes and fails across repeats", async () => {
    const test = TestCaseSchema.parse({
      id: "flip",
      name: "flip",
      source: { format: "openai", id: "flip" },
      input: { messages: [{ role: "user", content: "Say ok" }] },
      assertions: {
        toolSequence: { expected: [] },
        finalAnswer: [{ type: "contains", value: "ok" }],
      },
    });
    let calls = 0;
    const client: ModelClient = {
      async complete() {
        calls += 1;
        return {
          message: { role: "assistant", content: calls % 2 === 1 ? "ok" : "nope" },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    };
    const mixed = await runSuite({
      tests: [test],
      model: "gpt-4o-mini",
      client,
      prices: DEFAULT_PRICES,
      repeat: 2,
    });
    expect(mixed.tests[0]?.status).toBe("fail");
    expect(mixed.tests[0]?.flaky).toEqual({ runs: 2, passed: 1, failed: 1 });
    expect(mixed.summary.flaky).toBe(1);

    const steady = await runSuite({
      tests: [test],
      model: "gpt-4o-mini",
      client: {
        async complete() {
          return {
            message: { role: "assistant", content: "ok" },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      },
      prices: DEFAULT_PRICES,
      repeat: 3,
    });
    expect(steady.tests[0]?.status).toBe("pass");
    expect(steady.tests[0]?.flaky).toBeUndefined();
    expect(steady.summary.flaky).toBeUndefined();
  });

  it("prices dated model snapshots from the list-price table", () => {
    expect(lookupPrice("gpt-4o-mini-2024-07-18", DEFAULT_PRICES)).toEqual(DEFAULT_PRICES["gpt-4o-mini"]);
    expect(lookupPrice("gpt-4o", DEFAULT_PRICES)?.input).toBe(2.5);
    expect(lookupPrice("local-demo", DEFAULT_PRICES)).toBeUndefined();
  });
});

function judgedClient(score: number): ModelClient {
  return {
    async complete(request) {
      const judging = request.messages.some((message) => message.content?.includes("Rubric:"));
      if (judging) {
        return {
          message: { role: "assistant", content: JSON.stringify({ score, reason: "checked" }) },
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        };
      }
      return recorded.complete(request);
    },
  };
}
