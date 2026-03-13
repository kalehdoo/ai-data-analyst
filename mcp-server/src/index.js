import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Database } from "@sqlitecloud/drivers";
import { z } from "zod";
import dotenv from "dotenv";
import http from "http";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { logAudit } from "./audit.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load job prompts and samples
const jobsDir = join(__dirname, "../jobs");
function loadJobPrompt(name) {
  const p = join(jobsDir, "prompts", `${name}.txt`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
function loadSamples() {
  const samplesDir = join(jobsDir, "samples");
  if (!existsSync(samplesDir)) return {};
  const files = readdirSync(samplesDir).filter((f) => f.endsWith(".sql") || f.endsWith(".yml") || f.endsWith(".yaml") || f.endsWith(".py"));
  const samples = {};
  files.forEach((f) => {
  const name = f.replace(/\.(sql|yml|yaml)$/, "");
  samples[name] = readFileSync(join(samplesDir, f), "utf8");
});
  return samples;
}

// Load dbt manifest
let dbtManifest = null;
const manifestPath = join(__dirname, "../data/manifest.json");
if (existsSync(manifestPath)) {
  try {
    dbtManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.error("✓ dbt manifest loaded:", Object.keys(dbtManifest.nodes || {}).length, "models");
  } catch (e) {
    console.warn("⚠ Could not load manifest.json:", e.message);
  }
}

function requireManifest() {
  if (!dbtManifest) throw new Error("manifest.json not found in mcp-server/data/. Please add it.");
  return dbtManifest;
}

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

  // ── Jobs Tools ──────────────────────────────────────────────────────────────

  server.tool(
  "run_infa_to_airflow",
  "Convert an Informatica workflow XML to Apache Airflow DAGs using the conversion prompt and sample DAG templates",
  {
    xml_content:        { type: "string", description: "Full content of the Informatica workflow XML file" },
    job_name:           { type: "string", description: "Name for the Airflow DAG" },
    extra_instructions: { type: "string", description: "Any additional instructions from the user" },
  },
  async ({ xml_content, job_name, extra_instructions = "" }) => {
    const prompt = loadJobPrompt("infa_to_airflow");
    if (!prompt) throw new Error("infa_to_airflow.txt not found in mcp-server/jobs/prompts/");

    const samples = loadSamples();
    const dagSamples = Object.entries(samples)
      .filter(([k]) => k.startsWith("airflow_"))
      .map(([k, v]) => `=== ${k} ===\n${v}`)
      .join("\n\n");

    const fullPrompt = `${prompt}

DAG NAME: ${job_name}
${extra_instructions ? `ADDITIONAL INSTRUCTIONS: ${extra_instructions}` : ""}
${dagSamples ? `\n\nREFERENCE DAG TEMPLATES:\n${dagSamples}` : ""}

INFORMATICA WORKFLOW XML:
${xml_content}`;

    return { content: [{ type: "text", text: fullPrompt }] };
  }
);

server.tool(
  "run_infa_to_dbt",
  "Convert an Informatica XML mapping to enterprise-grade dbt models using the full conversion prompt and sample patterns",
  {
    xml_content:   { type: "string", description: "Full content of the Informatica XML mapping file" },
    job_name:      { type: "string", description: "Name for the dbt job/project" },
    mapping_type:  { type: "string", description: "Type of mapping: truncate_load, full_refresh, scd_type1_dim, scd_type2_dim, fact_table" },
    extra_instructions: { type: "string", description: "Any additional instructions from the user" },
  },
  async ({ xml_content, job_name, mapping_type, extra_instructions = "" }) => {
    const prompt = loadJobPrompt("infa_to_dbt");
    if (!prompt) throw new Error("infa_to_dbt.txt prompt file not found in mcp-server/jobs/prompts/");

    const samples = loadSamples();
    const sampleGuide = mapping_type && samples[mapping_type]
      ? `\n\nREFERENCE SAMPLE FOR ${mapping_type.toUpperCase()}:\n${samples[mapping_type]}`
      : `\n\nAVAILABLE SAMPLES FOR REFERENCE:\n${Object.entries(samples).map(([k, v]) => `=== ${k} ===\n${v}`).join("\n\n")}`;

    const fullPrompt = `${prompt}

JOB NAME: ${job_name}
MAPPING TYPE: ${mapping_type || "auto-detect from XML"}
${extra_instructions ? `ADDITIONAL INSTRUCTIONS: ${extra_instructions}` : ""}
${sampleGuide}

INFORMATICA XML MAPPING:
${xml_content}`;

    return {
      content: [{
        type: "text",
        text: fullPrompt,
      }],
    };
  }
);

// write log to sqlite database
  server.tool(
  "write_audit_log",
  "Internal tool to write an audit log entry",
  {
    username:     { type: "string", description: "Username" },
    role:         { type: "string", description: "User role" },
    action_type:  { type: "string", description: "Action type: login, logout, query, ai_chat" },
    details:      { type: "string", description: "Details", nullable: true },
    model:        { type: "string", description: "AI model used", nullable: true },
    context_mode: { type: "string", description: "Context mode", nullable: true },
    duration_ms:  { type: "number", description: "Duration in ms", nullable: true },
    status:       { type: "string", description: "Status", nullable: true },
    error_msg:    { type: "string", description: "Error message", nullable: true },
  },
  async ({ username = "unknown", role = "unknown", action_type = "unknown", details, model, context_mode, duration_ms, status = "success", error_msg }) => {
    await logAudit({ username, role, action_type, details, model, context_mode, duration_ms, status, error_msg });
    return { content: [{ type: "text", text: "logged" }] };
  }
);

  // ── dbt Manifest Tools ──────────────────────────────────────────────────────

server.tool(
  "dbt_get_model",
  "Get full details of a dbt model including columns, description, materialization and file path. IMPORTANT: These models live in Snowflake, NOT in SQLite. Do not run SQL using these table names via execute_query.",
  {
    model_name: { type: "string", description: "Name of the dbt model e.g. stg_orders, fct_orders" },
  },
  async ({ model_name }) => {
    const manifest = requireManifest();
    const allNodes = { ...manifest.nodes, ...manifest.sources };

    // Find by name (flexible match)
    const entry = Object.values(allNodes).find(
      (n) => n.name === model_name || n.unique_id.endsWith(model_name)
    );

    if (!entry) {
      const available = Object.values(allNodes).map((n) => n.name).join(", ");
      throw new Error(`Model "${model_name}" not found. Available: ${available}`);
    }

    const result = {
      name: entry.name,
      unique_id: entry.unique_id,
      resource_type: entry.resource_type,
      layer: entry.name.startsWith("stg_") ? "staging"
           : entry.name.startsWith("int_") ? "intermediate"
           : entry.resource_type === "source" ? "source"
           : "mart",
      schema: entry.schema,
      database: entry.database,
      materialized: entry.config?.materialized || "external",
      description: entry.description || "No description",
      path: entry.path || entry.original_file_path,
      tags: entry.tags || [],
      columns: Object.values(entry.columns || {}).map((c) => ({
        name: c.name,
        data_type: c.data_type || "unknown",
        description: c.description || "No description",
      })),
      column_count: Object.keys(entry.columns || {}).length,
    };

    return { content: [{ type: "text", text: `⚠ SNOWFLAKE MODEL — Do not run SQL via execute_query. This model exists in Snowflake, not SQLite.\n\n${JSON.stringify(result, null, 2)}` }] };
  }
);

server.tool(
  "dbt_get_lineage",
  "Get the upstream and downstream lineage for a dbt model. IMPORTANT: These are Snowflake models. Never run SQL with these table names via execute_query — they do not exist in SQLite.",
  {
    model_name: { type: "string", description: "Name of the dbt model" },
    depth: { type: "number", description: "How many levels to traverse (default 1, max 5)" },
  },
  async ({ model_name, depth = 1 }) => {
    const manifest = requireManifest();
    const maxDepth = Math.min(depth, 5);

    // Find the node
    const allNodes = { ...manifest.nodes, ...manifest.sources };
    const entry = Object.values(allNodes).find((n) => n.name === model_name);
    if (!entry) throw new Error(`Model "${model_name}" not found`);

    const nodeId = entry.unique_id;

    // Walk upstream
    function getUpstream(id, currentDepth) {
      if (currentDepth > maxDepth) return [];
      const parents = manifest.parent_map[id] || [];
      return parents.map((pid) => {
        const pNode = allNodes[pid];
        if (!pNode) return null;
        return {
          name: pNode.name,
          layer: pNode.name.startsWith("stg_") ? "staging"
               : pNode.name.startsWith("int_") ? "intermediate"
               : pNode.resource_type === "source" ? "source" : "mart",
          materialized: pNode.config?.materialized || "external",
          description: pNode.description || "",
          depth: currentDepth,
          parents: getUpstream(pid, currentDepth + 1),
        };
      }).filter(Boolean);
    }

    // Walk downstream
    function getDownstream(id, currentDepth) {
      if (currentDepth > maxDepth) return [];
      const children = manifest.child_map[id] || [];
      return children.map((cid) => {
        const cNode = allNodes[cid];
        if (!cNode) return null;
        return {
          name: cNode.name,
          layer: cNode.name.startsWith("stg_") ? "staging"
               : cNode.name.startsWith("int_") ? "intermediate"
               : cNode.resource_type === "source" ? "source" : "mart",
          materialized: cNode.config?.materialized || "external",
          description: cNode.description || "",
          depth: currentDepth,
          children: getDownstream(cid, currentDepth + 1),
        };
      }).filter(Boolean);
    }

    const result = {
      model: model_name,
      layer: entry.name.startsWith("stg_") ? "staging"
           : entry.name.startsWith("int_") ? "intermediate"
           : entry.resource_type === "source" ? "source" : "mart",
      description: entry.description || "",
      upstream: getUpstream(nodeId, 1),
      downstream: getDownstream(nodeId, 1),
      direct_parent_count: (manifest.parent_map[nodeId] || []).length,
      direct_child_count: (manifest.child_map[nodeId] || []).length,
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "dbt_search_column",
  "Search for a column across all dbt Snowflake models. IMPORTANT: When writing SQL based on these results, always label it as Snowflake SQL and never run it via execute_query — these tables do not exist in SQLite.",
  {
    column_name: { type: "string", description: "Column name to search for (partial match supported)" },
  },
  async ({ column_name }) => {
    const manifest = requireManifest();
    const allNodes = { ...manifest.nodes, ...manifest.sources };
    const query = column_name.toLowerCase();

    const matches = [];
    Object.values(allNodes).forEach((node) => {
      const matchingCols = Object.values(node.columns || {}).filter(
        (c) => c.name.toLowerCase().includes(query) ||
               (c.description || "").toLowerCase().includes(query)
      );
      if (matchingCols.length > 0) {
        matches.push({
          model: node.name,
          layer: node.name.startsWith("stg_") ? "staging"
               : node.name.startsWith("int_") ? "intermediate"
               : node.resource_type === "source" ? "source" : "mart",
          matching_columns: matchingCols.map((c) => ({
            name: c.name,
            data_type: c.data_type || "unknown",
            description: c.description || "No description",
          })),
        });
      }
    });

    matches.sort((a, b) => {
      const order = { source: 0, staging: 1, intermediate: 2, mart: 3 };
      return (order[a.layer] || 0) - (order[b.layer] || 0);
    });

    const searchResult = {
        query: column_name,
        total_models: matches.length,
        results: matches,
      };
      return {
        content: [{
          type: "text",
          text: `⚠ SNOWFLAKE MODELS — Do not run SQL via execute_query. Write the SQL but label it clearly as Snowflake SQL.\n\n${JSON.stringify(searchResult, null, 2)}`,
        }],
      };
  }
);

server.tool(
  "dbt_list_models",
  "List all dbt ETL pipeline models. IMPORTANT: These are Snowflake models, not SQLite tables. Never use execute_query with these model names — they do not exist in the SQLite database.",
  {
    layer: { type: "string", description: "Filter by layer: source, staging, intermediate, mart, or all (default)" },
  },
  async ({ layer = "all" }) => {
    const manifest = requireManifest();
    const allNodes = { ...manifest.nodes, ...manifest.sources };

    const getLayer = (node) => {
      if (node.resource_type === "source") return "source";
      if (node.name.startsWith("stg_")) return "staging";
      if (node.name.startsWith("int_")) return "intermediate";
      return "mart";
    };

    const grouped = { source: [], staging: [], intermediate: [], mart: [] };

    Object.values(allNodes).forEach((node) => {
      if (node.resource_type !== "model" && node.resource_type !== "source") return;
      const nodeLayer = getLayer(node);
      if (layer !== "all" && nodeLayer !== layer) return;
      grouped[nodeLayer].push({
        name: node.name,
        materialized: node.config?.materialized || "external",
        description: node.description || "No description",
        column_count: Object.keys(node.columns || {}).length,
        tags: node.tags || [],
        path: node.path || "",
      });
    });

    const result = {
      project: manifest.metadata?.project_name,
      dbt_version: manifest.metadata?.dbt_version,
      generated_at: manifest.metadata?.generated_at,
      total_models: Object.values(grouped).flat().length,
      by_layer: grouped,
    };

    return { content: [{ type: "text", text: `⚠ SNOWFLAKE MODELS — Do not run SQL via execute_query. Write the SQL but label it clearly as Snowflake SQL.\n\n${JSON.stringify(result, null, 2)}` }] };
  }
);

server.tool(
  "dbt_impact_analysis",
  "Analyze the downstream impact of changing a dbt Snowflake model. IMPORTANT: These models are in Snowflake. Never run SQL with these table names via execute_query.",
  {
    model_name: { type: "string", description: "The model you plan to change or remove" },
  },
  async ({ model_name }) => {
    const manifest = requireManifest();
    const allNodes = { ...manifest.nodes, ...manifest.sources };

    const entry = Object.values(allNodes).find((n) => n.name === model_name);
    if (!entry) throw new Error(`Model "${model_name}" not found`);

    // Get ALL downstream models recursively
    const affected = new Map();
    function walkDownstream(id, depth) {
      const children = manifest.child_map[id] || [];
      children.forEach((cid) => {
        const cNode = allNodes[cid];
        if (!cNode || affected.has(cid)) return;
        const nodeLayer = cNode.name.startsWith("stg_") ? "staging"
                        : cNode.name.startsWith("int_") ? "intermediate"
                        : cNode.resource_type === "source" ? "source" : "mart";
        affected.set(cid, {
          name: cNode.name,
          layer: nodeLayer,
          materialized: cNode.config?.materialized || "external",
          description: cNode.description || "",
          hops_from_source: depth,
        });
        walkDownstream(cid, depth + 1);
      });
    }

    walkDownstream(entry.unique_id, 1);

    const affectedList = Array.from(affected.values())
      .sort((a, b) => a.hops_from_source - b.hops_from_source);

    // Group by layer
    const byLayer = {};
    affectedList.forEach((m) => {
      if (!byLayer[m.layer]) byLayer[m.layer] = [];
      byLayer[m.layer].push(m.name);
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          model: model_name,
          description: entry.description || "",
          total_affected: affectedList.length,
          affected_by_layer: byLayer,
          affected_models: affectedList,
          risk_level: affectedList.length === 0 ? "LOW"
                    : affectedList.length <= 3 ? "MEDIUM" : "HIGH",
        }, null, 2),
      }],
    };
  }
);

  // Execute any read-only SQL
  server.tool(
    "execute_query",
    "Run a read-only SELECT query against the SQLite Cloud database.",
    {
      sql: z.string().describe("The SELECT SQL query to execute"),
      limit: z.number().optional().default(500).describe("Maximum rows to return"),
      _username: z.string().optional().default("unknown").describe("Internal: username for audit logging"),
      _role: z.string().optional().default("unknown").describe("Internal: role for audit logging"),
    },
    
    async ({ sql, limit = 100, _username = "unknown", _role = "unknown" }) => {
    assertReadOnly(sql);
// Strip trailing semicolons — SQLite Cloud rejects them
sql = sql.trim().replace(/;+$/, "");
const start = Date.now();
    try {
      const isPragma = sql.trim().toUpperCase().startsWith("PRAGMA");
      const wrappedSql = isPragma || sql.toLowerCase().includes("limit")
        ? sql
        : `SELECT * FROM (${sql}) LIMIT ${limit}`;

      const db = new Database(process.env.SQLITE_CLOUD_URL);
      const rows = await db.sql(wrappedSql);
      const duration_ms = Date.now() - start;

      const columns = rows.length > 0
        ? Object.keys(rows[0]).map((name) => ({ name }))
        : [];

      await logAudit({
        username: _username,
        role: _role,
        action_type: "query",
        details: sql,
        duration_ms,
        row_count: rows.length,
        status: "success",
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ rows, columns, rowCount: rows.length, executionMs: duration_ms }),
        }],
      };
    } catch (e) {
      await logAudit({
        username: _username,
        role: _role,
        action_type: "query",
        details: sql,
        duration_ms: Date.now() - start,
        status: "error",
        error_msg: e.message,
      });
      throw e;
    }
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