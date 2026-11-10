import path from "node:path";

import { Trace2TestError } from "../errors.js";
import type { NormalizedTrace, TraceFormat } from "../schema.js";
import { basename, listFiles, parseJsonText, readText } from "../util.js";
import { detectFormat } from "./detect.js";
import { ingestLangfuse } from "./langfuse.js";
import { ingestOpenAI } from "./openai.js";
import { ingestOtel } from "./otel.js";

export async function ingestPaths(inputs: string[], format?: TraceFormat): Promise<NormalizedTrace[]> {
  const files = await listFiles(inputs, [".json", ".jsonl"]);
  if (files.length === 0) {
    throw new Trace2TestError("No trace files found. Expected .json or .jsonl.");
  }
  const traces: NormalizedTrace[] = [];
  for (const file of files) {
    traces.push(...(await ingestFile(file, format)));
  }
  if (traces.length === 0) {
    throw new Trace2TestError("No traces found in the given files.");
  }
  return traces;
}

export async function ingestFile(file: string, format?: TraceFormat): Promise<NormalizedTrace[]> {
  const text = await readText(file);
  const label = basename(file);
  const resolved = format ?? (file.toLowerCase().endsWith(".jsonl") ? "openai" : undefined);
  if (resolved === "openai" || file.toLowerCase().endsWith(".jsonl")) {
    return tag(ingestOpenAI(text, label), label);
  }
  const data = parseJsonText(text, label);
  const detected = resolved ?? detectFormat(data, label);
  if (detected === "otel") return tag(ingestOtel(data, label), label);
  if (detected === "langfuse") return tag(ingestLangfuse(data, label), label);
  return tag(ingestOpenAI(text, label), label);
}

function tag(traces: NormalizedTrace[], file: string): NormalizedTrace[] {
  return traces.map((trace) => ({ ...trace, originFile: trace.originFile ?? path.basename(file) }));
}
