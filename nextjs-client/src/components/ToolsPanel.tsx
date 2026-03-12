"use client";
import { useState } from "react";
import * as mcp from "@/lib/mcpClient";

type ToolName = "sample_table" | "column_stats" | "top_values" | "time_series" | "correlation" | "data_quality_check" | "search_value";

const TOOLS: { id: ToolName; label: string; icon: string; desc: string }[] = [
  { id: "sample_table",        icon: "▦", label: "Sample Table",       desc: "Fetch random rows from a table" },
  { id: "column_stats",        icon: "∑", label: "Column Stats",        desc: "Min, max, avg, nulls, distinct count" },
  { id: "top_values",          icon: "⬆", label: "Top Values",          desc: "Most frequent values in a column" },
  { id: "time_series",         icon: "⌒", label: "Time Series",         desc: "Aggregate a metric over time" },
  { id: "correlation",         icon: "≈", label: "Correlation",          desc: "Pearson correlation between two columns" },
  { id: "data_quality_check",  icon: "✓", label: "Data Quality",        desc: "Null rates, duplicates, coverage audit" },
  { id: "search_value",        icon: "⌕", label: "Search Value",        desc: "Find a value across all text columns" },
];

export default function ToolsPanel() {
  const [activeTool, setActiveTool] = useState<ToolName>("sample_table");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string>("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function setArg(key: string, val: string) {
    setArgs((prev) => ({ ...prev, [key]: val }));
  }

  async function runTool() {
    setLoading(true); setError(""); setResult("");
    try {
      const res = await mcp.callTool(activeTool, args);
      const text = res.content[0].text;
      setResult(text);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const tool = TOOLS.find((t) => t.id === activeTool)!;

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h2 style={s.title}>⚙ Analysis Tools</h2>
        <p style={s.sub}>Pre-built MCP tools for common data analysis tasks</p>
      </div>

      <div style={s.body}>
        {/* Tool selector */}
        <div style={s.toolList}>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setActiveTool(t.id); setArgs({}); setResult(""); setError(""); }}
              style={{ ...s.toolItem, ...(activeTool === t.id ? s.toolItemActive : {}) }}
            >
              <span style={s.toolIcon}>{t.icon}</span>
              <div>
                <div style={s.toolLabel}>{t.label}</div>
                <div style={s.toolDesc}>{t.desc}</div>
              </div>
            </button>
          ))}
        </div>

        {/* Tool form */}
        <div style={s.formPanel}>
          <div style={s.formHeader}>
            <span style={s.formIcon}>{tool.icon}</span>
            <div>
              <div style={s.formTitle}>{tool.label}</div>
              <div style={s.formSubTitle}>{tool.desc}</div>
            </div>
          </div>

          <div style={s.fields}>
            <ToolFields toolId={activeTool} args={args} setArg={setArg} />
          </div>

          <button onClick={runTool} disabled={loading} style={{ ...s.runBtn, opacity: loading ? 0.6 : 1 }}>
            {loading ? "Running…" : `⚙ Run ${tool.label}`}
          </button>

          {error && (
            <div style={s.errorBox}>
              <strong>Error</strong>
              <pre style={s.errorPre}>{error}</pre>
            </div>
          )}

          {result && (
            <div style={s.resultBox}>
              <div style={s.resultHeader}>
                Result
              </div>
              <pre style={s.resultPre}>{formatResult(result)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToolFields({ toolId, args, setArg }: { toolId: ToolName; args: Record<string, string>; setArg: (k: string, v: string) => void }) {
  const F = (key: string, label: string, placeholder: string, type: string = "text", defaultVal?: string) => (
    <div key={key} style={fld.row}>
      <label style={fld.label}>{label}</label>
      <input
        type={type}
        style={fld.input}
        placeholder={placeholder}
        value={args[key] ?? defaultVal ?? ""}
        onChange={(e) => setArg(key, e.target.value)}
      />
    </div>
  );

  const S = (key: string, label: string, options: string[], defaultVal: string) => (
    <div key={key} style={fld.row}>
      <label style={fld.label}>{label}</label>
      <select style={fld.input} value={args[key] ?? defaultVal} onChange={(e) => setArg(key, e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );

  switch (toolId) {
    case "sample_table":
      return <>{F("schema","Schema","public","text","public")}{F("table","Table","users")}{F("limit","Limit","25","number","25")}</>;
    case "column_stats":
      return <>{F("schema","Schema","public","text","public")}{F("table","Table","users")}{F("column","Column","created_at")}</>;
    case "top_values":
      return <>{F("schema","Schema","public","text","public")}{F("table","Table","orders")}{F("column","Column","status")}{F("limit","Top N","20","number","20")}</>;
    case "time_series":
      return <>
        {F("schema","Schema","public","text","public")}
        {F("table","Table","events")}
        {F("dateColumn","Date Column","created_at")}
        {F("valueColumn","Value Column","amount")}
        {S("aggregation","Aggregation",["sum","avg","count","min","max"],"sum")}
        {S("period","Period",["hour","day","week","month","quarter","year"],"day")}
        {F("limit","Last N periods","90","number","90")}
      </>;
    case "correlation":
      return <>{F("schema","Schema","public","text","public")}{F("table","Table","orders")}{F("columnA","Column A","price")}{F("columnB","Column B","quantity")}</>;
    case "data_quality_check":
      return <>{F("schema","Schema","public","text","public")}{F("table","Table","users")}</>;
    case "search_value":
      return <>{F("searchValue","Search For","john@example.com")}{F("schema","Schema","public","text","public")}{F("tableFilter","Table Filter (optional)","user%")}{F("limit","Max results per column","5","number","5")}</>;
    default:
      return <></>;
  }
}

function formatResult(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: { padding: "24px 28px 16px", borderBottom: "1px solid var(--border)" },
  title: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub: { color: "var(--text-secondary)", fontSize: 13 },
  body: { display: "flex", flex: 1, overflow: "hidden", gap: 0 },
  toolList: { width: 220, borderRight: "1px solid var(--border)", overflow: "auto", padding: "12px 0" },
  toolItem: { display: "flex", alignItems: "flex-start", gap: 10, width: "100%", background: "none", borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "2px solid transparent", cursor: "pointer", paddingTop: "10px", paddingBottom: "10px", paddingRight: "16px", paddingLeft: "16px", textAlign: "left" as const, transition: "background 0.1s" },
toolItemActive: { background: "var(--accent-dim)", borderLeft: "2px solid var(--accent)" },
  toolIcon: { fontSize: 16, flexShrink: 0, paddingTop: 2, color: "var(--accent)", fontFamily: "var(--font-mono)" },
  toolLabel: { fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 2 },
  toolDesc: { fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 },
  formPanel: { flex: 1, overflow: "auto", padding: 28 },
  formHeader: { display: "flex", alignItems: "center", gap: 14, marginBottom: 24, paddingBottom: 20, borderBottom: "1px solid var(--border)" },
  formIcon: { fontSize: 24, color: "var(--accent)" },
  formTitle: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)" },
  formSubTitle: { fontSize: 13, color: "var(--text-secondary)", marginTop: 2 },
  fields: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 },
  runBtn: { background: "var(--accent)", color: "#000", border: "none", borderRadius: "var(--radius)", padding: "10px 20px", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 20 },
  errorBox: { padding: "14px 16px", background: "var(--red-dim)", border: "1px solid var(--red)", borderRadius: "var(--radius)", marginBottom: 16 },
  errorPre: { marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--red)", whiteSpace: "pre-wrap" as const },
  resultBox: { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden" },
  resultHeader: { padding: "8px 16px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px" },
  resultPre: { padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap" as const, overflowX: "auto" as const, maxHeight: 500, overflow: "auto" },
};

const fld: Record<string, React.CSSProperties> = {
  row: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.5px" },
  input: { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", borderRadius: "var(--radius)", padding: "8px 12px", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", maxWidth: 400 },
};
