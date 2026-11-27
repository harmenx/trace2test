import { readFile } from "node:fs/promises";

import { parse } from "yaml";

import { Trace2TestError } from "./errors.js";
import { parseSuiteResult, parseTestCase, type SuiteResult, type TestCase } from "./schema.js";
import { listFiles, parseJsonText } from "./util.js";

export async function loadTestCases(inputs: string[]): Promise<TestCase[]> {
  const files = await listFiles(inputs, [".yaml", ".yml"]);
  if (files.length === 0) throw new Trace2TestError("No YAML tests found.");
  const tests: TestCase[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Trace2TestError(`Could not read ${file}: ${message}`);
    }
    let data: unknown;
    try {
      data = parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Trace2TestError(`${file} is not valid YAML: ${message}`);
    }
    tests.push(parseTestCase(data, file));
  }
  return tests;
}

export async function loadBaseline(file: string): Promise<SuiteResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Trace2TestError(`Could not read baseline ${file}: ${message}`);
  }
  return parseSuiteResult(parseJsonText(text, file), file);
}
