import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadTestCases } from "../cases.js";
import { Trace2TestError } from "../errors.js";
import { renderPytestModule } from "../export/pytest.js";

export async function exportCommand(options: { inputs: string[]; format: string; outFile: string }): Promise<number> {
  if (options.format !== "pytest") {
    throw new Trace2TestError(`Unknown export format "${options.format}". Expected pytest.`);
  }
  const tests = await loadTestCases(options.inputs);
  await mkdir(path.dirname(options.outFile), { recursive: true });
  await writeFile(options.outFile, renderPytestModule(tests), "utf8");
  console.log(`wrote ${tests.length} ${tests.length === 1 ? "case" : "cases"} to ${options.outFile}`);
  return 0;
}
