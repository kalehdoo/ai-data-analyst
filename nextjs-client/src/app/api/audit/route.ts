import { NextRequest } from "next/server";
import { Database } from "@sqlitecloud/drivers";

export async function POST(req: NextRequest) {
  const data = await req.json();
//   console.log("AUDIT ROUTE RECEIVED:", JSON.stringify(data));

  try {
    const db = new Database(process.env.SQLITE_CLOUD_URL!);
    await db.sql`
      INSERT INTO audit_logs (username, role, action_type, details, model, context_mode, duration_ms, row_count, status, error_msg)
      VALUES (
        ${data.username || "unknown"},
        ${data.role || "unknown"},
        ${data.action_type || "unknown"},
        ${data.details || null},
        ${data.model || null},
        ${data.context_mode || null},
        ${data.duration_ms || null},
        ${data.row_count || null},
        ${data.status || "success"},
        ${data.error_msg || null}
      )
    `;
  } catch (e) {
    console.error("AUDIT ROUTE CRASH:", e);
    return new Response("error", { status: 500 });
  }

  return new Response("ok");
}