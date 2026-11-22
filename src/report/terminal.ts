import type { SuiteResult } from "../schema.js";
import { formatMs, formatUsd } from "../util.js";

export function renderTerminalReport(result: SuiteResult, options?: { color?: boolean }): string {
  const paint = options?.color ? ansi : plain;
  const lines: string[] = [];
  lines.push(`${paint.bold("trace2test")}  ${result.model}  ${result.summary.total} ${result.summary.total === 1 ? "test" : "tests"}`);
  lines.push("");
  const width = Math.min(48, Math.max(12, ...result.tests.map((test) => test.id.length)));
  for (const test of result.tests) {
    const label = test.flaky
      ? paint.yellow("FLAKY")
      : test.status === "pass"
        ? paint.green("PASS")
        : test.status === "error"
          ? paint.red("ERROR")
          : paint.red("FAIL");
    const similarity = test.toolSequence.similarity.toFixed(2);
    lines.push(
      `  ${label}  ${test.id.padEnd(width)}  tools ${similarity}  ${formatMs(test.latencyMs).padStart(7)}  ${formatUsd(test.costUsd)}`,
    );
    if (test.flaky) {
      lines.push(`        ${paint.dim("-")} passed ${test.flaky.passed} of ${test.flaky.runs} runs`);
    }
    for (const assertion of test.assertions) {
      if (assertion.status === "pass" || assertion.status === "skipped") continue;
      lines.push(`        ${paint.dim("-")} ${assertion.detail}`);
    }
  }
  lines.push("");
  const summary = result.summary;
  lines.push(
    `${summary.total} tests, ${paint.green(`${summary.passed} passed`)}, ${summary.failed > 0 ? paint.red(`${summary.failed} failed`) : "0 failed"}, ${summary.flaky ? paint.yellow(`${summary.flaky} flaky`) + ", " : ""}${summary.errors} errors, ${formatMs(summary.latencyMs)}, ${formatUsd(summary.costUsd)}`,
  );
  if (result.diff) {
    lines.push("");
    lines.push(`baseline ${result.diff.baseline}${result.diff.baselineModel ? ` (${result.diff.baselineModel})` : ""}`);
    for (const entry of result.diff.regressions) lines.push(`  ${paint.red("REGRESSION")}  ${entry.id}  ${entry.reason}`);
    for (const entry of result.diff.improvements) lines.push(`  ${paint.green("IMPROVED")}    ${entry.id}  ${entry.reason}`);
    for (const entry of result.diff.scoreDrops) lines.push(`  ${paint.yellow("SCORE")}      ${entry.id}  ${entry.reason}`);
    if (result.diff.knownFailures.length > 0) {
      lines.push(`  ${result.diff.knownFailures.length} known ${result.diff.knownFailures.length === 1 ? "failure" : "failures"}`);
    }
    if (result.diff.regressions.length === 0) lines.push(`  ${paint.green("no regressions")}`);
  }
  return lines.join("\n");
}

const identity = (text: string) => text;

const plain = {
  bold: identity,
  dim: identity,
  red: identity,
  green: identity,
  yellow: identity,
};

const ansi = {
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
};
