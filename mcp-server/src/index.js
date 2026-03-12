import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Database } from "@sqlitecloud/drivers";
import { z } from "zod";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

// ─── Database Connection ─────────────────────────────────────────────────────
function getDb() {
  const url = process.env.SQLITE_CLOUD_URL;
  if (!url) throw new Error("SQLITE_CLOUD_URL is not set in .env");
  return new Database(url);
}


async function runReadOnly(sql, params = []) {
  const db = getDb();
  try {
    const result = await db.sql(sql, ...params);
    return Array.isArray(result) ? result : [];
  } finally {
    await db.close();
  }
}

//blocks INSERT, UPDATE, DELETE, DROP
function assertReadOnly(sql) {
  const normalized = sql.trim().toUpperCase();
  const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE"];
  for (const kw of forbidden) {
    if (normalized.startsWith(kw) || new RegExp(`\\b${kw}\\b`).test(normalized)) {
      throw new Error(`Write operation '${kw}' is not allowed. Only SELECT queries are permitted.`);
    }
  }
}

// ─── Setup Server ────────────────────────────────────────────────────────────
function setupServer(server) {

  // ════════════════════════════════════════════════════════════════════════════
  //  RESOURCES
  // ════════════════════════════════════════════════════════════════════════════

  // List all tables and views
  server.resource("schemas://list", "schemas://list", async () => {
    const rows = await runReadOnly(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`
    );
    return {
      contents: [{
        uri: "schemas://list",
        mimeType: "application/json",
        text: JSON.stringify({ tables: rows }, null, 2),
      }],
    };
  });

  // Schema overview (reuse schemas://list for SQLite since there are no schemas)
  server.resource(
    "schema://{schemaName}",
    new ResourceTemplate("schema://{schemaName}", { list: undefined }),
    async (uri) => {
      const rows = await runReadOnly(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`
      );
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ schema: "main", tables: rows }, null, 2),
        }],
      };
    }
  );

  // Table detail: columns, indexes, foreign keys
  server.resource(
    "table://{schemaName}/{tableName}",
    new ResourceTemplate("table://{schemaName}/{tableName}", { list: undefined }),
    async (uri, { tableName }) => {
      const [columns, indexes, foreignKeys] = await Promise.all([
        runReadOnly(`PRAGMA table_info("${tableName}")`),
        runReadOnly(`PRAGMA index_list("${tableName}")`),
        runReadOnly(`PRAGMA foreign_key_list("${tableName}")`),
      ]);

      // Get row count
      let rowCount = 0;
      try {
        const countResult = await runReadOnly(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
        rowCount = countResult[0]?.cnt ?? 0;
      } catch (_) {}

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            table: tableName,
            rowCount,
            columns,
            indexes,
            foreignKeys,
          }, null, 2),
        }],
      };
    }
  );

  // Database stats: row counts per table
  server.resource("stats://database", "stats://database", async () => {
    const tables = await runReadOnly(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    );
    const stats = await Promise.all(
      tables.map(async (t) => {
        try {
          const count = await runReadOnly(`SELECT COUNT(*) as row_count FROM "${t.name}"`);
          return { table: t.name, row_count: count[0]?.row_count ?? 0 };
        } catch {
          return { table: t.name, row_count: "n/a" };
        }
      })
    );
    return {
      contents: [{
        uri: "stats://database",
        mimeType: "application/json",
        text: JSON.stringify({ tableStats: stats }, null, 2),
      }],
    };
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  TOOLS
  // ════════════════════════════════════════════════════════════════════════════

  // Execute any read-only SQL
  server.tool(
    "execute_query",
    "Run a read-only SELECT query against the SQLite Cloud database.",
    {
      sql: z.string().describe("The SELECT SQL query to execute"),
      limit: z.number().optional().default(500).describe("Maximum rows to return"),
    },
    async ({ sql, limit = 500 }) => {
      assertReadOnly(sql);
      const safeLimit = Math.min(limit, 5000);
      const isPragma = /^\s*PRAGMA/i.test(sql);
const hasLimit = /\bLIMIT\b/i.test(sql);
const finalSql = isPragma || hasLimit ? sql : `SELECT * FROM (${sql}) LIMIT ${safeLimit}`;
      const start = Date.now();
      const rows = await runReadOnly(finalSql);
      const elapsed = Date.now() - start;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            rowCount: rows.length,
            executionMs: elapsed,
            columns: rows.length > 0 ? Object.keys(rows[0]).map((name) => ({ name })) : [],
            rows,
          }, null, 2),
        }],
      };
    }
  );

  // Sample random rows from a table
  server.tool(
    "sample_table",
    "Retrieve a random sample of rows from a specific table",
    {
      schema: z.string().default("main"),
      table: z.string().describe("Table name"),
      limit: z.number().optional().default(25),
    },
    async ({ table, limit = 25 }) => {
      const safeLimit = Math.min(limit, 1000);
      const rows = await runReadOnly(
        `SELECT * FROM "${table}" ORDER BY RANDOM() LIMIT ${safeLimit}`
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            table,
            rowCount: rows.length,
            columns: rows.length > 0 ? Object.keys(rows[0]) : [],
            rows,
          }, null, 2),
        }],
      };
    }
  );

  // Column statistics
  server.tool(
    "column_stats",
    "Get statistical summary for a column: nulls, distinct count, min, max, avg",
    {
      schema: z.string().default("main"),
      table: z.string(),
      column: z.string(),
    },
    async ({ table, column }) => {
      const rows = await runReadOnly(`
        SELECT
          COUNT(*) AS total_rows,
          COUNT("${column}") AS non_null_count,
          COUNT(*) - COUNT("${column}") AS null_count,
          ROUND(100.0 * (COUNT(*) - COUNT("${column}")) / MAX(COUNT(*), 1), 2) AS null_pct,
          COUNT(DISTINCT "${column}") AS distinct_count,
          MIN("${column}") AS min_value,
          MAX("${column}") AS max_value,
          AVG(CAST("${column}" AS REAL)) AS mean
        FROM "${table}"
      `);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ table, column, stats: rows[0] }, null, 2),
        }],
      };
    }
  );

  // Top N most frequent values
  server.tool(
    "top_values",
    "Get the most frequent values in a column with their counts",
    {
      schema: z.string().default("main"),
      table: z.string(),
      column: z.string(),
      limit: z.number().optional().default(20),
    },
    async ({ table, column, limit = 20 }) => {
      const rows = await runReadOnly(`
        SELECT
          "${column}" AS value,
          COUNT(*) AS count,
          ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM "${table}"), 2) AS pct
        FROM "${table}"
        WHERE "${column}" IS NOT NULL
        GROUP BY "${column}"
        ORDER BY count DESC
        LIMIT ${Math.min(limit, 100)}
      `);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ table, column, topValues: rows }, null, 2),
        }],
      };
    }
  );

  // Time series aggregation
  server.tool(
    "time_series",
    "Aggregate a numeric column over a date column by period",
    {
      schema: z.string().default("main"),
      table: z.string(),
      dateColumn: z.string().describe("Date or timestamp column"),
      valueColumn: z.string().describe("Numeric column to aggregate"),
      aggregation: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
      period: z.enum(["hour", "day", "week", "month", "year"]).default("day"),
      limit: z.number().optional().default(90),
    },
    async ({ table, dateColumn, valueColumn, aggregation, period, limit = 90 }) => {
      const formatMap = {
        hour:  "%Y-%m-%d %H:00",
        day:   "%Y-%m-%d",
        week:  "%Y-%W",
        month: "%Y-%m",
        year:  "%Y",
      };
      const fmt = formatMap[period];
      const rows = await runReadOnly(`
        SELECT
          strftime('${fmt}', "${dateColumn}") AS period,
          ${aggregation.toUpperCase()}(CAST("${valueColumn}" AS REAL)) AS value,
          COUNT(*) AS row_count
        FROM "${table}"
        WHERE "${dateColumn}" IS NOT NULL AND "${valueColumn}" IS NOT NULL
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT ${Math.min(limit, 500)}
      `);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            table, dateColumn, valueColumn, aggregation, period,
            series: rows.reverse(),
          }, null, 2),
        }],
      };
    }
  );

  // Correlation between two columns
  server.tool(
    "correlation",
    "Calculate correlation between two numeric columns",
    {
      schema: z.string().default("main"),
      table: z.string(),
      columnA: z.string(),
      columnB: z.string(),
    },
    async ({ table, columnA, columnB }) => {
      // SQLite doesn't have CORR() so we calculate manually
      const rows = await runReadOnly(`
        SELECT
          COUNT(*) AS n,
          AVG(CAST("${columnA}" AS REAL)) AS mean_a,
          AVG(CAST("${columnB}" AS REAL)) AS mean_b,
          SUM(CAST("${columnA}" AS REAL) * CAST("${columnB}" AS REAL)) AS sum_ab,
          SUM(CAST("${columnA}" AS REAL) * CAST("${columnA}" AS REAL)) AS sum_aa,
          SUM(CAST("${columnB}" AS REAL) * CAST("${columnB}" AS REAL)) AS sum_bb
        FROM "${table}"
        WHERE "${columnA}" IS NOT NULL AND "${columnB}" IS NOT NULL
      `);

      const { n, mean_a, mean_b, sum_ab, sum_aa, sum_bb } = rows[0];
      const numerator = sum_ab - n * mean_a * mean_b;
      const denominator = Math.sqrt(
        (sum_aa - n * mean_a * mean_a) * (sum_bb - n * mean_b * mean_b)
      );
      const r = denominator === 0 ? null : numerator / denominator;

      const interpretation =
        r === null ? "Unable to compute" :
        Math.abs(r) > 0.8 ? "Strong" :
        Math.abs(r) > 0.5 ? "Moderate" :
        Math.abs(r) > 0.2 ? "Weak" : "Very weak / no";

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            table, columnA, columnB,
            pearsonR: r ? r.toFixed(4) : null,
            sampleSize: n,
            interpretation: r !== null
              ? `${interpretation} ${r >= 0 ? "positive" : "negative"} correlation`
              : "Unable to compute",
          }, null, 2),
        }],
      };
    }
  );

  // Data quality check
  server.tool(
    "data_quality_check",
    "Run a data quality audit: null rates and distinct counts per column",
    {
      schema: z.string().default("main"),
      table: z.string(),
    },
    async ({ table }) => {
      const columns = await runReadOnly(`PRAGMA table_info("${table}")`);
      const totalRows = await runReadOnly(`SELECT COUNT(*) as cnt FROM "${table}"`);
      const total = totalRows[0]?.cnt ?? 0;

      const columnQuality = await Promise.all(
        columns.map(async (col) => {
          try {
            const stats = await runReadOnly(`
              SELECT
                COUNT(*) - COUNT("${col.name}") AS null_count,
                ROUND(100.0 * (COUNT(*) - COUNT("${col.name}")) / MAX(COUNT(*), 1), 2) AS null_pct,
                COUNT(DISTINCT "${col.name}") AS distinct_count
              FROM "${table}"
            `);
            return { ...col, ...stats[0] };
          } catch {
            return { ...col, null_count: "n/a", null_pct: "n/a", distinct_count: "n/a" };
          }
        })
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ table, totalRows: total, columnQuality }, null, 2),
        }],
      };
    }
  );

  // Search for a value across all text columns
  server.tool(
    "search_value",
    "Search all text columns across tables for a specific value",
    {
      searchValue: z.string().describe("Value to search for"),
      schema: z.string().default("main"),
      tableFilter: z.string().optional().describe("Optional table name filter"),
      limit: z.number().optional().default(5),
    },
    async ({ searchValue, tableFilter, limit = 5 }) => {
      const tables = await runReadOnly(
        `SELECT name FROM sqlite_master WHERE type='table'${tableFilter ? ` AND name LIKE '%${tableFilter}%'` : ""} ORDER BY name`
      );

      const results = [];
      for (const { name: tableName } of tables.slice(0, 20)) {
        const columns = await runReadOnly(`PRAGMA table_info("${tableName}")`);
        const textCols = columns.filter((c) =>
          /text|char|clob|string/i.test(c.type) || c.type === ""
        );

        for (const col of textCols.slice(0, 10)) {
          try {
            const rows = await runReadOnly(`
              SELECT "${col.name}" AS matched_value, *
              FROM "${tableName}"
              WHERE "${col.name}" LIKE '%${searchValue.replace(/'/g, "''")}%'
              LIMIT ${limit}
            `);
            if (rows.length > 0) {
              results.push({ table: tableName, column: col.name, matches: rows });
            }
          } catch (_) {}
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ searchValue, results }, null, 2),
        }],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  //  PROMPTS
  // ════════════════════════════════════════════════════════════════════════════

  server.prompt(
    "explore_table",
    "Generate a comprehensive exploratory analysis plan for a table",
    {
      schema: z.string().default("main"),
      table: z.string(),
      goal: z.string().optional(),
    },
    ({ table, goal }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a senior data analyst. Perform a thorough exploratory data analysis on the table \`${table}\`.
${goal ? `Business question: ${goal}\n` : ""}
Steps:
1. Use the \`table://main/${table}\` resource to inspect the full schema.
2. Call \`sample_table\` to look at real data rows.
3. For each important column, call \`column_stats\` to get null rates, cardinality, min/max.
4. Identify the primary categorical columns and call \`top_values\` on them.
5. If there are date columns and numeric columns, call \`time_series\` to find trends.
6. Call \`data_quality_check\` to flag data quality issues.
7. Summarize findings in a structured report with key insights and recommended follow-up queries.`,
        },
      }],
    })
  );

  server.prompt(
    "funnel_analysis",
    "Analyze a conversion funnel stored in an events table",
    {
      schema: z.string().default("main"),
      eventTable: z.string(),
      userColumn: z.string(),
      eventColumn: z.string(),
      steps: z.string().describe("Comma-separated funnel steps in order"),
      dateColumn: z.string().optional(),
    },
    ({ eventTable, userColumn, eventColumn, steps, dateColumn }) => {
      const stepList = steps.split(",").map((s) => s.trim());
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `You are a growth analyst. Analyze the conversion funnel in \`${eventTable}\`.
Funnel steps: ${stepList.join(" → ")}
User column: \`${userColumn}\` | Event column: \`${eventColumn}\`
${dateColumn ? `Date column: \`${dateColumn}\`` : ""}
Using \`execute_query\`, write SQLite SQL to:
1. Count unique users at each funnel step
2. Calculate step-by-step conversion rates and drop-off percentages
3. Identify which step loses the most users
4. If date column exists, show conversion trends over time
Present results as a funnel table with counts, rates, and actionable recommendations.`,
          },
        }],
      };
    }
  );

  server.prompt(
    "cohort_analysis",
    "Build a retention cohort analysis from user activity data",
    {
      schema: z.string().default("main"),
      table: z.string(),
      userColumn: z.string(),
      dateColumn: z.string(),
      cohortPeriod: z.enum(["week", "month"]).default("month"),
    },
    ({ table, userColumn, dateColumn, cohortPeriod }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a retention analyst. Build a cohort retention analysis from \`${table}\`.
User column: \`${userColumn}\` | Date column: \`${dateColumn}\` | Cohort period: ${cohortPeriod}
Using \`execute_query\` with SQLite syntax (use strftime for date truncation):
1. Assign each user to their first-activity ${cohortPeriod} cohort
2. Build a retention matrix showing % of cohort active in each subsequent period
3. Calculate average retention rates at period 1, 2, 3
4. Identify if newer cohorts retain better or worse than older ones`,
        },
      }],
    })
  );

  server.prompt(
    "anomaly_detection",
    "Detect statistical anomalies and outliers in a metric column",
    {
      schema: z.string().default("main"),
      table: z.string(),
      metricColumn: z.string(),
      dateColumn: z.string().optional(),
      groupByColumn: z.string().optional(),
    },
    ({ table, metricColumn, dateColumn, groupByColumn }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a data quality expert. Analyze \`${table}\` for anomalies in \`${metricColumn}\`.
${dateColumn ? `Time dimension: \`${dateColumn}\`` : ""}
${groupByColumn ? `Group by: \`${groupByColumn}\`` : ""}
Using \`execute_query\` with SQLite syntax:
1. Calculate mean and standard deviation, flag rows where value is more than 3 std devs from mean
2. Calculate IQR and flag values outside 1.5 × IQR
3. If date column exists, compare each period to rolling average and flag spikes
4. Show top 10 most anomalous records with context
5. Recommend whether anomalies are data errors or genuine business events`,
        },
      }],
    })
  );

  server.prompt(
    "join_analysis",
    "Analyze relationships between two tables and suggest optimal join strategy",
    {
      schema: z.string().default("main"),
      primaryTable: z.string(),
      relatedTable: z.string(),
      businessQuestion: z.string(),
    },
    ({ primaryTable, relatedTable, businessQuestion }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a SQL expert. Help join \`${primaryTable}\` with \`${relatedTable}\`.
Business question: ${businessQuestion}
Steps:
1. Read both table schemas using \`table://main/${primaryTable}\` and \`table://main/${relatedTable}\` resources
2. Identify all possible join keys from foreign keys and matching column names
3. Use \`execute_query\` to check join cardinality and detect fan-out
4. Write the optimal SQLite query to answer the business question
5. Explain the join type chosen and suggest any useful indexes`,
        },
      }],
    })
  );

  server.prompt(
    "executive_summary",
    "Generate an executive summary of key metrics",
    {
      schema: z.string().default("main"),
      table: z.string(),
      periodColumn: z.string().optional(),
      metrics: z.string().optional(),
    },
    ({ table, periodColumn, metrics }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a business intelligence analyst. Prepare an executive summary from \`${table}\`.
${periodColumn ? `Time column: \`${periodColumn}\`` : ""}
${metrics ? `Key metrics: ${metrics}` : ""}
Using \`execute_query\` with SQLite syntax:
1. Compute current period totals vs previous period
2. Calculate MoM or WoW percentage changes
3. Find top and bottom performers by key dimensions
4. Identify any metrics that look anomalous
Present as: Headline KPIs → Winners & Losers → Trend analysis → Recommended actions.
Use plain business language, avoid technical jargon.`,
        },
      }],
    })
  );
}

