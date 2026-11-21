import { describe, expect, it } from "vitest";

import { diffResults, exitCodeFor } from "../src/report/diff.js";
import { renderMarkdownReport } from "../src/report/markdown.js";
import { renderJobSummary } from "../src/report/summary.js";
import { renderTerminalReport } from "../src/report/terminal.js";
import type { SuiteResult, TestResult } from "../src/schema.js";

function testResult(id: string, status: TestResult["status"], similarity = 1): TestResult {
  return {
    id,
    name: id,
    status,
    model: "gpt-4o-mini",
    latencyMs: 10,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    costUsd: 0.000001,
    toolSequence: {
      mode: "ordered",
      similarity,
      passed: similarity === 1,
      expected: [],
      actual: [],
    },
    assertions: [
      {
        name: "final",
        kind: "contains",
        status: status === "pass" ? "pass" : "fail",
        detail: status === "pass" ? "ok" : "missing fact",
      },
    ],
    finalOutput: status === "pass" ? "ok" : null,
    transcript: [],
  };
}

function suite(tests: TestResult[], model = "gpt-4o-mini"): SuiteResult {
  return {
    version: 1,
    generatedAt: "2026-04-01T00:00:00.000Z",
    model,
    summary: {
      total: tests.length,
      passed: tests.filter((test) => test.status === "pass").length,
      failed: tests.filter((test) => test.status === "fail").length,
      errors: tests.filter((test) => test.status === "error").length,
      latencyMs: 10,
      costUsd: 0.000001,
      inputTokens: tests.length,
      outputTokens: tests.length,
    },
    tests,
  };
}

describe("baseline diff", () => {
  it("flags new failures and ignores known ones", () => {
    const baseline = suite([testResult("kept", "pass"), testResult("known", "fail"), testResult("fixed", "fail")]);
    const current = suite([
      testResult("kept", "fail", 0.5),
      testResult("known", "fail"),
      testResult("fixed", "pass", 1),
      testResult("added", "fail"),
    ]);
    const diff = diffResults(baseline, current, "results.json");
    expect(diff.regressions.map((entry) => entry.id).sort()).toEqual(["added", "kept"]);
    expect(diff.improvements.map((entry) => entry.id)).toEqual(["fixed"]);
    expect(diff.knownFailures.map((entry) => entry.id)).toEqual(["known"]);
    expect(diff.scoreDrops.map((entry) => entry.id)).toEqual(["kept"]);
    expect(diff.removedTests).toEqual([]);

    const failed = suite([testResult("kept", "fail")]);
    expect(exitCodeFor(failed, { baseline: false, failOnScoreDrop: false })).toBe(1);
    const compared: SuiteResult = { ...current, diff };
    expect(exitCodeFor(compared, { baseline: true, failOnScoreDrop: false })).toBe(1);
    const onlyKnown: SuiteResult = {
      ...suite([testResult("known", "fail")]),
      diff: diffResults(suite([testResult("known", "fail")]), suite([testResult("known", "fail")]), "base.json"),
    };
    expect(exitCodeFor(onlyKnown, { baseline: true, failOnScoreDrop: false })).toBe(0);
    expect(exitCodeFor(onlyKnown, { baseline: true, failOnScoreDrop: true })).toBe(0);
  });

  it("renders a terminal summary and a markdown report", () => {
    const result = suite([testResult("weather-in-paris", "pass"), testResult("order-status", "fail", 0)]);
    const terminal = renderTerminalReport(result, { color: false });
    expect(terminal).toContain("PASS");
    expect(terminal).toContain("FAIL");
    expect(terminal).toContain("missing fact");
    expect(terminal).not.toContain("\x1b[");

    const markdown = renderMarkdownReport({
      ...result,
      diff: diffResults(suite([testResult("weather-in-paris", "pass"), testResult("order-status", "pass")]), result, "baseline.json"),
    });
    expect(markdown).toContain("# trace2test report");
    expect(markdown).toContain("### Regressions");
    expect(markdown).toContain("order-status");

    const summary = renderJobSummary({
      ...result,
      diff: diffResults(suite([testResult("weather-in-paris", "pass"), testResult("order-status", "pass")]), result, "baseline.json"),
    });
    expect(summary).toContain("## trace2test");
    expect(summary).toContain("### Regressions");
    expect(summary).toContain("order-status");
    expect(summary).not.toContain("### Improvements");
  });
});
