export { generateCommand } from "./commands/generate.js";
export { runCommand } from "./commands/run.js";
export { Trace2TestError } from "./errors.js";
export { traceToTestCase, writeTestCases } from "./generate/index.js";
export { ingestFile, ingestPaths } from "./ingest/index.js";
export { createOpenAIClient, type ModelClient, type ChatRequest, type ChatResponse } from "./replay/client.js";
export { DEFAULT_PRICES, estimateCost, lookupPrice } from "./replay/pricing.js";
export { runSuite } from "./replay/runner.js";
export { diffResults, exitCodeFor } from "./report/diff.js";
export { renderMarkdownReport } from "./report/markdown.js";
export { renderJobSummary } from "./report/summary.js";
export { renderTerminalReport } from "./report/terminal.js";
export type {
  Message,
  NormalizedTrace,
  SuiteResult,
  TestCase,
  TestResult,
  ToolExchange,
  TraceFormat,
} from "./schema.js";
