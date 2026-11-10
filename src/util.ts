import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Trace2TestError } from "./errors.js";
import type { MatchMode, TokenUsage } from "./schema.js";

const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", "trace2test-results"]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

export function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function firstNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberOf(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function parseJsonText(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Trace2TestError(`${file} is not valid JSON: ${message}`);
  }
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "trace";
}

export function addUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): TokenUsage | undefined {
  if (!left && !right) return undefined;
  const input = (left?.inputTokens ?? 0) + (right?.inputTokens ?? 0);
  const output = (left?.outputTokens ?? 0) + (right?.outputTokens ?? 0);
  const hasInput = left?.inputTokens !== undefined || right?.inputTokens !== undefined;
  const hasOutput = left?.outputTokens !== undefined || right?.outputTokens !== undefined;
  const total =
    left?.totalTokens !== undefined || right?.totalTokens !== undefined
      ? (left?.totalTokens ?? 0) + (right?.totalTokens ?? 0)
      : hasInput || hasOutput
        ? input + output
        : undefined;
  return {
    ...(hasInput ? { inputTokens: input } : {}),
    ...(hasOutput ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

export function emptyUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function looselyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "string" && sameNumber(left, right)) return true;
  if (typeof right === "number" && typeof left === "string" && sameNumber(right, left)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => looselyEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && looselyEqual(left[key], right[key]));
  }
  return false;
}

function sameNumber(numeric: number, text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== "" && Number(trimmed) === numeric;
}

export function argsMatch(expected: unknown, actual: unknown, mode: MatchMode): boolean {
  if (mode === "any") return true;
  const left = expected ?? {};
  const right = actual ?? {};
  if (mode === "exact") return looselyEqual(left, right);
  return subsetMatch(left, right);
}

function subsetMatch(expected: unknown, actual: unknown): boolean {
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) => key in actual && subsetMatch(value, actual[key]));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((item, index) => subsetMatch(item, actual[index]));
  }
  return looselyEqual(expected, actual);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

export function roundCost(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

export function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Trace2TestError(`Could not read ${file}: ${message}`);
  }
}

export async function listFiles(inputs: string[], extensions: string[]): Promise<string[]> {
  if (inputs.length === 0) {
    throw new Trace2TestError("No input paths were given.");
  }
  const files: string[] = [];
  for (const input of inputs) {
    let info;
    try {
      info = await stat(input);
    } catch {
      throw new Trace2TestError(`Path not found: ${input}`);
    }
    if (info.isDirectory()) {
      await walk(input, files, extensions);
    } else if (info.isFile()) {
      files.push(input);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function walk(directory: string, files: string[], extensions: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, files, extensions);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (extensions.includes(ext)) files.push(full);
  }
}

export function basename(file: string): string {
  return path.basename(file);
}
