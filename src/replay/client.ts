import { Trace2TestError } from "../errors.js";
import type { Message, TokenUsage, ToolDefinition } from "../schema.js";
import { isRecord, numberOf } from "../util.js";
import { fromOpenAIMessage } from "../messages.js";

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface ChatResponse {
  message: Message;
  usage?: TokenUsage;
  model?: string;
  latencyMs?: number;
}

export interface ModelClient {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

export function createOpenAIClient(options: { apiKey: string; baseUrl: string }): ModelClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  return {
    async complete(request) {
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages.map(toWireMessage),
            ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toWireTool) } : {}),
            temperature: request.temperature ?? 0,
          }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Trace2TestError(`Model request to ${baseUrl} failed: ${message}`);
      }
      const body = await response.text();
      if (!response.ok) {
        throw new Trace2TestError(`Model request failed (${response.status} ${response.statusText}): ${body.slice(0, 300)}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(body) as unknown;
      } catch {
        throw new Trace2TestError(`Model response was not JSON: ${body.slice(0, 300)}`);
      }
      if (!isRecord(json) || !Array.isArray(json.choices)) {
        throw new Trace2TestError("Model response did not include choices.");
      }
      const choice = json.choices[0];
      const message = isRecord(choice) ? fromOpenAIMessage(choice.message) : null;
      if (!message) throw new Trace2TestError("Model response did not include an assistant message.");
      return {
        message,
        ...(usageOf(json.usage) ? { usage: usageOf(json.usage) } : {}),
        ...(typeof json.model === "string" ? { model: json.model } : {}),
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
}

function toWireMessage(message: Message): Record<string, unknown> {
  const body: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.role === "tool" && message.name) body.name = message.name;
  if (message.toolCallId) body.tool_call_id = message.toolCallId;
  if (message.toolCalls && message.toolCalls.length > 0) {
    body.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
      },
    }));
  }
  return body;
}

function toWireTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  };
}

function usageOf(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberOf(value.prompt_tokens ?? value.input_tokens);
  const outputTokens = numberOf(value.completion_tokens ?? value.output_tokens);
  const totalTokens = numberOf(value.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}
