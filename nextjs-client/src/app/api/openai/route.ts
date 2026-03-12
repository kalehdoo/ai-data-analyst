import OpenAI from "openai";
import { NextRequest } from "next/server";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  const { prompt } = await req.json();

  if (!process.env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({ error: "OPENAI_API_KEY is not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = await client.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 8000,
    stream: true,
    messages: [
      {
        role: "system",
        content: `You are an expert data analyst with access to a SQLite database.
When analyzing data:
- Show your SQL queries clearly in code blocks
- Present numbers in a readable format
- Give actionable insights not just raw data
- Format your response with clear sections using markdown headers
- Explain your findings in plain business language`,
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta?.content || "";
          if (text) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ text })}\n\n`)
            );
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
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