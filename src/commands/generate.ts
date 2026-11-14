import { Trace2TestError } from "../errors.js";
import { ingestPaths } from "../ingest/index.js";
import { writeTestCases } from "../generate/index.js";
import { TRACE_FORMATS, type TraceFormat } from "../schema.js";

export async function generateCommand(options: {
  inputs: string[];
  outDir: string;
  format?: string;
  judge: boolean;
}): Promise<number> {
  const format = parseFormat(options.format);
  const traces = await ingestPaths(options.inputs, format);
  const files = await writeTestCases(traces, options.outDir, { judge: options.judge });
  console.log(`wrote ${files.length} ${files.length === 1 ? "test" : "tests"} to ${options.outDir}`);
  for (const file of files) console.log(`  ${file}`);
  return 0;
}

function parseFormat(value: string | undefined): TraceFormat | undefined {
  if (!value) return undefined;
  if ((TRACE_FORMATS as readonly string[]).includes(value)) return value as TraceFormat;
  throw new Trace2TestError(`Unknown format "${value}". Expected otel, langfuse, or openai.`);
}
