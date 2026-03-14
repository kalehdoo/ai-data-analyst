import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

interface Message {
  role: "user" | "assistant";
  content: string;
}

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
        params: { name: "write_audit_log", arguments: data },
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

// ── Tool definitions ──────────────────────────────────────────────────────────

const geminiTools: { functionDeclarations: { name: string; description: string; parameters: unknown }[] }[] = [{
  functionDeclarations: [
    { name: "execute_query", description: "Run a read-only SELECT query against the SQLite database", parameters: { type: SchemaType.OBJECT, properties: { sql: { type: SchemaType.STRING, description: "The SELECT SQL query to execute" }, limit: { type: SchemaType.NUMBER, description: "Maximum rows to return (default 100)" } }, required: ["sql"] } },
    { name: "sample_table", description: "Get a random sample of rows from a table", parameters: { type: SchemaType.OBJECT, properties: { table: { type: SchemaType.STRING, description: "Table name" }, limit: { type: SchemaType.NUMBER, description: "Number of rows (default 25)" } }, required: ["table"] } },
    { name: "column_stats", description: "Get statistics for a column: min, max, avg, nulls, distinct count", parameters: { type: SchemaType.OBJECT, properties: { table: { type: SchemaType.STRING, description: "Table name" }, column: { type: SchemaType.STRING, description: "Column name" } }, required: ["table", "column"] } },
    { name: "top_values", description: "Get most frequent values in a column", parameters: { type: SchemaType.OBJECT, properties: { table: { type: SchemaType.STRING, description: "Table name" }, column: { type: SchemaType.STRING, description: "Column name" }, limit: { type: SchemaType.NUMBER, description: "Number of top values" } }, required: ["table", "column"] } },
    { name: "data_quality_check", description: "Run a data quality audit on a table", parameters: { type: SchemaType.OBJECT, properties: { table: { type: SchemaType.STRING, description: "Table name" } }, required: ["table"] } },
    { name: "time_series", description: "Aggregate a metric over time", parameters: { type: SchemaType.OBJECT, properties: { table: { type: SchemaType.STRING, description: "Table name" }, dateColumn: { type: SchemaType.STRING, description: "Date column" }, valueColumn: { type: SchemaType.STRING, description: "Numeric column to aggregate" }, aggregation: { type: SchemaType.STRING, description: "sum, avg, count, min, or max" }, period: { type: SchemaType.STRING, description: "hour, day, week, month, or year" } }, required: ["table", "dateColumn", "valueColumn"] } },
    { name: "dbt_list_models", description: "List all dbt ETL pipeline models grouped by layer. IMPORTANT: Snowflake models only — never run SQL via execute_query.", parameters: { type: SchemaType.OBJECT, properties: { layer: { type: SchemaType.STRING, description: "Filter by layer: source, staging, intermediate, mart, or all" } }, required: [] } },
    { name: "dbt_get_model", description: "Get full details of a dbt model including all columns. IMPORTANT: Snowflake model — do not run SQL via execute_query.", parameters: { type: SchemaType.OBJECT, properties: { model_name: { type: SchemaType.STRING, description: "Name of the dbt model e.g. stg_orders, fct_orders" } }, required: ["model_name"] } },
    { name: "dbt_get_lineage", description: "Get upstream and downstream lineage for a dbt model.", parameters: { type: SchemaType.OBJECT, properties: { model_name: { type: SchemaType.STRING, description: "Name of the dbt model" }, depth: { type: SchemaType.NUMBER, description: "How many levels to traverse (default 1, max 5)" } }, required: ["model_name"] } },
    { name: "dbt_search_column", description: "Search for a column across ALL dbt models — use when asked which tables have a specific column.", parameters: { type: SchemaType.OBJECT, properties: { column_name: { type: SchemaType.STRING, description: "Column name to search for (partial match supported)" } }, required: ["column_name"] } },
    { name: "dbt_impact_analysis", description: "Analyze the full downstream impact of changing or removing a dbt model.", parameters: { type: SchemaType.OBJECT, properties: { model_name: { type: SchemaType.STRING, description: "The model you plan to change or remove" } }, required: ["model_name"] } },
  ],
}];

