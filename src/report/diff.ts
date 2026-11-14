import type { DiffReport, SuiteResult, TestResult } from "../schema.js";

const SCORE_EPSILON = 0.001;

export function diffResults(baseline: SuiteResult, current: SuiteResult, baselineLabel: string): DiffReport {
  const before = new Map(baseline.tests.map((test) => [test.id, test]));
  const afterIds = new Set(current.tests.map((test) => test.id));
  const report: DiffReport = {
    baseline: baselineLabel,
    ...(baseline.model ? { baselineModel: baseline.model } : {}),
    regressions: [],
    improvements: [],
    scoreDrops: [],
    scoreGains: [],
    knownFailures: [],
    unchanged: 0,
    newTests: [],
    removedTests: [],
  };

  for (const test of current.tests) {
    const previous = before.get(test.id);
    if (!previous) {
      report.newTests.push(test.id);
      if (!passed(test)) {
        report.regressions.push({ id: test.id, name: test.name, reason: `new test failed: ${reason(test)}` });
      }
      continue;
    }
    const wasPassing = passed(previous);
    const isPassing = passed(test);
    if (wasPassing && !isPassing) {
      report.regressions.push({ id: test.id, name: test.name, reason: reason(test) });
    } else if (!wasPassing && isPassing) {
      report.improvements.push({ id: test.id, name: test.name, reason: "passed, previously failed" });
    } else if (!isPassing) {
      report.knownFailures.push({ id: test.id, name: test.name, reason: reason(test) });
    } else {
      report.unchanged += 1;
    }

    const drop = previous.toolSequence.similarity - test.toolSequence.similarity;
    if (drop > SCORE_EPSILON) {
      report.scoreDrops.push({
        id: test.id,
        name: test.name,
        reason: `tool similarity ${previous.toolSequence.similarity.toFixed(2)} -> ${test.toolSequence.similarity.toFixed(2)}`,
      });
    } else if (drop < -SCORE_EPSILON) {
      report.scoreGains.push({
        id: test.id,
        name: test.name,
        reason: `tool similarity ${previous.toolSequence.similarity.toFixed(2)} -> ${test.toolSequence.similarity.toFixed(2)}`,
      });
    }
  }

  for (const test of baseline.tests) {
    if (!afterIds.has(test.id)) report.removedTests.push(test.id);
  }
  return report;
}

export function exitCodeFor(result: SuiteResult, options: { baseline: boolean; failOnScoreDrop: boolean }): number {
  if (!options.baseline) return result.summary.failed + result.summary.errors > 0 ? 1 : 0;
  const regressions = result.diff?.regressions.length ?? 0;
  const drops = options.failOnScoreDrop ? (result.diff?.scoreDrops.length ?? 0) : 0;
  return regressions + drops > 0 ? 1 : 0;
}

function passed(test: TestResult): boolean {
  return test.status === "pass";
}

function reason(test: TestResult): string {
  const failed = test.assertions.filter((assertion) => assertion.status === "fail").map((assertion) => assertion.detail);
  return failed.slice(0, 3).join("; ") || test.error || "failed";
}
