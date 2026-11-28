import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { loadTestCases } from "../src/cases.js";
import { main } from "../src/cli.js";
import { renderPytestModule } from "../src/export/pytest.js";

const exec = promisify(execFile);

describe("pytest export", () => {
  it("renders the sample cases as Python that compiles", async () => {
    const tests = await loadTestCases(["examples/tests"]);
    const source = renderPytestModule(tests);
    expect(source).toContain("def test_weather_in_paris():");
    expect(source).toContain("def test_order_status():");
    expect(source).toContain("def test_order_and_balance():");
    expect(source).toContain("rainy, 57°F");

    const dir = await mkdtemp(path.join(tmpdir(), "trace2test-py-"));
    const file = path.join(dir, "test_agent_sessions.py");
    await writeFile(file, source, "utf8");
    await exec("python3", ["-m", "py_compile", file]);
  });

  it("writes a pytest file from the CLI", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "trace2test-export-"));
    const file = path.join(dir, "test_agent_sessions.py");
    expect(await main(["node", "trace2test", "export", "examples/tests", "--format", "pytest", "--out", file])).toBe(0);
    await exec("python3", ["-m", "py_compile", file]);
    expect(await main(["node", "trace2test", "export", "examples/tests", "--format", "junit", "--out", file])).toBe(1);
  });
});