const openaiTools: OpenAI.Chat.ChatCompletionTool[] = [
  { type: "function", function: { name: "execute_query", description: "Run a read-only SELECT query against the SQLite database", parameters: { type: "object", properties: { sql: { type: "string", description: "The SELECT SQL query" }, limit: { type: "number", description: "Max rows to return" } }, required: ["sql"] } } },
  { type: "function", function: { name: "sample_table", description: "Get a random sample of rows from a table", parameters: { type: "object", properties: { table: { type: "string", description: "Table name" }, limit: { type: "number", description: "Number of rows" } }, required: ["table"] } } },
  { type: "function", function: { name: "column_stats", description: "Get statistics for a column", parameters: { type: "object", properties: { table: { type: "string", description: "Table name" }, column: { type: "string", description: "Column name" } }, required: ["table", "column"] } } },
  { type: "function", function: { name: "top_values", description: "Get most frequent values in a column", parameters: { type: "object", properties: { table: { type: "string", description: "Table name" }, column: { type: "string", description: "Column name" }, limit: { type: "number", description: "Number of top values" } }, required: ["table", "column"] } } },
  { type: "function", function: { name: "data_quality_check", description: "Run a data quality audit on a table", parameters: { type: "object", properties: { table: { type: "string", description: "Table name" } }, required: ["table"] } } },
  { type: "function", function: { name: "time_series", description: "Aggregate a metric over time", parameters: { type: "object", properties: { table: { type: "string", description: "Table name" }, dateColumn: { type: "string", description: "Date column" }, valueColumn: { type: "string", description: "Numeric column" }, aggregation: { type: "string", description: "sum, avg, count, min, max" }, period: { type: "string", description: "hour, day, week, month, year" } }, required: ["table", "dateColumn", "valueColumn"] } } },
  { type: "function", function: { name: "dbt_list_models", description: "List all dbt ETL pipeline models grouped by layer (source, staging, intermediate, mart)", parameters: { type: "object", properties: { layer: { type: "string", description: "Filter by layer: source, staging, intermediate, mart, or all" } }, required: [] } } },
  { type: "function", function: { name: "dbt_get_model", description: "Get full details of a dbt model including all columns, descriptions and data types", parameters: { type: "object", properties: { model_name: { type: "string", description: "Name of the dbt model e.g. stg_orders, fct_orders" } }, required: ["model_name"] } } },
  { type: "function", function: { name: "dbt_get_lineage", description: "Get upstream and downstream lineage for a dbt model", parameters: { type: "object", properties: { model_name: { type: "string", description: "Name of the dbt model" }, depth: { type: "number", description: "How many levels to traverse (default 1, max 5)" } }, required: ["model_name"] } } },
  { type: "function", function: { name: "dbt_search_column", description: "Search for a column name across ALL dbt models and sources", parameters: { type: "object", properties: { column_name: { type: "string", description: "Column name to search for (partial match supported)" } }, required: ["column_name"] } } },
  { type: "function", function: { name: "dbt_impact_analysis", description: "Analyze the full downstream impact of changing or removing a dbt model", parameters: { type: "object", properties: { model_name: { type: "string", description: "The model you plan to change or remove" } }, required: ["model_name"] } } },
];

