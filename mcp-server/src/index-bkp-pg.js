import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import pg from "pg";
import { z } from "zod";
import dotenv from "dotenv";
import http from "http";

dotenv.config();

// ─── Database Connection ────────────────────────────────────────────────────
const pool = new pg.Pool({
  host: process.env.PG_HOST || "localhost",
  port: parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE || "postgres",
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD || "",
  ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error:", err);
});

// Helper: run a read-only query safely
async function runReadOnly(sql, params = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Guard against write operations
function assertReadOnly(sql) {
  const normalized = sql.trim().toUpperCase();
  const forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "TRUNCATE", "GRANT", "REVOKE"];
  for (const kw of forbidden) {
    if (normalized.startsWith(kw) || new RegExp(`\\b${kw}\\b`).test(normalized)) {
      throw new Error(`Write operation '${kw}' is not allowed. Only SELECT queries are permitted.`);
    }
  }
}

// ─── Setup Function ──────────────────────────────────────────────────────────
function setupServer(server) {

  // ════════════════════════════════════════════════════════════════════════════
  //  RESOURCES
  // ════════════════════════════════════════════════════════════════════════════

  server.resource("schemas://list", "schemas://list", async () => {
    const result = await runReadOnly(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
      ORDER BY schema_name
    `);
    const schemas = result.rows.map((r) => r.schema_name);
    return {
      contents: [{
        uri: "schemas://list",
        mimeType: "application/json",
        text: JSON.stringify({ schemas }, null, 2),
      }],
    };
  });

  server.resource(
    "schema://{schemaName}",
    new ResourceTemplate("schema://{schemaName}", { list: undefined }),
    async (uri, { schemaName }) => {
      const result = await runReadOnly(`
        SELECT
          t.table_name,
          t.table_type,
          obj_description(pgc.oid, 'pg_class') AS table_comment,
          COUNT(c.column_name) AS column_count
        FROM information_schema.tables t
        LEFT JOIN pg_class pgc ON pgc.relname = t.table_name
        LEFT JOIN information_schema.columns c
          ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        WHERE t.table_schema = $1
        GROUP BY t.table_name, t.table_type, pgc.oid
        ORDER BY t.table_name
      `, [schemaName]);

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ schema: schemaName, tables: result.rows }, null, 2),
        }],
      };
    }
  );

  server.resource(
    "table://{schemaName}/{tableName}",
    new ResourceTemplate("table://{schemaName}/{tableName}", { list: undefined }),
    async (uri, { schemaName, tableName }) => {
      const [columns, indexes, foreignKeys, rowCount] = await Promise.all([
        runReadOnly(`
          SELECT
            c.column_name,
            c.data_type,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.is_nullable,
            c.column_default,
            c.ordinal_position,
            col_description(pgc.oid, c.ordinal_position::int) AS column_comment
          FROM information_schema.columns c
          LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
          WHERE c.table_schema = $1 AND c.table_name = $2
          ORDER BY c.ordinal_position
        `, [schemaName, tableName]),

        runReadOnly(`
          SELECT
            i.relname AS index_name,
            ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary,
            array_agg(a.attname ORDER BY a.attnum) AS columns
          FROM pg_class t
          JOIN pg_index ix ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          WHERE n.nspname = $1 AND t.relname = $2
          GROUP BY i.relname, ix.indisunique, ix.indisprimary
          ORDER BY ix.indisprimary DESC, i.relname
        `, [schemaName, tableName]),

        runReadOnly(`
          SELECT
            kcu.column_name,
            ccu.table_schema AS foreign_schema,
            ccu.table_name AS foreign_table,
            ccu.column_name AS foreign_column,
            rc.update_rule,
            rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.referential_constraints rc
            ON tc.constraint_name = rc.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON rc.unique_constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1 AND tc.table_name = $2
        `, [schemaName, tableName]),

        runReadOnly(`
          SELECT reltuples::bigint AS estimate
          FROM pg_class WHERE relname = $1
        `, [tableName]),
      ]);

      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            schema: schemaName,
            table: tableName,
            rowCountEstimate: rowCount.rows[0]?.estimate ?? 0,
            columns: columns.rows,
            indexes: indexes.rows,
            foreignKeys: foreignKeys.rows,
          }, null, 2),
        }],
      };
    }
  );

  server.resource("stats://database", "stats://database", async () => {
    const result = await runReadOnly(`
      SELECT
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
        pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
        n_live_tup AS live_rows,
        n_dead_tup AS dead_rows,
        last_vacuum,
        last_analyze
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
      LIMIT 50
    `);
    return {
      contents: [{
        uri: "stats://database",
        mimeType: "application/json",
        text: JSON.stringify({ tableStats: result.rows }, null, 2),
      }],
    };
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  TOOLS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "execute_query",
    "Run a read-only SELECT query against the PostgreSQL database.",
    {
      sql: z.string().describe("The SELECT SQL query to execute"),
      limit: z.number().optional().default(500).describe("Maximum rows to return"),
    },
    async ({ sql, limit = 500 }) => {
      assertReadOnly(sql);
      const safeLimit = Math.min(limit, 5000);
      const hasLimit = /\bLIMIT\b/i.test(sql);
      const finalSql = hasLimit ? sql : `SELECT * FROM (${sql}) _q LIMIT ${safeLimit}`;
      const start = Date.now();
      const result = await runReadOnly(finalSql);
      const elapsed = Date.now() - start;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            rowCount: result.rows.length,
            executionMs: elapsed,
            columns: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: result.rows,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "sample_table",
    "Retrieve a random sample of rows from a specific table",
    {
      schema: z.string().default("public"),
      table: z.string(),
      limit: z.number().optional().default(25),
    },
    async ({ schema, table, limit = 25 }) => {
      const safeLimit = Math.min(limit, 1000);
      const sql = `SELECT * FROM ${JSON.stringify(schema)}.${JSON.stringify(table)} TABLESAMPLE SYSTEM(10) LIMIT $1`;
      const result = await runReadOnly(sql, [safeLimit]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            schema, table,
            rowCount: result.rows.length,
            columns: result.fields.map((f) => f.name),
            rows: result.rows,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "column_stats",
    "Get statistical summary for a column",
    {
      schema: z.string().default("public"),
      table: z.string(),
      column: z.string(),
    },
    async ({ schema, table, column }) => {
      const fqTable = `${JSON.stringify(schema)}.${JSON.stringify(table)}`;
      const col = JSON.stringify(column);
      const result = await runReadOnly(`
        SELECT
          COUNT(*) AS total_rows,
          COUNT(${col}) AS non_null_count,
          COUNT(*) - COUNT(${col}) AS null_count,
          ROUND(100.0 * (COUNT(*) - COUNT(${col})) / NULLIF(COUNT(*), 0), 2) AS null_pct,
          COUNT(DISTINCT ${col}) AS distinct_count,
          MIN(${col}::text) AS min_value,
          MAX(${col}::text) AS max_value
        FROM ${fqTable}
      `);
      let numericStats = null;
      try {
        const ns = await runReadOnly(`
          SELECT
            ROUND(AVG(${col}::numeric), 4) AS mean,
            ROUND(STDDEV(${col}::numeric), 4) AS stddev,
            PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY ${col}::numeric) AS p25,
            PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY ${col}::numeric) AS median,
            PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY ${col}::numeric) AS p75
          FROM ${fqTable} WHERE ${col} IS NOT NULL
        `);
        numericStats = ns.rows[0];
      } catch (_) {}
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ schema, table, column, basicStats: result.rows[0], numericStats }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "top_values",
    "Get the most frequent values in a column",
    {
      schema: z.string().default("public"),
      table: z.string(),
      column: z.string(),
      limit: z.number().optional().default(20),
    },
    async ({ schema, table, column, limit = 20 }) => {
      const fqTable = `${JSON.stringify(schema)}.${JSON.stringify(table)}`;
      const col = JSON.stringify(column);
      const result = await runReadOnly(`
        SELECT ${col} AS value, COUNT(*) AS count,
          ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
        FROM ${fqTable}
        WHERE ${col} IS NOT NULL
        GROUP BY ${col}
        ORDER BY count DESC
        LIMIT $1
      `, [limit]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ schema, table, column, topValues: result.rows }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "time_series",
    "Aggregate a numeric column over a date/time column by period",
    {
      schema: z.string().default("public"),
      table: z.string(),
      dateColumn: z.string(),
      valueColumn: z.string(),
      aggregation: z.enum(["sum", "avg", "count", "min", "max"]).default("sum"),
      period: z.enum(["hour", "day", "week", "month", "quarter", "year"]).default("day"),
      limit: z.number().optional().default(90),
    },
    async ({ schema, table, dateColumn, valueColumn, aggregation, period, limit = 90 }) => {
      const fqTable = `${JSON.stringify(schema)}.${JSON.stringify(table)}`;
      const datCol = JSON.stringify(dateColumn);
      const valCol = JSON.stringify(valueColumn);
      const result = await runReadOnly(`
        SELECT
          DATE_TRUNC('${period}', ${datCol}::timestamptz) AS period,
          ${aggregation.toUpperCase()}(${valCol}::numeric) AS value,
          COUNT(*) AS row_count
        FROM ${fqTable}
        WHERE ${datCol} IS NOT NULL AND ${valCol} IS NOT NULL
        GROUP BY 1 ORDER BY 1 DESC LIMIT $1
      `, [limit]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ schema, table, dateColumn, valueColumn, aggregation, period, series: result.rows.reverse() }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "correlation",
    "Calculate Pearson correlation between two numeric columns",
    {
      schema: z.string().default("public"),
      table: z.string(),
      columnA: z.string(),
      columnB: z.string(),
    },
    async ({ schema, table, columnA, columnB }) => {
      const fqTable = `${JSON.stringify(schema)}.${JSON.stringify(table)}`;
      const colA = JSON.stringify(columnA);
      const colB = JSON.stringify(columnB);
      const result = await runReadOnly(`
        SELECT
          CORR(${colA}::numeric, ${colB}::numeric) AS pearson_r,
          COUNT(*) AS sample_size
        FROM ${fqTable}
        WHERE ${colA} IS NOT NULL AND ${colB} IS NOT NULL
      `);
      const r = parseFloat(result.rows[0].pearson_r);
      const interpretation =
        isNaN(r) ? "Unable to compute" :
        Math.abs(r) > 0.8 ? "Strong" :
        Math.abs(r) > 0.5 ? "Moderate" :
        Math.abs(r) > 0.2 ? "Weak" : "Very weak / no";
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            schema, table, columnA, columnB,
            pearsonR: result.rows[0].pearson_r,
            sampleSize: result.rows[0].sample_size,
            interpretation: `${interpretation} ${r >= 0 ? "positive" : "negative"} correlation`,
          }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "data_quality_check",
    "Run a comprehensive data quality audit on a table",
    {
      schema: z.string().default("public"),
      table: z.string(),
    },
    async ({ schema, table }) => {
      const fqTable = `${JSON.stringify(schema)}.${JSON.stringify(table)}`;
      const [totalRows, columns, duplicates] = await Promise.all([
        runReadOnly(`SELECT COUNT(*) AS cnt FROM ${fqTable}`),
        runReadOnly(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema, table]),
        runReadOnly(`
          SELECT COUNT(*) AS duplicate_rows FROM (
            SELECT COUNT(*) AS cnt FROM ${fqTable} GROUP BY (${fqTable}.*) HAVING COUNT(*) > 1
          ) x
        `).catch(() => ({ rows: [{ duplicate_rows: "n/a" }] })),
      ]);
      const total = parseInt(totalRows.rows[0].cnt);
      const nullStats = await Promise.all(
        columns.rows.map(async (col) => {
          try {
            const r = await runReadOnly(`
              SELECT
                COUNT(*) - COUNT(${JSON.stringify(col.column_name)}) AS null_count,
                ROUND(100.0*(COUNT(*)-COUNT(${JSON.stringify(col.column_name)}))/NULLIF(COUNT(*),0),2) AS null_pct
              FROM ${fqTable}
            `);
            return { ...col, ...r.rows[0] };
          } catch {
            return { ...col, null_count: "n/a", null_pct: "n/a" };
          }
        })
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ schema, table, totalRows: total, duplicateRows: duplicates.rows[0].duplicate_rows, columnQuality: nullStats }, null, 2),
        }],
      };
    }
  );

  server.tool(
    "search_value",
    "Search all text columns for a specific value",
    {
      searchValue: z.string(),
      schema: z.string().default("public"),
      tableFilter: z.string().optional(),
      limit: z.number().optional().default(5),
    },
    async ({ searchValue, schema, tableFilter, limit = 5 }) => {
      const tablesResult = await runReadOnly(`
        SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        WHERE c.table_schema = $1
          AND c.data_type IN ('character varying','text','character','name','citext')
          ${tableFilter ? `AND c.table_name ILIKE $2` : ""}
        ORDER BY c.table_name, c.column_name
      `, tableFilter ? [schema, `%${tableFilter}%`] : [schema]);

      const results = [];
      for (const { table_name, column_name } of tablesResult.rows.slice(0, 30)) {
        try {
          const r = await runReadOnly(`
            SELECT ${JSON.stringify(column_name)} AS matched_value, *
            FROM ${JSON.stringify(schema)}.${JSON.stringify(table_name)}
            WHERE ${JSON.stringify(column_name)} ILIKE $1 LIMIT $2
          `, [`%${searchValue}%`, limit]);
          if (r.rows.length > 0) results.push({ table: table_name, column: column_name, matches: r.rows });
        } catch (_) {}
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ searchValue, schema, results }, null, 2),
        }],
      };
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  //  PROMPTS
  // ════════════════════════════════════════════════════════════════════════════

  server.prompt(
    "explore_table",
    "Generate a comprehensive exploratory analysis plan for a database table",
    {
      schema: z.string().default("public"),
      table: z.string(),
      goal: z.string().optional(),
    },
    ({ schema, table, goal }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a senior data analyst. Perform a thorough exploratory data analysis on the table \`${schema}.${table}\`.
${goal ? `Business question: ${goal}\n` : ""}
Steps:
1. Use the \`table://${schema}/${table}\` resource to inspect the full schema.
2. Call \`sample_table\` to look at real data rows.
3. For each important column, call \`column_stats\` to get null rates, cardinality, min/max.
4. Identify the primary categorical columns and call \`top_values\` on them.
5. If there are date columns and numeric columns, call \`time_series\` to find trends.
6. Call \`data_quality_check\` to flag data quality issues.
7. Summarize findings in a structured report.`,
        },
      }],
    })
  );

  server.prompt(
    "funnel_analysis",
    "Analyze a conversion funnel stored in event or transaction tables",
    {
      schema: z.string().default("public"),
      eventTable: z.string(),
      userColumn: z.string(),
      eventColumn: z.string(),
      steps: z.string(),
      dateColumn: z.string().optional(),
    },
    ({ schema, eventTable, userColumn, eventColumn, steps, dateColumn }) => {
      const stepList = steps.split(",").map((s) => s.trim());
      return {
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `You are a growth analyst. Analyze the conversion funnel in \`${schema}.${eventTable}\`.
Funnel steps: ${stepList.join(", ")}
User identifier: \`${userColumn}\` | Event column: \`${eventColumn}\`
${dateColumn ? `Date column: \`${dateColumn}\`` : ""}
Using \`execute_query\`, write and run SQL to calculate step-by-step conversion rates and drop-off analysis.`,
          },
        }],
      };
    }
  );

  server.prompt(
    "cohort_analysis",
    "Build a retention cohort analysis based on user activity data",
    {
      schema: z.string().default("public"),
      table: z.string(),
      userColumn: z.string(),
      dateColumn: z.string(),
      cohortPeriod: z.enum(["week", "month"]).default("month"),
    },
    ({ schema, table, userColumn, dateColumn, cohortPeriod }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a retention analyst. Build a cohort retention analysis from \`${schema}.${table}\`.
User column: \`${userColumn}\` | Date column: \`${dateColumn}\` | Cohort period: ${cohortPeriod}
Using \`execute_query\`, build a retention matrix and calculate rolling retention rates.`,
        },
      }],
    })
  );

  server.prompt(
    "anomaly_detection",
    "Detect statistical anomalies and outliers in a metric column",
    {
      schema: z.string().default("public"),
      table: z.string(),
      metricColumn: z.string(),
      dateColumn: z.string().optional(),
      groupByColumn: z.string().optional(),
    },
    ({ schema, table, metricColumn, dateColumn, groupByColumn }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a data quality expert. Analyze \`${schema}.${table}\` for anomalies in \`${metricColumn}\`.
${dateColumn ? `Time dimension: \`${dateColumn}\`` : ""}
${groupByColumn ? `Group by: \`${groupByColumn}\`` : ""}
Using \`execute_query\`, detect Z-score outliers, IQR-based outliers, and time-based spikes.`,
        },
      }],
    })
  );

  server.prompt(
    "join_analysis",
    "Analyze relationships between tables and suggest optimal join strategies",
    {
      schema: z.string().default("public"),
      primaryTable: z.string(),
      relatedTable: z.string(),
      businessQuestion: z.string(),
    },
    ({ schema, primaryTable, relatedTable, businessQuestion }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a SQL optimization expert. Help analyze and join \`${schema}.${primaryTable}\` with \`${schema}.${relatedTable}\`.
Business question: ${businessQuestion}
Read both schemas, identify join keys, check cardinality, and write the optimal query.`,
        },
      }],
    })
  );

  server.prompt(
    "executive_summary",
    "Generate an executive summary of key metrics from a reporting table",
    {
      schema: z.string().default("public"),
      table: z.string(),
      periodColumn: z.string().optional(),
      metrics: z.string().optional(),
    },
    ({ schema, table, periodColumn, metrics }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `You are a business intelligence analyst preparing an executive summary from \`${schema}.${table}\`.
${periodColumn ? `Time column: \`${periodColumn}\`` : ""}
${metrics ? `Key metrics: ${metrics}` : ""}
Compute current vs previous period changes, top/bottom performers, and trend analysis.`,
        },
      }],
    })
  );
}

// ─── Transport ───────────────────────────────────────────────────────────────
const USE_HTTP = process.env.MCP_TRANSPORT === "http";

if (USE_HTTP) {
  // Store server+transport instances by session ID
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
        // Reuse existing session
        const { transport } = sessions.get(existingSessionId);
        await transport.handleRequest(req, res);
      } else {
        // Create a new session
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