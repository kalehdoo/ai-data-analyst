import { GoogleGenerativeAI, SchemaType, Tool as GeminiTool } from "@google/generative-ai";
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

async function logToAudit(data: {
  username: string;
  role: string;
  action_type: string;
  details?: string;
  model?: string;
  context_mode?: string;
  duration_ms?: number;
  status?: string;
  error_msg?: string;
}) {
  try {
    const mcpUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:3001/mcp";
    await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "write_audit_log",
          arguments: data,
        },
      }),
    });
  } catch (_) {}
}

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
    let parsed = null;
    // Find the line with actual result — skip [DONE] and empty lines
    for (const line of lines) {
      const jsonStr = line.replace("data: ", "").trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const candidate = JSON.parse(jsonStr);
        if (candidate?.result !== undefined || candidate?.error !== undefined) {
          parsed = candidate;
          break;
        }
      } catch (_) {}
    }
    data = parsed ?? { error: { message: "Empty or unparseable SSE stream" } };
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
        type: SchemaType.OBJECT,
        properties: {
          sql: { type: SchemaType.STRING, description: "The SELECT SQL query to execute" },
          limit: { type: SchemaType.NUMBER, description: "Maximum rows to return (default 100)" },
        },
        required: ["sql"],
      },
    },
    {
      name: "sample_table",
      description: "Get a random sample of rows from a table",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          table: { type: SchemaType.STRING, description: "Table name" },
          limit: { type: SchemaType.NUMBER, description: "Number of rows (default 25)" },
        },
        required: ["table"],
      },
    },
    {
      name: "column_stats",
      description: "Get statistics for a column: min, max, avg, nulls, distinct count",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          table: { type: SchemaType.STRING, description: "Table name" },
          column: { type: SchemaType.STRING, description: "Column name" },
        },
        required: ["table", "column"],
      },
    },
    {
      name: "top_values",
      description: "Get most frequent values in a column",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          table: { type: SchemaType.STRING, description: "Table name" },
          column: { type: SchemaType.STRING, description: "Column name" },
          limit: { type: SchemaType.NUMBER, description: "Number of top values" },
        },
        required: ["table", "column"],
      },
    },
    {
      name: "data_quality_check",
      description: "Run a data quality audit on a table",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          table: { type: SchemaType.STRING, description: "Table name" },
        },
        required: ["table"],
      },
    },
    {
      name: "time_series",
      description: "Aggregate a metric over time",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          table: { type: SchemaType.STRING, description: "Table name" },
          dateColumn: { type: SchemaType.STRING, description: "Date column" },
          valueColumn: { type: SchemaType.STRING, description: "Numeric column to aggregate" },
          aggregation: { type: SchemaType.STRING, description: "sum, avg, count, min, or max" },
          period: { type: SchemaType.STRING, description: "hour, day, week, month, or year" },
        },
        required: ["table", "dateColumn", "valueColumn"],
      },
    },
    {
      name: "dbt_list_models",
      description: "List all dbt ETL pipeline models grouped by layer (source, staging, intermediate, mart)",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          layer: { type: SchemaType.STRING, description: "Filter by layer: source, staging, intermediate, mart, or all" },
        },
        required: [],
      },
    },
    {
      name: "dbt_get_model",
      description: "Get full details of a dbt model including all columns, descriptions and data types",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          model_name: { type: SchemaType.STRING, description: "Name of the dbt model e.g. stg_orders, fct_orders" },
        },
        required: ["model_name"],
      },
    },
    {
      name: "dbt_get_lineage",
      description: "Get upstream and downstream lineage for a dbt model — shows where data comes from and where it goes",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          model_name: { type: SchemaType.STRING, description: "Name of the dbt model" },
          depth: { type: SchemaType.NUMBER, description: "How many levels to traverse (default 1, max 5)" },
        },
        required: ["model_name"],
      },
    },
    {
      name: "dbt_search_column",
      description: "Search for a column name across ALL dbt models and sources — use this when asked which tables or models have a specific column or field",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          column_name: { type: SchemaType.STRING, description: "Column name to search for (partial match supported)" },
        },
        required: ["column_name"],
      },
    },
    {
      name: "dbt_impact_analysis",
      description: "Analyze the full downstream impact of changing or removing a dbt model",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          model_name: { type: SchemaType.STRING, description: "The model you plan to change or remove" },
        },
        required: ["model_name"],
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
  {
    type: "function",
    function: {
      name: "dbt_list_models",
      description: "List all dbt ETL pipeline models grouped by layer (source, staging, intermediate, mart)",
      parameters: {
        type: "object",
        properties: {
          layer: { type: "string", description: "Filter by layer: source, staging, intermediate, mart, or all" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbt_get_model",
      description: "Get full details of a dbt model including all columns, descriptions and data types",
      parameters: {
        type: "object",
        properties: {
          model_name: { type: "string", description: "Name of the dbt model e.g. stg_orders, fct_orders" },
        },
        required: ["model_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbt_get_lineage",
      description: "Get upstream and downstream lineage for a dbt model — shows where data comes from and where it goes",
      parameters: {
        type: "object",
        properties: {
          model_name: { type: "string", description: "Name of the dbt model" },
          depth: { type: "number", description: "How many levels to traverse (default 1, max 5)" },
        },
        required: ["model_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbt_search_column",
      description: "Search for a column name across ALL dbt models and sources — use this when asked which tables or models have a specific column or field",
      parameters: {
        type: "object",
        properties: {
          column_name: { type: "string", description: "Column name to search for (partial match supported)" },
        },
        required: ["column_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dbt_impact_analysis",
      description: "Analyze the full downstream impact of changing or removing a dbt model",
      parameters: {
        type: "object",
        properties: {
          model_name: { type: "string", description: "The model you plan to change or remove" },
        },
        required: ["model_name"],
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
      type: SchemaType.OBJECT,
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
      type: SchemaType.OBJECT,
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
      type: SchemaType.OBJECT,
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
      type: SchemaType.OBJECT,
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
      type: SchemaType.OBJECT,
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
      type: SchemaType.OBJECT,
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
  {
    name: "dbt_list_models",
    description: "List all dbt ETL pipeline models grouped by layer (source, staging, intermediate, mart)",
    input_schema: {
      type: SchemaType.OBJECT,
      properties: {
        layer: { type: "string", description: "Filter by layer: source, staging, intermediate, mart, or all" },
      },
      required: [],
    },
  },
  {
    name: "dbt_get_model",
    description: "Get full details of a dbt model including all columns, descriptions and data types",
    input_schema: {
      type: SchemaType.OBJECT,
      properties: {
        model_name: { type: "string", description: "Name of the dbt model" },
      },
      required: ["model_name"],
    },
  },
  {
    name: "dbt_get_lineage",
    description: "Get upstream and downstream lineage for a dbt model",
    input_schema: {
      type: SchemaType.OBJECT,
      properties: {
        model_name: { type: "string", description: "Name of the dbt model" },
        depth: { type: "number", description: "Levels to traverse (default 1, max 5)" },
      },
      required: ["model_name"],
    },
  },
  {
    name: "dbt_search_column",
    description: "Search for a column name across ALL dbt models and sources — use this when asked which tables or models have a specific column or field",
    input_schema: {
      type: SchemaType.OBJECT,
      properties: {
        column_name: { type: "string", description: "Column name to search for" },
      },
      required: ["column_name"],
    },
  },
  {
    name: "dbt_impact_analysis",
    description: "Analyze the full downstream impact of changing or removing a dbt model",
    input_schema: {
      type: SchemaType.OBJECT,
      properties: {
        model_name: { type: "string", description: "The model you plan to change or remove" },
      },
      required: ["model_name"],
    },
  },
];

function buildSystemPrompt(contextMode: string, schema: string): string {
  const dbSection = `DATABASE (SQLite):
- Use execute_query, sample_table, column_stats, top_values, time_series for live data
- Only SELECT queries — never INSERT/UPDATE/DELETE
- Results are real live data from SQLite Cloud

DATABASE SCHEMA:
${schema}`;

  const dbtSection = `dbt ETL PIPELINE (Snowflake):
- Use dbt_list_models, dbt_get_model, dbt_get_lineage, dbt_search_column, dbt_impact_analysis
- These tools read the dbt manifest — schema definitions only, NO live data
- When writing SQL in dbt mode, write Snowflake-compatible SQL
- ALWAYS label dbt SQL clearly: add a comment -- Run this in Snowflake (not SQLite)
- NEVER call execute_query with dbt model names — they don't exist in SQLite`;

  const base = `You are an expert data analyst and data engineer assistant.`;

  if (contextMode === "sqlite") {
    return `${base}

You are in SQLITE MODE — only query the live SQLite database.
${dbSection}

RULES:
- Only use database tools (execute_query, sample_table etc.)
- Do NOT use dbt_ tools
- Always run queries and show real results`;
  }

  if (contextMode === "dbt") {
    return `${base}

You are in DBT MODE — only use the dbt manifest to answer questions.
${dbtSection}

RULES:
- Only use dbt_ tools (dbt_list_models, dbt_get_model, dbt_get_lineage, dbt_search_column, dbt_impact_analysis)
- Do NOT call execute_query — dbt tables do not exist in SQLite
- When you write SQL, always add the comment: -- ⚠ Run this in Snowflake, not SQLite
- Explain which dbt models are relevant and why
- Format SQL clearly so the user can copy and run it in Snowflake`;
  }

  // both
  return `${base}

You are in BOTH MODE — use SQLite for live data AND dbt manifest for schema understanding.
${dbSection}

${dbtSection}

RULES:
- Use dbt_ tools to understand schema and lineage
- Use database tools to query live SQLite data
- Clearly label which world each answer comes from:
  - "From SQLite (live data):" for database results
  - "From dbt manifest (Snowflake schema):" for dbt results
- If a question asks about a table that exists in dbt but NOT in SQLite, explain this clearly
- Never run execute_query with dbt model names`;
}

export async function POST(req: NextRequest) {
  const { messages, model, schema, contextMode = "sqlite", username = "unknown", role = "unknown" } = await req.json();

  const systemWithSchema = buildSystemPrompt(contextMode, schema);
  const encoder = new TextEncoder();

  // Helper to send SSE events
  function makeStream(fn: (controller: ReadableStreamDefaultController) => Promise<void>) {
    return new ReadableStream({ start: fn });
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────
  if (model === "gemini") {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    const chatStart = Date.now();
    const userMessage = messages[messages.length - 1]?.content?.slice(0, 500) || "";
    const geminiModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: systemWithSchema,
      tools: [{ functionDeclarations: geminiTools[0].functionDeclarations.filter((t) => {
  const isDbtTool = t.name.startsWith("dbt_");
  if (contextMode === "sqlite") return !isDbtTool;
  if (contextMode === "dbt") return isDbtTool;
  return true;
})}],
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
            await logToAudit({
          username, role,
          action_type: "ai_chat",
          details: userMessage,
          model: "gemini",
          context_mode: contextMode,
          duration_ms: Date.now() - chatStart,
          status: "success",
        });
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

    const chatStart = Date.now();
    const userMessage = messages[messages.length - 1]?.content?.slice(0, 500) || "";
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
            tools: openaiTools.filter((t) => {
  const isDbtTool = t.function.name.startsWith("dbt_");
  if (contextMode === "sqlite") return !isDbtTool;
  if (contextMode === "dbt") return isDbtTool;
  return true;
}),
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

        await logToAudit({
          username, role,
          action_type: "ai_chat",
          details: userMessage,
          model: "gemini",
          context_mode: contextMode,
          duration_ms: Date.now() - chatStart,
          status: "success",
        });
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

    const chatStart = Date.now();
    const userMessage = messages[messages.length - 1]?.content?.slice(0, 500) || "";
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
            tools: claudeTools.filter((t) => {
  const isDbtTool = t.name.startsWith("dbt_");
  if (contextMode === "sqlite") return !isDbtTool;
  if (contextMode === "dbt") return isDbtTool;
  return true;
}),
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

        await logToAudit({
          username, role,
          action_type: "ai_chat",
          details: userMessage,
          model: "gemini",
          context_mode: contextMode,
          duration_ms: Date.now() - chatStart,
          status: "success",
        });
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