import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadBaseline, loadTestCases } from "../cases.js";
import { Trace2TestError } from "../errors.js";
import { createOpenAIClient, type ModelClient } from "../replay/client.js";
import { loadPrices } from "../replay/pricing.js";
import { runSuite } from "../replay/runner.js";
import { diffResults, exitCodeFor } from "../report/diff.js";
import { renderMarkdownReport } from "../report/markdown.js";
import { renderJobSummary } from "../report/summary.js";
import { renderTerminalReport } from "../report/terminal.js";
import type { SuiteResult } from "../schema.js";

export async function runCommand(options: {
  inputs: string[];
  model: string;
  baseUrl?: string;
  apiKey?: string;
  outDir: string;
  baseline?: string;
  judge: boolean;
  judgeModel?: string;
  maxSteps: number;
  failOnScoreDrop: boolean;
  prices?: string;
  client?: ModelClient;
  now?: Date;
}): Promise<{ exitCode: number; result: SuiteResult }> {
  const tests = await loadTestCases(options.inputs);
  const baseUrl = options.baseUrl ?? process.env.TRACE2TEST_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = options.apiKey ?? process.env.TRACE2TEST_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const client = options.client ?? createOpenAIClient({ apiKey: requiredKey(apiKey), baseUrl });
  const prices = await loadPrices(options.prices);
  const result = await runSuite({
    tests,
    model: options.model,
    client,
    prices,
    judge: options.judge,
    ...(options.judgeModel ? { judgeModel: options.judgeModel } : {}),
    maxSteps: options.maxSteps,
    ...(options.now ? { now: options.now } : {}),
    ...(options.client ? {} : { baseUrl }),
  });

  if (options.baseline) {
    result.diff = diffResults(await loadBaseline(options.baseline), result, options.baseline);
  }

  await mkdir(options.outDir, { recursive: true });
  const jsonPath = path.join(options.outDir, "results.json");
  const markdownPath = path.join(options.outDir, "report.md");
  const summaryPath = path.join(options.outDir, "summary.md");
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdownReport(result), "utf8");
  await writeFile(summaryPath, renderJobSummary(result), "utf8");

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  console.log(renderTerminalReport(result, { color }));
  console.log("");
  console.log(`results  ${jsonPath}`);
  console.log(`report   ${markdownPath}`);

  return {
    exitCode: exitCodeFor(result, { baseline: Boolean(options.baseline), failOnScoreDrop: options.failOnScoreDrop }),
    result,
  };
}

function requiredKey(apiKey: string): string {
  if (apiKey.trim() !== "") return apiKey;
  throw new Trace2TestError("No API key. Set OPENAI_API_KEY or TRACE2TEST_API_KEY, or pass --api-key.");
}