const claudeTools: Anthropic.Tool[] = [
  { name: "execute_query", description: "Run a read-only SELECT query against the SQLite database", input_schema: { type: "object" as const, properties: { sql: { type: "string", description: "The SELECT SQL query" }, limit: { type: "number", description: "Max rows to return" } }, required: ["sql"] } },
  { name: "sample_table", description: "Get a random sample of rows from a table", input_schema: { type: "object" as const, properties: { table: { type: "string", description: "Table name" }, limit: { type: "number", description: "Number of rows" } }, required: ["table"] } },
  { name: "column_stats", description: "Get statistics for a column", input_schema: { type: "object" as const, properties: { table: { type: "string", description: "Table name" }, column: { type: "string", description: "Column name" } }, required: ["table", "column"] } },
  { name: "top_values", description: "Get most frequent values in a column", input_schema: { type: "object" as const, properties: { table: { type: "string", description: "Table name" }, column: { type: "string", description: "Column name" }, limit: { type: "number", description: "Number of values" } }, required: ["table", "column"] } },
  { name: "data_quality_check", description: "Run a data quality audit on a table", input_schema: { type: "object" as const, properties: { table: { type: "string", description: "Table name" } }, required: ["table"] } },
  { name: "time_series", description: "Aggregate a metric over time", input_schema: { type: "object" as const, properties: { table: { type: "string", description: "Table name" }, dateColumn: { type: "string", description: "Date column" }, valueColumn: { type: "string", description: "Numeric column" }, aggregation: { type: "string", description: "sum, avg, count, min, max" }, period: { type: "string", description: "hour, day, week, month, year" } }, required: ["table", "dateColumn", "valueColumn"] } },
  { name: "dbt_list_models", description: "List all dbt ETL pipeline models grouped by layer", input_schema: { type: "object" as const, properties: { layer: { type: "string", description: "Filter by layer: source, staging, intermediate, mart, or all" } }, required: [] } },
  { name: "dbt_get_model", description: "Get full details of a dbt model including all columns", input_schema: { type: "object" as const, properties: { model_name: { type: "string", description: "Name of the dbt model" } }, required: ["model_name"] } },
  { name: "dbt_get_lineage", description: "Get upstream and downstream lineage for a dbt model", input_schema: { type: "object" as const, properties: { model_name: { type: "string", description: "Name of the dbt model" }, depth: { type: "number", description: "Levels to traverse (default 1, max 5)" } }, required: ["model_name"] } },
  { name: "dbt_search_column", description: "Search for a column name across ALL dbt models and sources", input_schema: { type: "object" as const, properties: { column_name: { type: "string", description: "Column name to search for" } }, required: ["column_name"] } },
  { name: "dbt_impact_analysis", description: "Analyze the full downstream impact of changing or removing a dbt model", input_schema: { type: "object" as const, properties: { model_name: { type: "string", description: "The model you plan to change or remove" } }, required: ["model_name"] } },
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
    return `${base}\nYou are in SQLITE MODE — only query the live SQLite database.\n${dbSection}\nRULES:\n- Only use database tools\n- Do NOT use dbt_ tools\n- Always run queries and show real results`;
  }
  if (contextMode === "dbt") {
    return `${base}\nYou are in DBT MODE — only use the dbt manifest.\n${dbtSection}\nRULES:\n- Only use dbt_ tools\n- Do NOT call execute_query\n- Always add comment: -- ⚠ Run this in Snowflake, not SQLite`;
  }
  return `${base}\nYou are in BOTH MODE — use SQLite for live data AND dbt manifest for schema understanding.\n${dbSection}\n${dbtSection}\nRULES:\n- Use dbt_ tools for schema and lineage\n- Use database tools for live SQLite data\n- Clearly label which world each answer comes from`;
}

// ── Helper: resolve API key (Admin gets server fallback, others must provide own) ──
function resolveKey(userKey: string | undefined, envKey: string | undefined, role: string): string {
  if (userKey) return userKey;
  if (role === "Admin" && envKey) return envKey;
  return "";
}

