import { GoogleGenerativeAI, Tool as GeminiTool } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

interface Message {
  role: "user" | "assistant";
  content: string;
}

// ── MCP Tool definitions exposed to the AI ───────────────────────────────────
const MCP_SERVER_URL = process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:3001/mcp";

let mcpSessionId: string | null = null;
let mcpRequestId = 1;

async function callMCPTool(name: string, args: Record<string, unknown>) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: mcpRequestId++,
    method: "tools/call",
    params: { name, arguments: args },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;

  const res = await fetch(MCP_SERVER_URL, { method: "POST", headers, body });
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) mcpSessionId = newSession;

  const contentType = res.headers.get("content-type") || "";
  let data;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    const last = lines[lines.length - 1]?.replace("data: ", "").trim();
    data = last ? JSON.parse(last) : { error: { message: "Empty stream" } };
  } else {
    data = await res.json();
  }

  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// Initialize MCP session
async function initMCP() {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: mcpRequestId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "chat-api", version: "1.0.0" },
    },
  });
  const res = await fetch(MCP_SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body,
  });
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) mcpSessionId = newSession;
}

// Tool definitions for Gemini
const geminiTools: GeminiTool[] = [{
  functionDeclarations: [
    {
      name: "execute_query",
      description: "Run a read-only SELECT query against the SQLite database",
      parameters: {
        type: "object" as const,
        properties: {
          sql: { type: "string" as const, description: "The SELECT SQL query to execute" },
          limit: { type: "number" as const, description: "Maximum rows to return (default 100)" },
        },
        required: ["sql"],
      },
    },
    {
      name: "sample_table",
      description: "Get a random sample of rows from a table",
      parameters: {
        type: "object" as const,
        properties: {
          table: { type: "string" as const, description: "Table name" },
          limit: { type: "number" as const, description: "Number of rows (default 25)" },
        },
        required: ["table"],
      },
    },
    {
      name: "column_stats",
      description: "Get statistics for a column: min, max, avg, nulls, distinct count",
      parameters: {
        type: "object" as const,
        properties: {
          table: { type: "string" as const, description: "Table name" },
          column: { type: "string" as const, description: "Column name" },
        },
        required: ["table", "column"],
      },
    },
    {
      name: "top_values",
      description: "Get most frequent values in a column",
      parameters: {
        type: "object" as const,
        properties: {
          table: { type: "string" as const, description: "Table name" },
          column: { type: "string" as const, description: "Column name" },
          limit: { type: "number" as const, description: "Number of top values" },
        },
        required: ["table", "column"],
      },
    },
    {
      name: "data_quality_check",
      description: "Run a data quality audit on a table",
      parameters: {
        type: "object" as const,
        properties: {
          table: { type: "string" as const, description: "Table name" },
        },
        required: ["table"],
      },
    },
    {
      name: "time_series",
      description: "Aggregate a metric over time",
      parameters: {
        type: "object" as const,
        properties: {
          table: { type: "string" as const, description: "Table name" },
          dateColumn: { type: "string" as const, description: "Date column name" },
          valueColumn: { type: "string" as const, description: "Numeric column to aggregate" },
          aggregation: { type: "string" as const, description: "sum, avg, count, min, or max" },
          period: { type: "string" as const, description: "hour, day, week, month, or year" },
        },
        required: ["table", "dateColumn", "valueColumn"],
      },
    },
  ],
}];

