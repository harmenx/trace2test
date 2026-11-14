import type { SuiteResult } from "../schema.js";
import { cell, formatMs, formatUsd } from "../util.js";

export function renderMarkdownReport(result: SuiteResult): string {
  const summary = result.summary;
  const lines: string[] = [];
  lines.push("# trace2test report");
  lines.push("");
  lines.push(`- Model: \`${result.model}\``);
  if (result.baseUrl) lines.push(`- Base URL: \`${result.baseUrl}\``);
  lines.push(`- Generated: ${result.generatedAt}`);
  lines.push(`- Result: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errors} errors`);
  lines.push(`- Latency: ${formatMs(summary.latencyMs)}`);
  lines.push(`- Tokens: ${summary.inputTokens} in / ${summary.outputTokens} out`);
  lines.push(`- Estimated cost: ${formatUsd(summary.costUsd)}`);
  lines.push("");
  lines.push("| Test | Status | Tool similarity | Latency | Cost |");
  lines.push("| --- | --- | ---: | ---: | ---: |");
  for (const test of result.tests) {
    lines.push(
      `| ${cell(test.id)} | ${test.status} | ${test.toolSequence.similarity.toFixed(2)} | ${formatMs(test.latencyMs)} | ${formatUsd(test.costUsd)} |`,
    );
  }
  lines.push("");

  for (const test of result.tests) {
    lines.push(`## ${test.name}`);
    lines.push("");
    lines.push(`Status: **${test.status}**. Tool sequence similarity ${test.toolSequence.similarity.toFixed(2)}.`);
    lines.push("");
    lines.push("| Assertion | Result | Detail |");
    lines.push("| --- | --- | --- |");
    for (const assertion of test.assertions) {
      lines.push(`| ${cell(assertion.name)} | ${assertion.status} | ${cell(assertion.detail)} |`);
    }
    lines.push("");
    lines.push("### Final answer");
    lines.push("");
    lines.push(fence(test.finalOutput ?? "(none)"));
    lines.push("");
    if (test.status !== "pass") {
      lines.push("### Tool calls");
      lines.push("");
      lines.push(fence(JSON.stringify({ expected: test.toolSequence.expected, actual: test.toolSequence.actual }, null, 2)));
      lines.push("");
    }
  }

  if (result.diff) {
    lines.push("## Baseline");
    lines.push("");
    lines.push(`Compared with \`${result.diff.baseline}\`${result.diff.baselineModel ? ` (model \`${result.diff.baselineModel}\`)` : ""}.`);
    lines.push("");
    lines.push(section("Regressions", result.diff.regressions));
    lines.push(section("Improvements", result.diff.improvements));
    lines.push(section("Tool similarity drops", result.diff.scoreDrops));
    lines.push(section("Tool similarity gains", result.diff.scoreGains));
    lines.push(section("Known failures", result.diff.knownFailures));
    if (result.diff.newTests.length > 0) lines.push(`New tests: ${result.diff.newTests.join(", ")}`);
    if (result.diff.removedTests.length > 0) lines.push(`Removed tests: ${result.diff.removedTests.join(", ")}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function section(title: string, entries: { id: string; reason: string }[]): string {
  if (entries.length === 0) return `### ${title}\n\nNone.\n`;
  return `### ${title}\n\n${entries.map((entry) => `- **${entry.id}**: ${entry.reason}`).join("\n")}\n`;
}

function fence(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}
