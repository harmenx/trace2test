import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { recordScripted, startDemoServer } from "../examples/demo-agent/agent.js";
import { main } from "../src/cli.js";

describe("cli", () => {
  it("generates tests and replays them through the demo server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "trace2test-cli-"));
    const testsDir = path.join(root, "tests");
    const outDir = path.join(root, "out");
    expect(await main(["node", "trace2test", "generate", "examples/traces", "--out", testsDir])).toBe(0);
    const written = await readdir(testsDir);
    expect(written.filter((file) => file.endsWith(".yaml"))).toHaveLength(3);

    const server = await startDemoServer(0);
    try {
      const code = await main([
        "node",
        "trace2test",
        "run",
        testsDir,
        "--model",
        "gpt-4o-mini",
        "--base-url",
        server.url,
        "--api-key",
        "test",
        "--out",
        outDir,
      ]);
      expect(code).toBe(0);
      const results = JSON.parse(await readFile(path.join(outDir, "results.json"), "utf8")) as { summary: { passed: number } };
      expect(results.summary.passed).toBe(3);
      expect(await readFile(path.join(outDir, "report.md"), "utf8")).toContain("# trace2test report");

      const weather = (await readdir(testsDir)).find((file) => file.includes("weather"));
      if (!weather) throw new Error("weather test was not written");
      const weatherPath = path.join(testsDir, weather);
      const broken = (await readFile(weatherPath, "utf8")).replaceAll("57", "999");
      await writeFile(weatherPath, broken, "utf8");
      const regression = await main([
        "node",
        "trace2test",
        "run",
        testsDir,
        "--model",
        "gpt-4o-mini",
        "--base-url",
        server.url,
        "--api-key",
        "test",
        "--out",
        path.join(root, "regression"),
        "--baseline",
        path.join(outDir, "results.json"),
      ]);
      expect(regression).toBe(1);
      expect(await readFile(path.join(root, "regression", "report.md"), "utf8")).toContain("Regressions");
    } finally {
      await server.close();
    }
  });

  it("prints help and the checked-in OpenAI trace matches the demo agent", async () => {
    expect(await main(["node", "trace2test", "--help"])).toBe(0);
    const recorded = await readFile("examples/traces/openai-chat.jsonl", "utf8");
    expect(recorded).toBe(recordScripted());
  });
});
