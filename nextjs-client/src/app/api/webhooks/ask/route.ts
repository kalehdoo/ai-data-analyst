import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Database } from "@sqlitecloud/drivers";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-webhook-secret");
  if (auth !== process.env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { question } = await req.json();
  const db = new Database(process.env.SQLITE_CLOUD_URL!);

  // Get full schema with columns
  const tables = await db.sql`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `;
  const schemaDetails = await Promise.all(
    tables.map(async (t: { name: string }) => {
      const cols = await db.sql(`PRAGMA table_info(${t.name})`);
      const colList = cols.map((c: { name: string; type: string }) =>
        `${c.name} (${c.type})`
      ).join(", ");
      return `${t.name}: ${colList}`;
    })
  );
  const tableNames = schemaDetails.join("\n");

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  // Step 1: Generate SQL
  const sqlResult = await model.generateContent(
    `You are a SQL expert. Write a SQLite SELECT query to answer this question.
AVAILABLE TABLES: ${tableNames}
Rules:
- Only SELECT queries
- Add LIMIT 20 unless counting or aggregating
- Return ONLY the SQL query, no explanation, no backticks, no semicolon

Question: ${question}`
  );

  const sql = sqlResult.response.text().trim().replace(/;+$/, "").replace(/```sql|```/g, "").trim();

  if (!sql) {
    return Response.json({ success: false, error: "Could not generate SQL" });
  }

  // Step 2: Run SQL
  let rows: Record<string, unknown>[] = [];
  let runError = "";
  try {
    rows = await db.sql(sql);
  } catch (e: unknown) {
    runError = e instanceof Error ? e.message : String(e);
  }

  // Step 3: Natural language answer
  const answerResult = await model.generateContent(
    `Question: ${question}
SQL used: ${sql}
Results: ${runError ? `Error: ${runError}` : JSON.stringify(rows.slice(0, 10))}
Answer the question in 2-3 sentences with key numbers. Be concise.`
  );

  const answer = answerResult.response.text().trim();

  // Format table
  let table = "";
  if (rows.length > 0 && !runError) {
    const cols = Object.keys(rows[0]);
    const header = cols.join(" | ");
    const divider = cols.map(() => "---").join(" | ");
    const dataRows = rows.slice(0, 10).map((r) =>
      cols.map((c) => String(r[c] ?? "null")).join(" | ")
    );
    table = [header, divider, ...dataRows].join("\n");
    if (rows.length > 10) table += `\n... and ${rows.length - 10} more rows`;
  }

  return Response.json({
    success: true,
    question,
    sql,
    answer,
    row_count: rows.length,
    table,
    error: runError || null,
  });
}