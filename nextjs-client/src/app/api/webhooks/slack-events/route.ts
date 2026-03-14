import { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  console.log("SLACK EVENT RECEIVED:", JSON.stringify(body));

  // Slack URL verification challenge
  if (body.type === "url_verification") {
    return Response.json({ challenge: body.challenge });
  }

  // Handle message events
  if (body.event && !body.event.bot_id) {
    const text = (body.event.text || "").trim();
    const channel = body.event.channel;

    if (text) {
      fetch(process.env.N8N_WEBHOOK_URL || "", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, channel }),
      }).catch(() => {});
    }
  }

  return Response.json({ ok: true });
}