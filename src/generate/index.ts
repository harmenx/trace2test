import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringify } from "yaml";

import type { NormalizedTrace, TestCase } from "../schema.js";
import { TestCaseSchema } from "../schema.js";
import { traceToTestCase } from "./infer.js";

export { inferFinalAnswer, inferSchema, salientFacts, traceToTestCase } from "./infer.js";

export async function writeTestCases(
  traces: NormalizedTrace[],
  outDir: string,
  options?: { judge?: boolean },
): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const used = new Set<string>();
  const files: string[] = [];
  for (const trace of traces) {
    const test = TestCaseSchema.parse(traceToTestCase(trace, options));
    const id = uniqueId(test.id, used);
    const written: TestCase = { ...test, id };
    const file = path.join(outDir, `${id}.yaml`);
    await writeFile(file, `${stringify(written, { lineWidth: 100 }).trimEnd()}\n`, "utf8");
    files.push(file);
  }
  return files;
}

function uniqueId(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let suffix = 2;
  while (used.has(`${id}-${suffix}`)) suffix += 1;
  const next = `${id}-${suffix}`;
  used.add(next);
  return next;
}
