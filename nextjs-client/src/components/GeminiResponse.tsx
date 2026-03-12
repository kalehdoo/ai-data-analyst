"use client";
import { useState } from "react";

interface Props {
  prompt: string;
  onClose: () => void;
}

export default function GeminiResponse({ prompt, onClose }: Props) {
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState("");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedResponse, setCopiedResponse] = useState(false);

  async function sendToGemini() {
    setLoading(true);
    setStarted(true);
    setResponse("");
    setError("");

    try {
      const res = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(err);
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No response stream");

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
            if (parsed.text) setResponse((prev) => prev + parsed.text);
          } catch (_) {}
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={s.overlay}>
      <div style={s.modal}>
        {/* Header */}
        <div style={s.header}>
          <div style={s.headerLeft}>
            <span style={s.geminiIcon}>✸</span>
            <span style={s.headerTitle}>Gemini Analysis</span>
            {loading && <span style={s.streamingBadge}>⟳ Thinking…</span>}
            {!loading && started && !error && <span style={s.doneBadge}>✓ Done</span>}
          </div>
          <button onClick={onClose} style={s.closeBtn}>✕</button>
        </div>

        {/* Prompt preview */}
<div style={s.promptPreview}>
  <div style={s.promptLabelRow}>
    <div style={s.promptLabel}>Prompt</div>
    <button
  style={s.copyBtn}
  onClick={() => {
    navigator.clipboard.writeText(prompt);
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  }}
>
  {copiedPrompt ? "✓ Copied!" : "Copy Prompt"}
</button>
  </div>
  <div style={s.promptText}>{prompt}</div>
</div>

        {/* Send button */}
        {!started && (
          <div style={s.sendArea}>
            <button onClick={sendToGemini} style={s.sendBtn}>
              ✸ Send to Gemini
            </button>
            <p style={s.sendHint}>
              Gemini will analyze your prompt and generate a full data analysis report.
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={s.errorBox}>
            <strong>Error</strong>
            <pre style={s.errorPre}>{error}</pre>
          </div>
        )}

        {/* Response */}
        {started && (
          <div style={s.responseArea}>
            <div style={s.responseHeader}>
              Response
              {!loading && response && (
                <button
  style={s.copyBtn}
  onClick={() => {
    navigator.clipboard.writeText(response);
    setCopiedResponse(true);
    setTimeout(() => setCopiedResponse(false), 2000);
  }}
>
  {copiedResponse ? "✓ Copied!" : "Copy Response"}
</button>
              )}
            </div>
            <div style={s.responseBody}>
              {response ? (
                <MarkdownText text={response} />
              ) : loading ? (
                <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  Waiting for Gemini…
                </span>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MarkdownText({ text }: { text: string }) {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return (
    <div>
      {parts.map((part, i) => {
        if (part.startsWith("```")) {
          const lines = part.split("\n");
          const lang = lines[0].replace("```", "").trim();
          const code = lines.slice(1, -1).join("\n");
          return (
            <div key={i} style={md.codeBlock}>
              {lang && <div style={md.codeLang}>{lang}</div>}
              <pre style={md.code}>{code}</pre>
            </div>
          );
        }
        return (
          <div key={i} style={md.text}>
            {part.split("\n").map((line, j) => {
              if (line.startsWith("## ")) return <h2 key={j} style={md.h2}>{line.slice(3)}</h2>;
              if (line.startsWith("# ")) return <h1 key={j} style={md.h1}>{line.slice(2)}</h1>;
              if (line.startsWith("- ") || line.startsWith("• ")) return <div key={j} style={md.bullet}>• {line.slice(2)}</div>;
              if (line.trim() === "") return <br key={j} />;
              return <p key={j} style={md.p}>{line}</p>;
            })}
          </div>
        );
      })}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000, padding: 24,
  },
  modal: {
    background: "var(--bg-panel)", border: "1px solid var(--border-bright)",
    borderRadius: "var(--radius-lg)", width: "100%", maxWidth: 800,
    maxHeight: "90vh", display: "flex", flexDirection: "column",
    boxShadow: "0 32px 80px rgba(0,0,0,0.6)",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "16px 20px", borderBottom: "1px solid var(--border)",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 10 },
  geminiIcon: { fontSize: 18, color: "#4285f4" },
  headerTitle: { fontSize: 15, fontWeight: 600, color: "var(--text-primary)" },
  streamingBadge: {
    fontSize: 11, background: "var(--amber-dim)", color: "var(--amber)",
    border: "1px solid var(--amber)", borderRadius: 99, padding: "2px 8px",
    fontFamily: "var(--font-mono)",
  },
  doneBadge: {
    fontSize: 11, background: "var(--green-dim)", color: "var(--green)",
    border: "1px solid var(--green)", borderRadius: 99, padding: "2px 8px",
    fontFamily: "var(--font-mono)",
  },
  closeBtn: {
    background: "none", border: "none", color: "var(--text-muted)",
    cursor: "pointer", fontSize: 16, padding: 4,
  },
  promptPreview: {
  padding: "12px 20px", borderBottom: "1px solid var(--border)",
  background: "var(--bg-elevated)", maxHeight: 200, overflow: "auto",
  display: "flex", flexDirection: "column" as const, gap: 6,
},
promptLabelRow: {
  display: "flex", justifyContent: "space-between", alignItems: "center",
  flexShrink: 0,
},
  promptLabel: {
  fontSize: 10, fontWeight: 600, color: "var(--text-muted)",
  textTransform: "uppercase" as const, letterSpacing: "0.8px",
},
  promptText: {
  fontSize: 12, color: "var(--text-secondary)",
  fontFamily: "var(--font-mono)", lineHeight: 1.5,
  whiteSpace: "pre-wrap" as const,
},
  sendArea: {
    padding: 24, display: "flex", flexDirection: "column",
    alignItems: "center", gap: 12,
  },
  sendBtn: {
    background: "#4285f4", color: "#fff", border: "none",
    borderRadius: "var(--radius)", padding: "12px 32px",
    fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600,
    cursor: "pointer",
  },
  sendHint: {
    fontSize: 12, color: "var(--text-muted)",
    textAlign: "center" as const, maxWidth: 400,
  },
  errorBox: {
    margin: 16, padding: 16, background: "var(--red-dim)",
    border: "1px solid var(--red)", borderRadius: "var(--radius)",
  },
  errorPre: {
    marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12,
    color: "var(--red)", whiteSpace: "pre-wrap" as const,
  },
  responseArea: { display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" },
  responseHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "8px 20px", borderBottom: "1px solid var(--border)",
    background: "var(--bg-elevated)", fontSize: 11, fontWeight: 600,
    color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px",
  },
  copyBtn: {
    background: "var(--accent-dim)", border: "1px solid var(--accent-border)",
    color: "var(--accent)", padding: "3px 10px", borderRadius: 99,
    fontSize: 11, cursor: "pointer", fontFamily: "var(--font-mono)",
  },
  responseBody: { flex: 1, overflow: "auto", padding: 20 },
};

const md: Record<string, React.CSSProperties> = {
  h1: { fontSize: 18, fontWeight: 600, color: "var(--text-primary)", margin: "16px 0 8px" },
  h2: { fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: "14px 0 6px" },
  p: { color: "var(--text-secondary)", lineHeight: 1.7, marginBottom: 4 },
  bullet: { color: "var(--text-secondary)", lineHeight: 1.7, paddingLeft: 12, marginBottom: 2 },
  text: { marginBottom: 8 },
  codeBlock: {
    background: "var(--bg-elevated)", border: "1px solid var(--border)",
    borderRadius: "var(--radius)", margin: "12px 0", overflow: "hidden",
  },
  codeLang: {
    padding: "4px 12px", fontSize: 10, fontWeight: 600,
    color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px",
    borderBottom: "1px solid var(--border)",
  },
  code: {
    padding: 16, fontFamily: "var(--font-mono)", fontSize: 12,
    color: "#4285f4", whiteSpace: "pre-wrap" as const, overflowX: "auto" as const,
  },
};