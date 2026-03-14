"use client";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/authContext";
import * as mcp from "@/lib/mcpClient";
import { loadApiKeys, getMissingKeyMessage, UserApiKeys } from "./Settings";

type Model = "gemini" | "openai" | "claude";

interface QueryResult {
  rows: Record<string, unknown>[];
  columns: Array<{ name: string }>;
  rowCount: number;
  executionMs: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  queryResults?: Record<string, QueryResult>;
}

const STORAGE_KEY = "rana_chat_history";
const MODEL_KEY = "rana_chat_model";

export default function Chat() {
  const { user } = useAuth();
  const isAdmin = user?.role === "Admin";

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [model, setModel] = useState<Model>("gemini");
  const [schema, setSchema] = useState("");
  const [runningQuery, setRunningQuery] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [contextMode, setContextMode] = useState<"sqlite" | "dbt" | "both">("sqlite");

  // Load persisted chat and model
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setMessages(JSON.parse(saved));
      const savedModel = localStorage.getItem(MODEL_KEY) as Model;
      if (savedModel) setModel(savedModel);
    } catch (_) {}
  }, []);

  // Persist messages
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    }
  }, [messages]);

  // Persist model choice
  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model);
  }, [model]);

  const CONTEXT_KEY = "rana_chat_context";

useEffect(() => {
  try {
    const saved = localStorage.getItem(CONTEXT_KEY) as "sqlite" | "dbt" | "both";
    if (saved) setContextMode(saved);
  } catch (_) {}
}, []);

