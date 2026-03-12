"use client";
import { useState } from "react";
import * as mcp from "@/lib/mcpClient";
import ClaudeResponse from "./ClaudeResponse";
import GeminiResponse from "./GeminiResponse";
import OpenAIResponse from "./OpenAIResponse";

type PromptId = "explore_table" | "funnel_analysis" | "cohort_analysis" | "anomaly_detection" | "join_analysis" | "executive_summary";

const PROMPTS: { id: PromptId; icon: string; label: string; desc: string; color: string }[] = [
  { id: "explore_table", icon: "⬡", label: "Explore Table", desc: "Full EDA: schema, samples, stats, quality", color: "var(--accent)" },
  { id: "funnel_analysis", icon: "◃", label: "Funnel Analysis", desc: "Conversion funnel with drop-off rates", color: "var(--green)" },
  { id: "cohort_analysis", icon: "⧈", label: "Cohort Analysis", desc: "User retention cohort heatmap", color: "var(--purple)" },
  { id: "anomaly_detection", icon: "⚡", label: "Anomaly Detection", desc: "Z-score & IQR outlier detection", color: "var(--amber)" },
  { id: "join_analysis", icon: "⟺", label: "Join Analysis", desc: "Optimal join strategy between two tables", color: "var(--accent)" },
  { id: "executive_summary", icon: "◈", label: "Executive Summary", desc: "KPIs, trends, and business alerts", color: "var(--green)" },
];

