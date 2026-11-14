import { readFile } from "node:fs/promises";

import { Trace2TestError } from "../errors.js";
import type { TokenUsage } from "../schema.js";
import { isRecord, numberOf, parseJsonText, roundCost } from "../util.js";

export interface ModelPrice {
  input: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice>;

/**
 * Approximate public list prices in USD per 1M tokens.
 * They are estimates for the report, not a bill. Override with --prices.
 */
export const DEFAULT_PRICES: PriceTable = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },
};

export function lookupPrice(model: string, table: PriceTable): ModelPrice | undefined {
  const direct = table[model];
  if (direct) return direct;
  const match = Object.keys(table)
    .sort((left, right) => right.length - left.length)
    .find((key) => model === key || model.startsWith(`${key}-`) || model.endsWith(`/${key}`) || model.endsWith(`:${key}`));
  return match ? table[match] : undefined;
}

export function estimateCost(model: string, usage: TokenUsage, table: PriceTable): number | null {
  const price = lookupPrice(model, table);
  if (!price) return null;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  if ((usage.inputTokens ?? usage.outputTokens ?? usage.totalTokens) === undefined) return null;
  return roundCost((input * price.input + output * price.output) / 1_000_000);
}

export async function loadPrices(file: string | undefined): Promise<PriceTable> {
  if (!file) return { ...DEFAULT_PRICES };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Trace2TestError(`Could not read prices ${file}: ${message}`);
  }
  const data = parseJsonText(text, file);
  if (!isRecord(data)) throw new Trace2TestError(`${file} should be a JSON object of model prices.`);
  const table: PriceTable = { ...DEFAULT_PRICES };
  for (const [model, value] of Object.entries(data)) {
    if (!isRecord(value)) throw new Trace2TestError(`${file}: ${model} should be { "input": number, "output": number }.`);
    const input = numberOf(value.input);
    const output = numberOf(value.output);
    if (input === undefined || output === undefined) {
      throw new Trace2TestError(`${file}: ${model} needs numeric input and output prices per 1M tokens.`);
    }
    table[model] = { input, output };
  }
  return table;
}