useEffect(() => {
  localStorage.setItem(CONTEXT_KEY, contextMode);
}, [contextMode]);

  // Auto scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Load schema on mount
  useEffect(() => {
    loadSchema();
  }, []);

  async function loadSchema() {
    try {
      const res = await mcp.readResource("schemas://list");
      const data = JSON.parse(res.contents[0].text);
      const tables = data.tables || [];

      // Get column info for each table
      const tableDetails = await Promise.all(
        tables.slice(0, 20).map(async (t: { name: string }) => {
          try {
            const detail = await mcp.readResource(`table://main/${t.name}`);
            const d = JSON.parse(detail.contents[0].text);
            const cols = d.columns.map((c: { name?: string; column_name?: string; type?: string; data_type?: string }) =>
              `${c.name || c.column_name} (${c.type || c.data_type})`
            ).join(", ");
            return `- ${t.name}: ${cols}`;
          } catch {
            return `- ${t.name}`;
          }
        })
      );
      setSchema(tableDetails.join("\n"));
    } catch (_) {}
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };

    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    const assistantId = (Date.now() + 1).toString();
    const assistantMessage: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, assistantMessage]);

    try {
      const res = await fetch("/api/chat-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
  messages: newMessages.map((m) => ({
    role: m.role,
    content: m.content,
  })),
  model,
  schema,
  contextMode,
}),
      });

      if (!res.ok) throw new Error(await res.text());

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No stream");

      let fullText = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const chunk = decoder.decode(value);
  const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
  for (const line of lines) {
    const data = line.replace("data: ", "").trim();
    if (data === "[DONE]") break;
    try {
      const parsed = JSON.parse(data);
      if (parsed.text) {
        fullText += parsed.text;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: fullText } : m
          )
        );
      } else if (parsed.toolCall) {
        // Show tool call in progress
        const toolText = `\n\`\`\`tool-call\n🔧 Calling: ${parsed.toolCall.name}\n${JSON.stringify(parsed.toolCall.args, null, 2)}\n\`\`\`\n`;
        fullText += toolText;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: fullText } : m
          )
        );
      } else if (parsed.toolResult) {
        // Show tool result summary
        const resultPreview = parsed.toolResult.result.slice(0, 200);
        const toolText = `\`\`\`tool-result\n✓ ${parsed.toolResult.name} returned data\n${resultPreview}${parsed.toolResult.result.length > 200 ? "…" : ""}\n\`\`\`\n`;
        fullText += toolText;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: fullText } : m
          )
        );
      }
    } catch (_) {}
  }
}
    } catch (e: unknown) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: `Error: ${e instanceof Error ? e.message : String(e)}` }
            : m
        )
      );
    } finally {
      setLoading(false);
    }
  }

  async function runSQL(sql: string, messageId: string) {
    setRunningQuery(sql);
    try {
      const res = await mcp.callTool("execute_query", { sql, limit: 100 });
      const result: QueryResult = JSON.parse(res.content[0].text);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, queryResults: { ...m.queryResults, [sql]: result } }
            : m
        )
      );

      // Add result summary to conversation context
      const summary = `Query executed: ${result.rowCount} rows returned in ${result.executionMs}ms.\nFirst few rows: ${JSON.stringify(result.rows.slice(0, 3), null, 2)}`;
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: "user",
          content: `[Query Result] ${summary}`,
          timestamp: Date.now(),
        },
      ]);
    } catch (e: unknown) {
      alert(`Query error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunningQuery(null);
    }
  }

  function clearChat() {
    if (confirm("Clear all chat history?")) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendMessage();
  }

  const modelOptions: { id: Model; label: string; color: string; available: boolean }[] = [
    { id: "gemini", label: "Gemini", color: "#4285f4", available: true },
    { id: "openai", label: "GPT-4o mini", color: "#10a37f", available: true },
    { id: "claude", label: "Claude", color: "var(--accent)", available: isAdmin },
  ];

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>💬 Data Chat</h2>
          <p style={s.sub}>Ask questions about your data in plain English</p>
        </div>
        <div style={s.headerRight}>
  
  

  
          {/* Model selector */}
          <div style={s.modelSelector}>
            {modelOptions.filter((m) => m.available).map((opt) => (
              <button
                key={opt.id}
                onClick={() => setModel(opt.id)}
                style={{
  ...s.modelBtn,
  ...(model === opt.id ? {
    background: opt.color,
    color: "#fff",
    borderTop: `1px solid ${opt.color}`,
    borderRight: `1px solid ${opt.color}`,
    borderBottom: `1px solid ${opt.color}`,
    borderLeft: `1px solid ${opt.color}`,
  } : {}),
}}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button onClick={clearChat} style={s.clearBtn}>Clear chat</button>
        </div>
      </div>

      {/* Messages */}
      <div style={s.messages}>
        {messages.length === 0 && (
          <div style={s.empty}>
            <div style={s.emptyIcon}>💬</div>
            <p style={s.emptyTitle}>Start a conversation with your data</p>
            <p style={s.emptySub}>Try asking:</p>
            <div style={s.suggestions}>
              {[
                "What tables do I have?",
                "Show me the top 10 rows from my largest table",
                "What are the most common values in the status column?",
                "Are there any data quality issues I should know about?",
              ].map((q) => (
                <button key={q} onClick={() => setInput(q)} style={s.suggestionBtn}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages
          .filter((m) => !m.content.startsWith("[Query Result]"))
          .map((msg) => (
            <div key={msg.id} style={{ ...s.message, ...(msg.role === "user" ? s.userMessage : s.assistantMessage) }}>
              {/* Role label */}
              <div style={s.messageRole}>
                {msg.role === "user" ? user?.displayName : `AI (${model})`}
                <span style={s.messageTime}>
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </span>
              </div>

              {/* Message content */}
              <div style={s.messageContent}>
                <MessageContent
                  content={msg.content}
                  messageId={msg.id}
                  onRunSQL={runSQL}
                  runningQuery={runningQuery}
                  queryResults={msg.queryResults}
                />
              </div>
            </div>
          ))}

        {loading && (
          <div style={{ ...s.message, ...s.assistantMessage }}>
            <div style={s.messageRole}>AI ({model})</div>
            <div style={s.thinking}>
              <span style={s.dot} />
              <span style={s.dot} />
              <span style={s.dot} />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={s.inputArea}>
  {/* Context mode toggle — above input right side */}
  <div style={s.contextRow}>
    <span style={s.contextLabel}>Context:</span>
    {([
      { id: "sqlite", label: "🗄 sqlite", desc: "Query live database" },
      { id: "dbt",    label: "⬡ dbt",    desc: "dbt schema — Snowflake SQL only" },
      { id: "both",   label: "⟺ Both",   desc: "Search dbt schema and SQLite" },
    ] as const).map((opt) => {
      const activeColor = opt.id === "sqlite" ? "var(--accent)" : opt.id === "dbt" ? "#bc8cff" : "#3fb950";
      const isActive = contextMode === opt.id;
      return (
        <div key={opt.id} style={s.contextBtnWrap}>
          <button
            onClick={() => setContextMode(opt.id)}
            style={{
              ...s.contextBtn,
              ...(isActive ? {
                background: activeColor,
                color: "#000",
                borderTop: `1px solid ${activeColor}`,
                borderRight: `1px solid ${activeColor}`,
                borderBottom: `1px solid ${activeColor}`,
                borderLeft: `1px solid ${activeColor}`,
                fontWeight: 600,
              } : {}),
            }}
          >
            {opt.label}
          </button>
          
        </div>
      );
    })}
  </div>
  <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
  <textarea
    style={s.input}
    value={input}
    onChange={(e) => setInput(e.target.value)}
    onKeyDown={handleKeyDown}
    placeholder="Ask a question about your data… (⌘+Enter to send)"
    rows={3}
  />
  <button
    onClick={sendMessage}
    disabled={loading || !input.trim()}
    style={{ ...s.sendBtn, opacity: loading || !input.trim() ? 0.5 : 1 }}
  >
    {loading ? "⟳" : "Send ↑"}
  </button>
</div>
      </div>
    </div>
  );
}

// Renders message content with SQL blocks and run buttons
function MessageContent({
  content, messageId, onRunSQL, runningQuery, queryResults,
}: {
  content: string;
  messageId: string;
  onRunSQL: (sql: string, id: string) => void;
  runningQuery: string | null;
  queryResults?: Record<string, QueryResult>;
}) {
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.split("\n");
          const lang = lines[0].replace("```", "").trim().toLowerCase();
          const code = lines.slice(1, -1).join("\n").trim();
          const isSQL = lang === "sql" || lang === "sqlite";
const isToolCall = lang === "tool-call";
const isToolResult = lang === "tool-result";

          return (
            <div key={i} style={cb.block}>
              <div style={cb.header}>
                <span style={cb.lang}>{lang || "code"}</span>
                {isSQL && (
                  <button
                    onClick={() => onRunSQL(code, messageId)}
                    disabled={runningQuery === code}
                    style={cb.runBtn}
                  >
                    {runningQuery === code ? "⟳ Running…" : "▶ Run Query"}
                  </button>
                )}
              </div>
              <pre style={cb.code}>{code}</pre>

              {/* Show results if query was run */}
              {isSQL && queryResults?.[code] && (
                <QueryResultTable result={queryResults[code]} />
              )}
            </div>
          );
        }

        // Render text with basic markdown
        return (
          <div key={i}>
            {part.split("\n").map((line, j) => {
              if (line.startsWith("### ")) return <h3 key={j} style={tx.h3}>{line.slice(4)}</h3>;
              if (line.startsWith("## ")) return <h2 key={j} style={tx.h2}>{line.slice(3)}</h2>;
              if (line.startsWith("# ")) return <h1 key={j} style={tx.h1}>{line.slice(2)}</h1>;
              if (line.startsWith("- ") || line.startsWith("• ")) return <div key={j} style={tx.bullet}>• {line.slice(2)}</div>;
              if (line.startsWith("**") && line.endsWith("**")) return <strong key={j} style={tx.bold}>{line.slice(2, -2)}</strong>;
              if (line.trim() === "") return <br key={j} />;
              return <p key={j} style={tx.p}>{line}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

interface QueryResult {
  rows: Record<string, unknown>[];
  columns: Array<{ name: string }>;
  rowCount: number;
  executionMs: number;
}

function QueryResultTable({ result }: { result: QueryResult }) {
  if (!result.rows.length) return (
    <div style={qr.empty}>No rows returned</div>
  );

  return (
    <div style={qr.wrapper}>
      <div style={qr.meta}>
        {result.rowCount} rows · {result.executionMs}ms
      </div>
      <div style={qr.tableWrap}>
        <table style={qr.table}>
          <thead>
            <tr>
              {result.columns.map((col) => (
                <th key={col.name} style={qr.th}>{col.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.slice(0, 20).map((row, i) => (
              <tr key={i}>
                {result.columns.map((col) => (
                  <td key={col.name} style={qr.td}>
                    {row[col.name] === null
                      ? <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>NULL</span>
                      : String(row[col.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.rows.length > 20 && (
        <div style={qr.more}>Showing 20 of {result.rowCount} rows</div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: { padding: "20px 28px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub: { color: "var(--text-secondary)", fontSize: 13 },
  headerRight: { display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" },
  modelSelector: { display: "flex", gap: 6 },
  modelBtn: { background: "var(--bg-elevated)", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 12px", borderRadius: 99, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)", transition: "all 0.15s" },
  clearBtn: { background: "none", border: "1px solid var(--border-bright)", color: "var(--text-muted)", padding: "5px 12px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  messages: { flex: 1, overflow: "auto", padding: "20px 28px", display: "flex", flexDirection: "column", gap: 16 },
  empty: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 40, textAlign: "center" as const },
  emptyIcon: { fontSize: 36, marginBottom: 16 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 8 },
  emptySub: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 },
  suggestions: { display: "flex", flexDirection: "column", gap: 8, maxWidth: 400 },
  suggestionBtn: { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "8px 16px", borderRadius: "var(--radius)", fontSize: 13, cursor: "pointer", textAlign: "left" as const },
  message: { display: "flex", flexDirection: "column", gap: 6, maxWidth: "85%" },
  userMessage: { alignSelf: "flex-end", alignItems: "flex-end" },
  assistantMessage: { alignSelf: "flex-start", alignItems: "flex-start" },
  messageRole: { fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 8, alignItems: "center" },
  messageTime: { fontSize: 10, color: "var(--text-muted)" },
  messageContent: { background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", padding: "12px 16px", fontSize: 13, lineHeight: 1.6 },
  thinking: { display: "flex", gap: 4, padding: "12px 16px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" },
  dot: { width: 6, height: 6, borderRadius: "50%", background: "var(--text-muted)", animation: "pulse 1.4s infinite" },
  inputArea:    { padding: "8px 28px 16px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column" as const, gap: 8 },
contextRow:   { display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" },
  input: { flex: 1, background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", borderRadius: "var(--radius)", padding: "10px 14px", color: "var(--text-primary)", fontFamily: "var(--font-sans)", fontSize: 14, outline: "none", resize: "none" as const, lineHeight: 1.5 },
  sendBtn: { background: "var(--accent)", color: "#000", border: "none", borderRadius: "var(--radius)", padding: "10px 20px", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" as const },
  contextToggle:  { display: "flex", alignItems: "center", gap: 4 },
contextLabel:   { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginRight: 4 },
contextBtn:     { background: "var(--bg-elevated)", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 10px", borderRadius: 99, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
modeBanner:     { fontSize: 11, padding: "4px 10px", borderRadius: 99, border: "1px solid", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" as const },
};

const cb: Record<string, React.CSSProperties> = {
  block: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius)", margin: "8px 0", overflow: "hidden" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" },
  lang: { fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px" },
  runBtn: { background: "var(--green-dim)", border: "1px solid var(--green)", color: "var(--green)", padding: "3px 10px", borderRadius: 99, fontSize: 11, cursor: "pointer", fontFamily: "var(--font-mono)" },
  code: { padding: 12, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", whiteSpace: "pre-wrap" as const, margin: 0 },
};

const tx: Record<string, React.CSSProperties> = {
  h1: { fontSize: 17, fontWeight: 600, color: "var(--text-primary)", margin: "12px 0 6px" },
  h2: { fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "10px 0 5px" },
  h3: { fontSize: 13, fontWeight: 600, color: "var(--text-primary)", margin: "8px 0 4px" },
  p: { color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: 2 },
  bullet: { color: "var(--text-secondary)", lineHeight: 1.7, paddingLeft: 12, marginBottom: 2 },
  bold: { color: "var(--text-primary)", fontWeight: 600 },
};

const qr: Record<string, React.CSSProperties> = {
  wrapper: { borderTop: "1px solid var(--border)" },
  meta: { padding: "4px 12px", fontSize: 11, color: "var(--text-muted)", background: "var(--bg-elevated)", fontFamily: "var(--font-mono)" },
  tableWrap: { overflowX: "auto" as const },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 },
  th: { padding: "6px 12px", textAlign: "left" as const, fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.5px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" as const },
  td: { padding: "5px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" as const },
  empty: { padding: "8px 12px", color: "var(--text-muted)", fontSize: 12, fontStyle: "italic" },
  more: { padding: "4px 12px", fontSize: 11, color: "var(--text-muted)", borderTop: "1px solid var(--border)" },
};