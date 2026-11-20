import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Ajv } from "ajv";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { traceToTestCase, writeTestCases } from "../src/generate/index.js";
import { inferFinalAnswer } from "../src/generate/infer.js";
import { ingestPaths } from "../src/ingest/index.js";
import { parseTestCase } from "../src/schema.js";

const ajv = new Ajv({ allErrors: true, strict: false });

describe("generate", () => {
  it("infers assertions that the recorded answer still satisfies", async () => {
    const traces = await ingestPaths(["examples/traces"]);
    for (const trace of traces) {
      const test = traceToTestCase(trace);
      expect(test.input.messages.length).toBeGreaterThan(0);
      expect(test.fixtures).toHaveLength(trace.toolExchanges.length);
      expect(test.assertions.toolSequence.expected.map((call) => call.name)).toEqual(
        trace.toolExchanges.map((call) => call.name),
      );
      for (const assertion of test.assertions.finalAnswer) {
        const output = trace.finalOutput ?? "";
        if (assertion.type === "contains") expect(output).toContain(assertion.value);
        if (assertion.type === "regex") expect(new RegExp(assertion.pattern, assertion.flags).test(output)).toBe(true);
        if (assertion.type === "exact") expect(output.trim()).toBe(assertion.value);
        if (assertion.type === "json-schema") {
          const validate = ajv.compile(assertion.schema);
          expect(validate(JSON.parse(output))).toBe(true);
        }
      }
    }

    const order = traces.find((trace) => trace.source === "langfuse");
    expect(order && traceToTestCase(order).assertions.finalAnswer[0]?.type).toBe("json-schema");
    const weather = traces.find((trace) => trace.source === "otel");
    const kinds = weather ? traceToTestCase(weather).assertions.finalAnswer.map((assertion) => assertion.type) : [];
    expect(kinds).toContain("regex");
    expect(kinds).toContain("contains");
  });

  it("writes one YAML file per trace", async () => {
    const traces = await ingestPaths(["examples/traces"]);
    const dir = await mkdtemp(path.join(tmpdir(), "trace2test-"));
    const files = await writeTestCases(traces, dir, { judge: true });
    expect(files).toHaveLength(3);
    for (const file of files) {
      const test = parseTestCase(parse(await readFile(file, "utf8")), file);
      expect(test.version).toBe(1);
      expect(test.assertions.judge?.enabled).toBe(true);
      expect(test.assertions.judge?.rubric).toContain("The assistant was asked");
    }
  });

  it("uses an exact check only for a short literal answer", () => {
    expect(inferFinalAnswer("shipped")).toEqual([{ type: "exact", value: "shipped" }]);
    expect(inferFinalAnswer(null)).toEqual([]);
  });
});
