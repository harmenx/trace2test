#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Command, CommanderError } from "commander";

import { exportCommand } from "./commands/export.js";
import { generateCommand } from "./commands/generate.js";
import { runCommand } from "./commands/run.js";
import { Trace2TestError } from "./errors.js";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

export async function main(argv: string[]): Promise<number> {
  let code = 0;
  const program = new Command();
  program
    .name("trace2test")
    .description("Turn recorded LLM agent traces into replayable regression tests")
    .version(packageJson.version);

  program
    .command("generate")
    .description("Write one YAML test per trace")
    .argument("<traces...>", "Trace files or directories (.json, .jsonl)")
    .requiredOption("--out <dir>", "Directory to write YAML tests into")
    .option("--format <format>", "otel, langfuse, or openai (default: detect)")
    .option("--judge", "Turn on the LLM-judge rubric in the generated tests", false)
    .action(async (traces: string[], opts: { out: string; format?: string; judge: boolean }) => {
      await generateCommand({ inputs: traces, outDir: opts.out, format: opts.format, judge: opts.judge });
    });

  program
    .command("export")
    .description("Turn YAML cases into another test runner")
    .argument("<tests>", "YAML test file or directory")
    .requiredOption("--format <format>", "pytest")
    .requiredOption("--out <file>", "File to write")
    .action(async (tests: string, opts: { format: string; out: string }) => {
      await exportCommand({ inputs: [tests], format: opts.format, outFile: opts.out });
    });

  program
    .command("run")
    .description("Replay tests against an OpenAI-compatible model")
    .argument("<tests>", "Test file or directory")
    .requiredOption("--model <id>", "Model id sent to the endpoint")
    .option("--base-url <url>", "OpenAI-compatible base URL, including /v1")
    .option("--api-key <key>", "API key (prefer OPENAI_API_KEY)")
    .option("--out <dir>", "Directory for results.json and report.md", "trace2test-results")
    .option("--baseline <file>", "Previous results.json; exit 1 only on new failures")
    .option("--judge", "Score every LLM-judge rubric, including ones left disabled", false)
    .option("--judge-model <id>", "Model used for the judge (default: --model)")
    .option("--max-steps <n>", "Maximum model calls per test", "8")
    .option("--repeat <n>", "Replay each test this many times and flag mixed results", "1")
    .option("--fail-on-score-drop", "Treat a drop in tool-sequence similarity as a regression", false)
    .option("--prices <file>", "JSON price table, USD per 1M tokens, merged over the built-in estimates")
    .action(async (tests: string, opts: {
      model: string;
      baseUrl?: string;
      apiKey?: string;
      out: string;
      baseline?: string;
      judge: boolean;
      judgeModel?: string;
      maxSteps: string;
      repeat: string;
      failOnScoreDrop: boolean;
      prices?: string;
    }) => {
      const maxSteps = Number(opts.maxSteps);
      if (!Number.isInteger(maxSteps) || maxSteps < 1) {
        throw new Trace2TestError("--max-steps must be a positive integer.");
      }
      const repeat = Number(opts.repeat);
      if (!Number.isInteger(repeat) || repeat < 1) {
        throw new Trace2TestError("--repeat must be a positive integer.");
      }
      const { exitCode } = await runCommand({
        inputs: [tests],
        model: opts.model,
        baseUrl: opts.baseUrl,
        apiKey: opts.apiKey,
        outDir: opts.out,
        baseline: opts.baseline,
        judge: opts.judge,
        judgeModel: opts.judgeModel,
        maxSteps,
        repeat,
        failOnScoreDrop: opts.failOnScoreDrop,
        prices: opts.prices,
      });
      code = exitCode;
    });

  program.exitOverride();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
  return code;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
