"use client";
import { useState } from "react";
import * as mcp from "@/lib/mcpClient";

const STARTER_QUERIES = [
  { label: "List all tables", sql: "SELECT name, type\nFROM sqlite_master\nWHERE type IN ('table', 'view')\nORDER BY name;" },
  { label: "Table row counts", sql: "SELECT name AS table_name\nFROM sqlite_master\nWHERE type = 'table'\nORDER BY name;" },
  { label: "Database info", sql: "PRAGMA database_list;" },
  { label: "Schema of a table", sql: "PRAGMA table_info('your_table_name');" },
];

interface Column { name: string }
interface QueryResult {
  rowCount: number;
  executionMs: number;
  columns: Column[];
  rows: Record<string, unknown>[];
}

export default function QueryRunner() {
  const [sql, setSql] = useState(STARTER_QUERIES[0].sql);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [limit, setLimit] = useState(200);

  async function runQuery() {
    if (!sql.trim()) return;
    setRunning(true); setError(""); setResult(null);
    try {
      const res = await mcp.callTool("execute_query", { sql, limit });
      let data: QueryResult;
try {
  data = JSON.parse(res.content[0].text);
} catch {
  setError(res.content[0].text);
  return;
}
setResult(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") runQuery();
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h2 style={s.title}>▶ SQL Query Runner</h2>
        <p style={s.sub}>Execute read-only SELECT queries — write operations are blocked</p>
      </div>

      {/* Starter queries */}
      <div style={s.starters}>
        <span style={s.starterLabel}>Quick start:</span>
        {STARTER_QUERIES.map((q) => (
          <button key={q.label} onClick={() => setSql(q.sql)} style={s.starterBtn}>{q.label}</button>
        ))}
      </div>

      <div style={s.editorArea}>
        {/* Editor */}
        <div style={s.editorWrap}>
          <div style={s.editorHeader}>
            <span style={s.editorLabel}>SQL</span>
            <div style={s.editorControls}>
              <label style={s.limitLabel}>Row limit:</label>
              <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={s.limitSelect}>
                {[50, 100, 200, 500, 1000, 5000].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              <button onClick={runQuery} disabled={running} style={{ ...s.runBtn, opacity: running ? 0.6 : 1 }}>
                {running ? "Running…" : "▶ Run  (⌘↵)"}
              </button>
            </div>
          </div>
          <textarea
            style={s.textarea}
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="SELECT * FROM your_table LIMIT 100;"
            spellCheck={false}
          />
        </div>

        {/* Results */}
        <div style={s.results}>
          {error && (
            <div style={s.errorBox}>
              <strong>Error</strong>
              <pre style={s.errorPre}>{error}</pre>
            </div>
          )}

          {running && <div style={s.loadingRow}>⟳ Executing query…</div>}

          {result && !running && (
            <>
              <div style={s.resultMeta}>
                <span style={s.metaChip}>
                  <strong>{result.rowCount.toLocaleString()}</strong> rows
                </span>
                <span style={s.metaChip}>
                  <strong>{result.executionMs}ms</strong>
                </span>
                <span style={s.metaChip}>
                  <strong>{result.columns.length}</strong> columns
                </span>
                <button
                  style={s.exportBtn}
                  onClick={() => {
                    const csv = [
                      result.columns.map((c) => c.name).join(","),
                      ...result.rows.map((r) =>
                        result.columns.map((c) => {
                          const v = String(r[c.name] ?? "");
                          return v.includes(",") ? `"${v}"` : v;
                        }).join(",")
                      ),
                    ].join("\n");
                    const a = document.createElement("a");
                    a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
                    a.download = "query_result.csv";
                    a.click();
                  }}
                >
                  ↓ Export CSV
                </button>
              </div>

              <div style={s.tableScroll}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {result.columns.map((col) => (
                        <th key={col.name} style={s.th}>{col.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {result.columns.map((col) => {
                          const val = row[col.name];
                          const display = val === null ? "NULL" : String(val);
                          const isNull = val === null;
                          const isNum = typeof val === "number";
                          return (
                            <td key={col.name} style={{
                              ...s.td,
                              color: isNull ? "var(--text-muted)" : isNum ? "var(--accent)" : "var(--text-primary)",
                              fontStyle: isNull ? "italic" : "normal",
                              maxWidth: 300,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}>
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!result && !error && !running && (
            <div style={s.placeholder}>
              <div style={{ fontSize: 28, marginBottom: 12 }}>▶</div>
              <p>Run a query to see results here</p>
              <p style={{ marginTop: 6, fontSize: 12 }}>Tip: Use Ctrl+Enter or ⌘+Enter to run</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: { padding: "24px 28px 16px", borderBottom: "1px solid var(--border)" },
  title: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub: { color: "var(--text-secondary)", fontSize: 13 },
  starters: { display: "flex", alignItems: "center", gap: 8, padding: "12px 28px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" as const },
  starterLabel: { fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.5px", marginRight: 4 },
  starterBtn: { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "4px 10px", borderRadius: 99, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
  editorArea: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: 28, gap: 16 },
  editorWrap: { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" },
  editorHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" },
  editorLabel: { fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "1px" },
  editorControls: { display: "flex", alignItems: "center", gap: 10 },
  limitLabel: { fontSize: 12, color: "var(--text-secondary)" },
  limitSelect: { background: "var(--bg)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "3px 8px", borderRadius: "var(--radius)", fontSize: 12, fontFamily: "var(--font-mono)" },
  runBtn: { background: "var(--accent)", color: "#000", border: "none", borderRadius: "var(--radius)", padding: "6px 14px", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  textarea: { width: "100%", background: "transparent", border: "none", outline: "none", resize: "none" as const, padding: "16px", fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", lineHeight: 1.7, minHeight: 160, display: "block" },
  results: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" },
  errorBox: { padding: "16px 20px", background: "var(--red-dim)", borderBottom: "1px solid var(--red)" },
  errorPre: { marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--red)", whiteSpace: "pre-wrap" as const },
  loadingRow: { padding: "24px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 },
  resultMeta: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" },
  metaChip: { background: "var(--bg)", border: "1px solid var(--border-bright)", padding: "2px 10px", borderRadius: 99, fontSize: 12, color: "var(--text-secondary)" },
  exportBtn: { marginLeft: "auto", background: "none", border: "1px solid var(--border-bright)", color: "var(--accent)", padding: "3px 10px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
  tableScroll: { flex: 1, overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th: { padding: "8px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.5px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", position: "sticky" as const, top: 0, whiteSpace: "nowrap" as const },
  td: { padding: "7px 14px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12 },
  placeholder: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", textAlign: "center" as const },
};
