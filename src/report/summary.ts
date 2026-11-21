import type { SuiteResult } from "../schema.js";
import { cell, formatMs, formatUsd } from "../util.js";

export function renderJobSummary(result: SuiteResult): string {
  const summary = result.summary;
  const lines: string[] = [];
  lines.push("## trace2test");
  lines.push("");
  lines.push(
    `**${result.model}** — ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} errors in ${formatMs(summary.latencyMs)} (${formatUsd(summary.costUsd)})`,
  );
  lines.push("");
  lines.push("| Test | Status | Tool similarity | Latency |");
  lines.push("| --- | --- | ---: | ---: |");
  for (const test of result.tests) {
    lines.push(
      `| ${cell(test.id)} | ${test.status} | ${test.toolSequence.similarity.toFixed(2)} | ${formatMs(test.latencyMs)} |`,
    );
  }
  lines.push("");
  if (result.diff) {
    lines.push(`Compared with \`${result.diff.baseline}\`.`);
    lines.push("");
    lines.push(section("Regressions", result.diff.regressions));
    lines.push(section("Improvements", result.diff.improvements));
    if (result.diff.regressions.length === 0) {
      lines.push("No regressions.");
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function section(title: string, entries: { id: string; reason: string }[]): string {
  if (entries.length === 0) return "";
  return `### ${title}\n\n${entries.map((entry) => `- **${entry.id}**: ${entry.reason}`).join("\n")}\n`;
}