// Tool definitions for OpenAI
const openaiTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "execute_query",
      description: "Run a read-only SELECT query against the SQLite database",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "The SELECT SQL query" },
          limit: { type: "number", description: "Max rows to return" },
        },
        required: ["sql"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sample_table",
      description: "Get a random sample of rows from a table",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name" },
          limit: { type: "number", description: "Number of rows" },
        },
        required: ["table"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "column_stats",
      description: "Get statistics for a column",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name" },
          column: { type: "string", description: "Column name" },
        },
        required: ["table", "column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "top_values",
      description: "Get most frequent values in a column",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name" },
          column: { type: "string", description: "Column name" },
          limit: { type: "number", description: "Number of top values" },
        },
        required: ["table", "column"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "data_quality_check",
      description: "Run a data quality audit on a table",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name" },
        },
        required: ["table"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "time_series",
      description: "Aggregate a metric over time",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "Table name" },
          dateColumn: { type: "string", description: "Date column" },
          valueColumn: { type: "string", description: "Numeric column" },
          aggregation: { type: "string", description: "sum, avg, count, min, max" },
          period: { type: "string", description: "hour, day, week, month, year" },
        },
        required: ["table", "dateColumn", "valueColumn"],
      },
    },
  },
];

// Tool definitions for Claude
const claudeTools: Anthropic.Tool[] = [
  {
    name: "execute_query",
    description: "Run a read-only SELECT query against the SQLite database",
    input_schema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "The SELECT SQL query" },
        limit: { type: "number", description: "Max rows to return" },
      },
      required: ["sql"],
    },
  },
  {
    name: "sample_table",
    description: "Get a random sample of rows from a table",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: "Table name" },
        limit: { type: "number", description: "Number of rows" },
      },
      required: ["table"],
    },
  },
  {
    name: "column_stats",
    description: "Get statistics for a column",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: "Table name" },
        column: { type: "string", description: "Column name" },
      },
      required: ["table", "column"],
    },
  },
  {
    name: "top_values",
    description: "Get most frequent values in a column",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: "Table name" },
        column: { type: "string", description: "Column name" },
        limit: { type: "number", description: "Number of values" },
      },
      required: ["table", "column"],
    },
  },
  {
    name: "data_quality_check",
    description: "Run a data quality audit on a table",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: "Table name" },
      },
      required: ["table"],
    },
  },
  {
    name: "time_series",
    description: "Aggregate a metric over time",
    input_schema: {
      type: "object" as const,
      properties: {
        table: { type: "string", description: "Table name" },
        dateColumn: { type: "string", description: "Date column" },
        valueColumn: { type: "string", description: "Numeric column" },
        aggregation: { type: "string", description: "sum, avg, count, min, max" },
        period: { type: "string", description: "hour, day, week, month, year" },
      },
      required: ["table", "dateColumn", "valueColumn"],
    },
  },
];

const SYSTEM_PROMPT = `You are an expert data analyst assistant with direct access to a SQLite database via tools.

APPROACH:
- When asked about data, ALWAYS use the available tools to get real data
- Start by sampling or querying the relevant table
- Use column_stats and top_values to understand distributions
- Use time_series for trend analysis
- Use data_quality_check to audit data quality
- Chain multiple tool calls to build a complete picture
- After getting data, explain findings in plain business language
- Always show the actual numbers from the data
- Only write SELECT queries, never INSERT/UPDATE/DELETE`;

