import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";

async function getFullPrompt(xmlContent: string, jobName: string, mappingType: string, extraInstructions: string, mcpTool: string = "run_infa_to_dbt"): Promise<string> {
  const mcpUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:3001/mcp";

  const initRes = await fetch(mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, clientInfo: { name: "jobs-runner", version: "1.0.0" } },
    }),
  });
  const sessionId = initRes.headers.get("mcp-session-id");

  const toolRes = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: mcpTool,
        arguments: { xml_content: xmlContent, job_name: jobName, mapping_type: mappingType, extra_instructions: extraInstructions },
      },
    }),
  });

  // MCP returns SSE — parse line by line to find the JSON result
  const rawText = await toolRes.text();
  let prompt = null;
  for (const line of rawText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const jsonStr = trimmed.slice(5).trim();
    if (!jsonStr || jsonStr === "[DONE]") continue;
    try {
      const parsed = JSON.parse(jsonStr);
      const text = parsed?.result?.content?.[0]?.text;
      if (text) { prompt = text; break; }
    } catch (_) {}
  }

  if (!prompt) throw new Error("Failed to get prompt from MCP");
  return prompt;
}

const SYSTEM = "You are an expert dbt and Informatica migration engineer. Generate complete, production-ready dbt project files. Be thorough and miss nothing from the XML. Output only code files with clear file path headers like '=== models/staging/stg_xxx.sql ===' before each file.";

export async function POST(req: NextRequest) {
  const { xmlContent, jobName, mappingType, extraInstructions, model = "claude", mcpTool = "run_infa_to_dbt", userApiKeys = {}, role = "unknown" } = await req.json();

const fullPrompt = await getFullPrompt(xmlContent, jobName, mappingType || "", extraInstructions || "", mcpTool);
  const encoder = new TextEncoder();

  // ── Claude ──────────────────────────────────────────────────────────────
  if (model === "claude") {
    const anthropicKey = userApiKeys?.anthropic || (role === "Admin" ? process.env.ANTHROPIC_API_KEY : "") || "";
if (!anthropicKey) throw new Error("No Anthropic API key — add your key in Settings → API Keys");
const client = new Anthropic({ apiKey: anthropicKey });
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = await client.messages.create({
            model: "claude-opus-4-6",
            max_tokens: 8000,
            stream: true,
            system: SYSTEM,
            messages: [{ role: "user", content: fullPrompt }],
          });
          for await (const event of response) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`));
            }
          }
        } catch (e) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`));
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  // ── Gemini ───────────────────────────────────────────────────────────────
  if (model === "gemini") {
    const geminiKey = userApiKeys?.gemini || (role === "Admin" ? process.env.GEMINI_API_KEY : "") || "";
if (!geminiKey) throw new Error("No Gemini API key — add your key in Settings → API Keys");
const genAI = new GoogleGenerativeAI(geminiKey);
    const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: SYSTEM });
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const result = await geminiModel.generateContentStream(fullPrompt);
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        } catch (e) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`));
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  // ── OpenAI ───────────────────────────────────────────────────────────────
  if (model === "openai") {
    const openaiKey = userApiKeys?.openai || (role === "Admin" ? process.env.OPENAI_API_KEY : "") || "";
if (!openaiKey) throw new Error("No OpenAI API key — add your key in Settings → API Keys");
const openai = new OpenAI({ apiKey: openaiKey });
    const stream = new ReadableStream({
      async start(controller) {
        try {
          const response = await openai.chat.completions.create({
            model: "gpt-4o",
            max_tokens: 8000,
            stream: true,
            messages: [
              { role: "system", content: SYSTEM },
              { role: "user", content: fullPrompt },
            ],
          });
          for await (const chunk of response) {
            const text = chunk.choices[0]?.delta?.content || "";
            if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        } catch (e) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: String(e) })}\n\n`));
        } finally {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  return new Response("Unknown model", { status: 400 });
}