export default function PromptRunner() {
  const [activePrompt, setActivePrompt] = useState<PromptId>("explore_table");
  const [args, setArgs] = useState<Record<string, string>>({});
  const [prompt, setPrompt] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showClaude, setShowClaude] = useState(false);
  const [showGemini, setShowGemini] = useState(false);
  const [showOpenAI, setShowOpenAI] = useState(false);

  function setArg(key: string, val: string) {
    setArgs((prev) => ({ ...prev, [key]: val }));
  }

  async function buildPrompt() {
    setLoading(true); setError(""); setPrompt("");
    try {
      const res = await mcp.getPrompt(activePrompt, args);
      const text = res.messages.map((m) =>
        typeof m.content === "string" ? m.content : m.content.text
      ).join("\n\n");
      setPrompt(text);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const active = PROMPTS.find((p) => p.id === activePrompt)!;

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h2 style={s.title}>✦ AI Analysis Prompts</h2>
        <p style={s.sub}>Generate ready-to-use prompts for Claude or any AI — pre-wired to your database schema</p>
      </div>

      <div style={s.body}>
        {/* Prompt cards */}
        <div style={s.cards}>
          {PROMPTS.map((p) => (
            <button
              key={p.id}
              onClick={() => { setActivePrompt(p.id); setArgs({}); setPrompt(""); setError(""); }}
              style={{ ...s.card, ...(activePrompt === p.id ? { ...s.cardActive, borderColor: p.color } : {}) }}
            >
              <span style={{ ...s.cardIcon, color: p.color }}>{p.icon}</span>
              <div style={s.cardLabel}>{p.label}</div>
              <div style={s.cardDesc}>{p.desc}</div>
            </button>
          ))}
        </div>

        {/* Config + output */}
        <div style={s.rightPanel}>
          <div style={s.configBox}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
              <span style={{ fontSize: 22, color: active.color }}>{active.icon}</span>
              <div>
                <div style={s.configTitle}>{active.label}</div>
                <div style={s.configSub}>{active.desc}</div>
              </div>
            </div>

            <div style={s.fields}>
              <PromptFields promptId={activePrompt} args={args} setArg={setArg} />
            </div>

            <button onClick={buildPrompt} disabled={loading} style={{ ...s.buildBtn, opacity: loading ? 0.6 : 1 }}>
              {loading ? "Building…" : "✦ Generate Prompt"}
            </button>
          </div>

          {error && (
            <div style={s.errorBox}>
              <strong>Error</strong>
              <pre style={s.errorPre}>{error}</pre>
            </div>
          )}

          {prompt && (
            <div style={s.promptBox}>
              <div style={s.promptHeader}>
                <span>Generated Prompt</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={copyPrompt} style={s.copyBtn}>
                    {copied ? "✓ Copied!" : "Copy"}
                  </button>
                  <button
                    onClick={() => setShowClaude(true)}
                    style={{ ...s.copyBtn, background: "var(--accent)", color: "#000", borderColor: "var(--accent)" }}
                  >
                    ✦ Send to Claude
                  </button>
                  <button
                    onClick={() => setShowGemini(true)}
                    style={{ ...s.copyBtn, background: "#4285f4", color: "#fff", borderColor: "#4285f4" }}
                  >
                    ✸ Send to Gemini
                  </button>
                  <button
                    onClick={() => setShowOpenAI(true)}
                    style={{ ...s.copyBtn, background: "#10a37f", color: "#fff", borderColor: "#10a37f" }}
                  >
                    ⬡ Send to GPT-4o
                  </button>
                </div>
              </div>
              <pre style={s.promptPre}>{prompt}</pre>
              <div style={s.promptFooter}>
                Paste this prompt into Claude or any AI assistant. It already knows your schema and which MCP tools to use.
              </div>
              {showClaude && prompt && (
                <ClaudeResponse
                  prompt={prompt}
                  onClose={() => setShowClaude(false)}
                />
              )}
              {showGemini && prompt && (
                <GeminiResponse
                  prompt={prompt}
                  onClose={() => setShowGemini(false)}
                />
              )}
              {showOpenAI && prompt && (
                <OpenAIResponse
                  prompt={prompt}
                  onClose={() => setShowOpenAI(false)}
                />
              )}
            </div>
          )}

          {!prompt && !error && !loading && (
            <div style={s.placeholder}>
              <div style={{ fontSize: 32, marginBottom: 12, color: "var(--text-muted)" }}>✦</div>
              <p>Configure parameters and click "Generate Prompt"</p>
              <p style={{ marginTop: 6, fontSize: 12 }}>The prompt will instruct an AI how to analyze your data step-by-step</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PromptFields({ promptId, args, setArg }: { promptId: PromptId; args: Record<string, string>; setArg: (k: string, v: string) => void }) {
  const F = (key: string, label: string, placeholder: string, defaultVal?: string, required = false) => (
    <div key={key} style={fld.row}>
      <label style={fld.label}>{label}{required && <span style={{ color: "var(--red)" }}> *</span>}</label>
      <input style={fld.input} placeholder={placeholder} value={args[key] ?? defaultVal ?? ""} onChange={(e) => setArg(key, e.target.value)} />
    </div>
  );

  const S = (key: string, label: string, opts: string[], def: string) => (
    <div key={key} style={fld.row}>
      <label style={fld.label}>{label}</label>
      <select style={fld.input} value={args[key] ?? def} onChange={(e) => setArg(key, e.target.value)}>
        {opts.map((o) => <option key={o}>{o}</option>)}
      </select>
    </div>
  );

  switch (promptId) {
    case "explore_table":
      return <>{F("schema", "Schema", "public", "public")}{F("table", "Table", "users", "", true)}{F("goal", "Analysis Goal (optional)", "What drives user churn?")}</>;
    case "funnel_analysis":
      return <>
        {F("schema", "Schema", "public", "public")}
        {F("eventTable", "Event Table", "events", "", true)}
        {F("userColumn", "User ID Column", "user_id", "", true)}
        {F("eventColumn", "Event Column", "event_name", "", true)}
        {F("steps", "Funnel Steps (comma-separated)", "signup,onboard,purchase", "", true)}
        {F("dateColumn", "Date Column (optional)", "created_at")}
      </>;
    case "cohort_analysis":
      return <>
        {F("schema", "Schema", "public", "public")}
        {F("table", "Activity Table", "events", "", true)}
        {F("userColumn", "User ID Column", "user_id", "", true)}
        {F("dateColumn", "Date Column", "created_at", "", true)}
        {S("cohortPeriod", "Cohort Period", ["week", "month"], "month")}
      </>;
    case "anomaly_detection":
      return <>
        {F("schema", "Schema", "public", "public")}
        {F("table", "Table", "orders", "", true)}
        {F("metricColumn", "Metric Column", "amount", "", true)}
        {F("dateColumn", "Date Column (optional)", "created_at")}
        {F("groupByColumn", "Group By Column (optional)", "status")}
      </>;
    case "join_analysis":
      return <>
        {F("schema", "Schema", "public", "public")}
        {F("primaryTable", "Primary Table", "users", "", true)}
        {F("relatedTable", "Related Table", "orders", "", true)}
        {F("businessQuestion", "Business Question", "Which users have the highest order value?", "", true)}
      </>;
    case "executive_summary":
      return <>
        {F("schema", "Schema", "public", "public")}
        {F("table", "Metrics Table", "orders", "", true)}
        {F("periodColumn", "Period Column (optional)", "created_at")}
        {F("metrics", "Metric Columns (comma-separated, optional)", "revenue,order_count")}
      </>;
    default:
      return <></>;
  }
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: { padding: "24px 28px 16px", borderBottom: "1px solid var(--border)" },
  title: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub: { color: "var(--text-secondary)", fontSize: 13 },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  cards: { width: 200, borderRight: "1px solid var(--border)", overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 6 },
  card: { background: "var(--bg-elevated)", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)", borderRadius: "var(--radius)", padding: "12px", textAlign: "left" as const, cursor: "pointer", transition: "all 0.15s" },
  cardActive: { background: "var(--bg-hover)", borderColor: "var(--accent)" },
  cardIcon: { fontSize: 18, display: "block", marginBottom: 6 },
  cardLabel: { fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  cardDesc: { fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.4 },
  rightPanel: { flex: 1, overflow: "auto", padding: 28, display: "flex", flexDirection: "column", gap: 20 },
  configBox: { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: 24 },
  configTitle: { fontSize: 15, fontWeight: 600, color: "var(--text-primary)" },
  configSub: { fontSize: 12, color: "var(--text-secondary)", marginTop: 2 },
  fields: { display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 },
  buildBtn: { background: "var(--accent)", color: "#000", border: "none", borderRadius: "var(--radius)", padding: "10px 20px", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  errorBox: { padding: 16, background: "var(--red-dim)", border: "1px solid var(--red)", borderRadius: "var(--radius)" },
  errorPre: { marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--red)", whiteSpace: "pre-wrap" as const },
  promptBox: { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", display: "flex", flexDirection: "column" as const, maxHeight: 500 },
  promptHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px" },
  copyBtn: { background: "var(--accent-dim)", border: "1px solid var(--accent-border)", color: "var(--accent)", padding: "4px 12px", borderRadius: 99, fontSize: 11, cursor: "pointer", fontFamily: "var(--font-mono)" },
  promptPre: { padding: 20, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap" as const, overflow: "auto", flex: 1 },
  promptFooter: { padding: "10px 16px", borderTop: "1px solid var(--border)", fontSize: 11, color: "var(--text-muted)", background: "var(--bg-elevated)", flexShrink: 0 },
  placeholder: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", textAlign: "center" as const, padding: 40 },
};

const fld: Record<string, React.CSSProperties> = {
  row: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase" as const, letterSpacing: "0.5px" },
  input: { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", borderRadius: "var(--radius)", padding: "8px 12px", color: "var(--text-primary)", fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", maxWidth: 500 },
};