export async function POST(req: NextRequest) {
  const { messages, model, schema } = await req.json();

  const systemWithSchema = `${SYSTEM_PROMPT}\n\nDATABASE SCHEMA:\n${schema}`;
  const encoder = new TextEncoder();

  // Helper to send SSE events
  function makeStream(fn: (controller: ReadableStreamDefaultController) => Promise<void>) {
    return new ReadableStream({ start: fn });
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────
  if (model === "gemini") {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    const geminiModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: systemWithSchema,
      tools: geminiTools,
    });

    const readable = makeStream(async (controller) => {
      try {
        await initMCP();

        const history = messages.slice(0, -1).map((m: Message) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

        const chat = geminiModel.startChat({ history });
        let lastMessage = messages[messages.length - 1].content;

        // Agentic loop
        for (let i = 0; i < 10; i++) {
          const result = await chat.sendMessage(lastMessage);
          const response = result.response;
          const candidate = response.candidates?.[0];
          if (!candidate) break;

          const textParts = candidate.content.parts.filter((p) => p.text);
          const funcParts = candidate.content.parts.filter((p) => p.functionCall);

          // Stream any text
          for (const part of textParts) {
            if (part.text) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: part.text })}\n\n`)
              );
            }
          }

          // If no tool calls, we're done
          if (funcParts.length === 0) break;

          // Execute tool calls
          const toolResults = [];
          for (const part of funcParts) {
            const fn = part.functionCall!;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ toolCall: { name: fn.name, args: fn.args } })}\n\n`)
            );
            try {
              const result = await callMCPTool(fn.name, fn.args as Record<string, unknown>);
              const resultText = JSON.stringify(result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2);
              toolResults.push({
                functionResponse: {
                  name: fn.name,
                  response: { result: resultText },
                },
              });
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ toolResult: { name: fn.name, result: resultText } })}\n\n`)
              );
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              toolResults.push({
                functionResponse: {
                  name: fn.name,
                  response: { error: errMsg },
                },
              });
            }
          }

          // Feed results back
          lastMessage = toolResults as unknown as string;
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `Error: ${msg}` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  if (model === "openai") {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const readable = makeStream(async (controller) => {
      try {
        await initMCP();

        const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: systemWithSchema },
          ...messages.map((m: Message) => ({ role: m.role, content: m.content })),
        ];

        // Agentic loop
        for (let i = 0; i < 10; i++) {
          const response = await client.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 8000,
            messages: openaiMessages,
            tools: openaiTools,
            tool_choice: "auto",
          });

          const choice = response.choices[0];
          const assistantMsg = choice.message;
          openaiMessages.push(assistantMsg);

          // Stream text content
          if (assistantMsg.content) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text: assistantMsg.content })}\n\n`)
            );
          }

          // If no tool calls, done
          if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) break;
          if (choice.finish_reason === "stop") break;

          // Execute tool calls
          for (const toolCall of assistantMsg.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ toolCall: { name: toolCall.function.name, args } })}\n\n`)
            );

            try {
              const result = await callMCPTool(toolCall.function.name, args);
              const resultText = JSON.stringify(
                result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2
              );
              openaiMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: resultText,
              });
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ toolResult: { name: toolCall.function.name, result: resultText } })}\n\n`)
              );
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              openaiMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: `Error: ${errMsg}`,
              });
            }
          }
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `Error: ${msg}` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  // ── Claude ─────────────────────────────────────────────────────────────────
  if (model === "claude") {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const readable = makeStream(async (controller) => {
      try {
        await initMCP();

        const claudeMessages: Anthropic.MessageParam[] = messages.map((m: Message) => ({
          role: m.role,
          content: m.content,
        }));

        // Agentic loop
        for (let i = 0; i < 10; i++) {
          const response = await client.messages.create({
            model: "claude-sonnet-4-20250514",
            max_tokens: 8000,
            system: systemWithSchema,
            messages: claudeMessages,
            tools: claudeTools,
          });

          // Stream text blocks
          for (const block of response.content) {
            if (block.type === "text") {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: block.text })}\n\n`)
              );
            }
          }

          // If no tool use, done
          const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
          if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") break;

          // Add assistant response to history
          claudeMessages.push({ role: "assistant", content: response.content });

          // Execute tool calls
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of toolUseBlocks) {
            if (block.type !== "tool_use") continue;
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ toolCall: { name: block.name, args: block.input } })}\n\n`)
            );
            try {
              const result = await callMCPTool(block.name, block.input as Record<string, unknown>);
              const resultText = JSON.stringify(
                result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2
              );
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ toolResult: { name: block.name, result: resultText } })}\n\n`)
              );
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${errMsg}`, is_error: true });
            }
          }

          claudeMessages.push({ role: "user", content: toolResults });
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `Error: ${msg}` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  return new Response(JSON.stringify({ error: "Invalid model" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}