import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function POST(req: NextRequest) {
  const { prompt } = await req.json();

  const mcpServerUrl = process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:3001/mcp";

  const stream = await client.messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8000,
    system: `You are an expert data analyst with direct access to a SQLite database via MCP tools.
When analyzing data:
- Always start by exploring the schema before querying
- Show your SQL queries clearly
- Present numbers in a readable format
- Give actionable insights, not just raw data
- Format your response with clear sections and markdown`,
    messages: [{ role: "user", content: prompt }],
    // @ts-ignore - MCP servers parameter
    mcp_servers: [
      {
        type: "url",
        url: mcpServerUrl,
        name: "sqlite-analyst",
      },
    ],
  });

  // Stream the response back to the client
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        if (
          chunk.type === "content_block_delta" &&
          chunk.delta.type === "text_delta"
        ) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`)
          );
        }
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}