import { NextRequest } from "next/server";
import { Database } from "@sqlitecloud/drivers";

export async function POST(req: NextRequest) {
  // Verify secret token
  const auth = req.headers.get("x-webhook-secret");
  if (auth !== process.env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = new Database(process.env.SQLITE_CLOUD_URL!);

  try {
    // Get all pinned queries
    const pinnedRows = await db.sql`
      SELECT id, name, description, sql, tags FROM saved_queries WHERE is_pinned = 1
    `;

    const results = [];

    for (const query of pinnedRows) {
      const start = Date.now();
      try {
        const rows = await db.sql(
          query.sql.trim().replace(/;+$/, "").replace(/\bLIMIT\b.*/i, "") + " LIMIT 1000"
        );
        const duration_ms = Date.now() - start;
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        // Check thresholds from tags e.g. "threshold:row_count>0"
        const tags = (query.tags || "").split(",").map((t: string) => t.trim());
        const thresholdTag = tags.find((t: string) => t.startsWith("threshold:"));
        let alert = null;

        if (thresholdTag) {
          const rule = thresholdTag.replace("threshold:", "");
          // e.g. "row_count>100" or "row_count=0"
          const match = rule.match(/(\w+)(>|<|=|>=|<=)(\d+)/);
          if (match) {
            const [, field, op, val] = match;
            const actual = field === "row_count" ? rows.length : (rows[0]?.[field] ?? 0);
            const threshold = Number(val);
            const breached =
              op === ">"  ? actual > threshold :
              op === "<"  ? actual < threshold :
              op === ">=" ? actual >= threshold :
              op === "<=" ? actual <= threshold :
              op === "="  ? actual === threshold : false;

            if (breached) {
              alert = { rule, actual, threshold, field, op };
            }
          }
        }

        // Log to audit
        await db.sql`
          INSERT INTO audit_logs (username, role, action_type, details, duration_ms, row_count, status)
          VALUES ('n8n', 'automation', 'query', ${query.sql}, ${duration_ms}, ${rows.length}, 'success')
        `;

        results.push({
          id: query.id,
          name: query.name,
          description: query.description || "",
          tags: query.tags || "",
          row_count: rows.length,
          columns,
          preview: rows.slice(0, 5),
          duration_ms,
          status: "success",
          alert,
        });
      } catch (e: unknown) {
        results.push({
          id: query.id,
          name: query.name,
          description: query.description || "",
          tags: query.tags || "",
          row_count: 0,
          columns: [],
          preview: [],
          duration_ms: Date.now() - start,
          status: "error",
          error: e instanceof Error ? e.message : String(e),
          alert: null,
        });
      }
    }

    const alerts = results.filter((r) => r.alert);
    const errors = results.filter((r) => r.status === "error");

    return Response.json({
      success: true,
      timestamp: new Date().toISOString(),
      total_queries: results.length,
      alerts_fired: alerts.length,
      errors: errors.length,
      results,
      summary: results.map((r) => ({
        name: r.name,
        rows: r.row_count,
        ms: r.duration_ms,
        status: r.status,
        alert: r.alert ? `⚠ ${r.alert.field} ${r.alert.op} ${r.alert.threshold} (actual: ${r.alert.actual})` : null,
      })),
    });
  } catch (e: unknown) {
    return Response.json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ status: "RANA monitor webhook active" });
}

