import { Ajv } from "ajv";

import type { AssertionResult, FinalAssertion, TestCase } from "../schema.js";
import { argsMatch } from "../util.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export interface CalledTool {
  name: string;
  arguments: unknown;
}

export interface ToolScore {
  mode: "ordered" | "exact";
  similarity: number;
  passed: boolean;
  expected: CalledTool[];
  actual: CalledTool[];
  assertion: AssertionResult;
}

export function scoreToolSequence(test: TestCase, actual: CalledTool[]): ToolScore {
  const mode = test.assertions.toolSequence.mode;
  const expectedCalls = test.assertions.toolSequence.expected;
  const expected: CalledTool[] = expectedCalls.map((call) => ({
    name: call.name,
    arguments: call.arguments ?? {},
  }));
  let cursor = 0;
  let matched = 0;
  for (const call of expectedCalls) {
    while (cursor < actual.length) {
      const candidate = actual[cursor];
      cursor += 1;
      if (!candidate) continue;
      if (candidate.name === call.name && argsMatch(call.arguments, candidate.arguments, call.match)) {
        matched += 1;
        break;
      }
    }
  }

  const similarity =
    expected.length === 0 && actual.length === 0 ? 1 : matched / Math.max(expected.length, actual.length, 1);
  const rounded = Math.round(similarity * 10000) / 10000;
  const passed =
    mode === "exact"
      ? matched === expected.length && actual.length === expected.length
      : matched === expected.length && !(expected.length === 0 && actual.length > 0);

  const expectedNames = expected.map((call) => call.name).join(", ") || "(none)";
  const actualNames = actual.map((call) => call.name).join(", ") || "(none)";
  return {
    mode,
    similarity: rounded,
    passed,
    expected,
    actual,
    assertion: {
      name: "tool sequence",
      kind: "tool-sequence",
      status: passed ? "pass" : "fail",
      detail: passed
        ? `similarity ${rounded.toFixed(2)} [${actualNames}]`
        : `expected [${expectedNames}], got [${actualNames}], similarity ${rounded.toFixed(2)}`,
    },
  };
}

export function scoreFinalAnswer(output: string | null, assertions: FinalAssertion[]): AssertionResult[] {
  if (assertions.length === 0) return [];
  if (output === null) {
    return [
      {
        name: "final answer",
        kind: "runner",
        status: "fail",
        detail: "The model did not return a final answer.",
      },
    ];
  }
  return assertions.map((assertion, index) => scoreOne(output, assertion, index));
}

function scoreOne(output: string, assertion: FinalAssertion, index: number): AssertionResult {
  if (assertion.type === "exact") {
    const passed = output.trim() === assertion.value;
    return {
      name: `exact #${index + 1}`,
      kind: "exact",
      status: passed ? "pass" : "fail",
      detail: passed ? "final answer matches exactly" : `expected ${JSON.stringify(assertion.value)}`,
    };
  }
  if (assertion.type === "contains") {
    const passed = output.includes(assertion.value);
    return {
      name: `contains ${JSON.stringify(assertion.value)}`,
      kind: "contains",
      status: passed ? "pass" : "fail",
      detail: passed ? `final answer contains ${JSON.stringify(assertion.value)}` : `missing ${JSON.stringify(assertion.value)}`,
    };
  }
  if (assertion.type === "regex") {
    try {
      const passed = new RegExp(assertion.pattern, assertion.flags).test(output);
      return {
        name: `regex /${assertion.pattern}/`,
        kind: "regex",
        status: passed ? "pass" : "fail",
        detail: passed ? `matched /${assertion.pattern}/` : `did not match /${assertion.pattern}/`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        name: `regex /${assertion.pattern}/`,
        kind: "regex",
        status: "fail",
        detail: `invalid regular expression: ${message}`,
      };
    }
  }
  return scoreSchema(output, assertion.schema);
}

function scoreSchema(output: string, schema: Record<string, unknown>): AssertionResult {
  const parsed = parseOutputJson(output);
  if (parsed.ok === false) {
    return { name: "json schema", kind: "json-schema", status: "fail", detail: parsed.error };
  }
  try {
    const validate = ajv.compile(schema);
    const passed = validate(parsed.value);
    if (passed) return { name: "json schema", kind: "json-schema", status: "pass", detail: "final answer matches the schema" };
    const errors = (validate.errors ?? [])
      .slice(0, 3)
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    return { name: "json schema", kind: "json-schema", status: "fail", detail: errors || "schema validation failed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "json schema", kind: "json-schema", status: "fail", detail: `could not compile schema: ${message}` };
  }
}

function parseOutputJson(output: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `final answer is not JSON: ${message}` };
  }
}

export function takeFixture(
  fixtures: TestCase["fixtures"],
  call: CalledTool,
  used: Set<number>,
): { result: unknown } | undefined {
  for (let index = 0; index < fixtures.length; index += 1) {
    if (used.has(index)) continue;
    const fixture = fixtures[index];
    if (!fixture || fixture.name !== call.name) continue;
    if (!argsMatch(fixture.arguments, call.arguments, fixture.match)) continue;
    used.add(index);
    return { result: fixture.result };
  }
  return undefined;
}
