import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { Trace2TestError } from "../src/errors.js";
import { ingestFile, ingestPaths } from "../src/ingest/index.js";
import { ingestOtel } from "../src/ingest/otel.js";

describe("ingest", () => {
  it("normalizes the three sample traces", async () => {
    const traces = await ingestPaths(["examples/traces"]);
    expect(traces.map((trace) => trace.source).sort()).toEqual(["langfuse", "openai", "otel"]);

    const weather = traces.find((trace) => trace.source === "otel");
    expect(weather?.model).toBe("gpt-4o-mini");
    expect(weather?.provider).toBe("openai");
    expect(weather?.toolExchanges.map((call) => call.name)).toEqual(["get_weather"]);
    expect(weather?.toolExchanges[0]?.arguments).toEqual({ location: "Paris" });
    expect(weather?.toolExchanges[0]?.result).toBe("rainy, 57°F");
    expect(weather?.finalOutput).toContain("57°F");
    expect(weather?.inputMessages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(weather?.usage).toEqual({ inputTokens: 144, outputTokens: 48, totalTokens: 192 });
    expect(weather?.durationMs).toBe(1140);

    const order = traces.find((trace) => trace.source === "langfuse");
    expect(order?.name).toBe("order-status");
    expect(order?.toolExchanges).toHaveLength(1);
    expect(order?.toolExchanges[0]?.name).toBe("lookup_order");
    expect(order?.toolExchanges[0]?.result).toMatchObject({ status: "shipped", carrier: "UPS" });
    expect(order?.finalOutput).toContain("\"status\":\"shipped\"");
    expect(order?.tools.map((tool) => tool.name)).toEqual(["lookup_order"]);
    expect(order?.usage).toEqual({ inputTokens: 145, outputTokens: 46, totalTokens: 191 });

    const support = traces.find((trace) => trace.source === "openai");
    expect(support?.id).toBe("sess_order_balance_001");
    expect(support?.toolExchanges.map((call) => call.name)).toEqual(["lookup_order", "get_balance"]);
    expect(support?.finalOutput).toContain("$25.00");
    expect(support?.tools.map((tool) => tool.name)).toEqual(["lookup_order", "get_balance"]);
    expect(support?.durationMs).toBe(280 + 280 + 460);
  });

  it("reads OTLP JSON and legacy indexed attributes", async () => {
    const [otlp] = await ingestFile("tests/fixtures/otel-otlp.json");
    expect(otlp?.finalOutput).toBe("It is rainy and 57°F in Paris.");
    expect(otlp?.usage?.inputTokens).toBe(22);
    expect(otlp?.durationMs).toBe(1500);

    const [legacy] = await ingestFile("tests/fixtures/otel-legacy.json");
    expect(legacy?.provider).toBe("openai");
    expect(legacy?.toolExchanges[0]).toMatchObject({ name: "get_weather", arguments: { location: "Paris" } });
    expect(legacy?.inputMessages[0]?.content).toBe("Weather in Paris?");
  });

  it("splits an OpenAI log by trace id and accepts snake_case OTLP", async () => {
    const traces = await ingestFile("tests/fixtures/openai-multi.jsonl");
    expect(traces.map((trace) => trace.id).sort()).toEqual(["sess-a", "sess-b"]);
    expect(traces.map((trace) => trace.finalOutput).sort()).toEqual(["Bye", "Hi"]);

    const snake = ingestOtel(
      {
        resource_spans: [
          {
            scope_spans: [
              {
                spans: [
                  {
                    trace_id: "snake",
                    span_id: "s1",
                    name: "chat gpt-4o-mini",
                    start_time_unix_nano: "1000000000",
                    end_time_unix_nano: "2000000000",
                    attributes: [
                      { key: "gen_ai.operation.name", value: { string_value: "chat" } },
                      { key: "gen_ai.request.model", value: { string_value: "gpt-4o-mini" } },
                      {
                        key: "gen_ai.input.messages",
                        value: { string_value: "[{\"role\":\"user\",\"content\":\"ping\"}]" },
                      },
                      {
                        key: "gen_ai.output.messages",
                        value: { string_value: "[{\"role\":\"assistant\",\"content\":\"pong\"}]" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      "snake.json",
    );
    expect(snake[0]?.finalOutput).toBe("pong");
    expect(snake[0]?.durationMs).toBe(1000);
  });

  it("rejects a file it cannot classify", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "trace2test-"));
    const file = path.join(dir, "notes.json");
    await writeFile(file, JSON.stringify({ hello: "world" }), "utf8");
    await expect(ingestFile(file)).rejects.toBeInstanceOf(Trace2TestError);
  });
});