export async function POST(req: NextRequest) {
  const {
    messages,
    model,
    schema,
    contextMode = "sqlite",
    username = "unknown",
    role = "unknown",
    userApiKeys = {},
  } = await req.json();

  const systemWithSchema = buildSystemPrompt(contextMode, schema);
  const encoder = new TextEncoder();

  function makeStream(fn: (controller: ReadableStreamDefaultController) => Promise<void>) {
    return new ReadableStream({ start: fn });
  }

  // ── Gemini ──────────────────────────────────────────────────────────────────
  if (model === "gemini") {
    const geminiKey = resolveKey(userApiKeys?.gemini, process.env.GEMINI_API_KEY, role);
    if (!geminiKey) {
      return new Response(
        `data: ${JSON.stringify({ text: "❌ No Gemini API key found. Please add your Gemini API key in **Settings → API Keys**." })}\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    const genAI = new GoogleGenerativeAI(geminiKey);
    const chatStart = Date.now();
    const userMessage = messages[messages.length - 1]?.content?.slice(0, 500) || "";

    const geminiModel = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: systemWithSchema,
      tools: [{ functionDeclarations: (geminiTools[0] as any).functionDeclarations.filter((t: any) => {
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

        for (let i = 0; i < 10; i++) {
          const result = await chat.sendMessage(lastMessage);
          const response = result.response;
          const candidate = response.candidates?.[0];
          if (!candidate) break;

          const textParts = candidate.content.parts.filter((p) => p.text);
          const funcParts = candidate.content.parts.filter((p) => p.functionCall);

          for (const part of textParts) {
            if (part.text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: part.text })}\n\n`));
          }

          if (funcParts.length === 0) break;

          const toolResults = [];
          for (const part of funcParts) {
            const fn = part.functionCall!;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ toolCall: { name: fn.name, args: fn.args } })}\n\n`));
            try {
              const result = await callMCPTool(fn.name, fn.args as Record<string, unknown>);
              const resultText = JSON.stringify(result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2);
              toolResults.push({ functionResponse: { name: fn.name, response: { result: resultText } } });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ toolResult: { name: fn.name, result: resultText } })}\n\n`));
            } catch (e) {
              toolResults.push({ functionResponse: { name: fn.name, response: { error: e instanceof Error ? e.message : String(e) } } });
            }
          }
          lastMessage = toolResults as unknown as string;
        }

        await logToAudit({ username, role, action_type: "ai_chat", details: userMessage, model: "gemini", context_mode: contextMode, duration_ms: Date.now() - chatStart, status: "success" });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `Error: ${msg}` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  }

  // ── OpenAI ──────────────────────────────────────────────────────────────────
  if (model === "openai") {
    const openaiKey = resolveKey(userApiKeys?.openai, process.env.OPENAI_API_KEY, role);
    if (!openaiKey) {
      return new Response(
        `data: ${JSON.stringify({ text: "❌ No OpenAI API key found. Please add your OpenAI API key in **Settings → API Keys**." })}\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    const openai = new OpenAI({ apiKey: openaiKey });
    const chatStart = Date.now();
    const userMessage = messages[messages.length - 1]?.content?.slice(0, 500) || "";

    const readable = makeStream(async (controller) => {
      try {
        await initMCP();
        const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
          { role: "system", content: systemWithSchema },
          ...messages.map((m: Message) => ({ role: m.role, content: m.content })),
        ];

        for (let i = 0; i < 10; i++) {
          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            max_tokens: 8000,
            messages: openaiMessages,
            tools: openaiTools.filter((t: any) => {
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

          if (assistantMsg.content) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: assistantMsg.content })}\n\n`));
          if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0 || choice.finish_reason === "stop") break;

          for (const toolCall of assistantMsg.tool_calls as any[]) {
            const args = JSON.parse(toolCall.function.arguments);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ toolCall: { name: toolCall.function.name, args } })}\n\n`));
            try {
              const result = await callMCPTool(toolCall.function.name, args);
              const resultText = JSON.stringify(result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2);
              openaiMessages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ toolResult: { name: toolCall.function.name, result: resultText } })}\n\n`));
            } catch (e) {
              openaiMessages.push({ role: "tool", tool_call_id: toolCall.id, content: `Error: ${e instanceof Error ? e.message : String(e)}` });
            }
          }
        }

        await logToAudit({ username, role, action_type: "ai_chat", details: userMessage, model: "openai", context_mode: contextMode, duration_ms: Date.now() - chatStart, status: "success" });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `Error: ${msg}` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  }

  // ── Claude ──────────────────────────────────────────────────────────────────
  if (model === "claude") {
    const anthropicKey = resolveKey(userApiKeys?.anthropic, process.env.ANTHROPIC_API_KEY, role);
    if (!anthropicKey) {
      return new Response(
        `data: ${JSON.stringify({ text: "❌ No Anthropic API key found. Please add your Anthropic API key in **Settings → API Keys**." })}\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } }
      );
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });
    const chatStart = Date.now();
    const userMessage = messages[messages.length - 1]?.content?.slice(0, 500) || "";

    const readable = makeStream(async (controller) => {
      try {
        await initMCP();
        const claudeMessages: Anthropic.MessageParam[] = messages.map((m: Message) => ({
          role: m.role,
          content: m.content,
        }));

        for (let i = 0; i < 10; i++) {
          const response = await anthropic.messages.create({
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

          for (const block of response.content) {
            if (block.type === "text") controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: block.text })}\n\n`));
          }

          const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
          if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") break;

          claudeMessages.push({ role: "assistant", content: response.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of toolUseBlocks) {
            if (block.type !== "tool_use") continue;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ toolCall: { name: block.name, args: block.input } })}\n\n`));
            try {
              const result = await callMCPTool(block.name, block.input as Record<string, unknown>);
              const resultText = JSON.stringify(result.content?.[0]?.text ? JSON.parse(result.content[0].text) : result, null, 2);
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: resultText });
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ toolResult: { name: block.name, result: resultText } })}\n\n`));
            } catch (e) {
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${e instanceof Error ? e.message : String(e)}`, is_error: true });
            }
          }
          claudeMessages.push({ role: "user", content: toolResults });
        }

        await logToAudit({ username, role, action_type: "ai_chat", details: userMessage, model: "claude", context_mode: contextMode, duration_ms: Date.now() - chatStart, status: "success" });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: `Error: ${msg}` })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  }

  return new Response(JSON.stringify({ error: "Invalid model" }), { status: 400, headers: { "Content-Type": "application/json" } });
}