// ─── Transport ───────────────────────────────────────────────────────────────
const USE_HTTP = process.env.MCP_TRANSPORT === "http";

if (USE_HTTP) {
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "http://localhost:3000");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/mcp") {
      const existingSessionId = req.headers["mcp-session-id"];

      if (existingSessionId && sessions.has(existingSessionId)) {
        const { transport } = sessions.get(existingSessionId);
        await transport.handleRequest(req, res);
      } else {
        const freshServer = new McpServer({ name: "pg-analyst", version: "1.0.0" });
        setupServer(freshServer);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          onsessioninitialized: (sessionId) => {
            console.log(`[MCP] New session: ${sessionId}`);
            sessions.set(sessionId, { transport });
          },
        });

        await freshServer.connect(transport);
        await transport.handleRequest(req, res);
      }
    } else if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "pg-analyst", version: "1.0.0", sessions: sessions.size }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  const PORT = parseInt(process.env.MCP_SERVER_PORT || "3001");
  httpServer.listen(PORT, () => {
    console.log(`[pg-analyst MCP] HTTP server running on http://localhost:${PORT}/mcp`);
    console.log(`[pg-analyst MCP] Health check: http://localhost:${PORT}/health`);
  });
} else {
  const transport = new StdioServerTransport();
  const server = new McpServer({ name: "pg-analyst", version: "1.0.0" });
  setupServer(server);
  await server.connect(transport);
  console.error("[pg-analyst MCP] Stdio transport ready");
}