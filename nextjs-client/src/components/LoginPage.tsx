"use client";
import { useState } from "react";
import { useAuth } from "@/lib/authContext";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    await new Promise((r) => setTimeout(r, 400));
    const ok = login(username, password);
    if (!ok) setError("Invalid username or password.");
    setLoading(false);
  }

  return (
    <div style={styles.root}>
      <div style={styles.grid} aria-hidden />
      <div style={styles.card}>
        <div style={styles.logoRow}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="var(--accent-dim)" />
            <path d="M8 22 L16 10 L24 22" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="16" cy="10" r="2" fill="var(--accent)" />
          </svg>
          <span style={styles.logoText}>MCP Datawarehouse Workbench</span>
        </div>

        <h1 style={styles.heading}>Sign in</h1>
        <p style={styles.sub}>MCP AI Workbench for Datawarehouse & Datalake</p>

        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>Username</label>
          <input
            style={styles.input}
            type="text"
            autoComplete="username"
            placeholder="analyst"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />

          <label style={styles.label}>Password</label>
          <input
            style={styles.input}
            type="password"
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {error && (
            <div style={styles.errorBox}>
              <span style={{ marginRight: 6 }}>⚠</span>{error}
            </div>
          )}

          <button
            type="submit"
            style={{ ...styles.button, opacity: loading ? 0.6 : 1 }}
            disabled={loading}
          >
            {loading ? "Signing in…" : "Sign in →"}
          </button>
        </form>

        <div style={styles.hint}>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Demo credentials: </span>
          <code style={{ color: "var(--text-secondary)", fontSize: 12 }}>admin / analyst2024!</code><br />
          <code style={{ color: "var(--text-secondary)", fontSize: 12 }}>analyst / data@pass1</code> <br />
          <code style={{ color: "var(--text-secondary)", fontSize: 12 }}>viewer / view0nly!</code>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    minHeight: "100vh", display: "flex", alignItems: "center",
    justifyContent: "center", background: "var(--bg)",
    position: "relative", overflow: "hidden",
  },
  grid: {
    position: "absolute", inset: 0,
    backgroundImage: `linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)`,
    backgroundSize: "40px 40px", opacity: 0.4, pointerEvents: "none",
  },
  card: {
    position: "relative", background: "var(--bg-panel)",
    border: "1px solid var(--border-bright)", borderRadius: "var(--radius-lg)",
    padding: "40px 44px", width: "100%", maxWidth: 420,
    boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
  },
  logoRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 28 },
  logoText: { fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 600, color: "var(--text-primary)", letterSpacing: "-0.5px" },
  heading: { fontSize: 20, fontWeight: 600, color: "var(--text-primary)", lineHeight: 1.3, marginBottom: 6 },
  sub: { color: "var(--text-secondary)", fontSize: 13, marginBottom: 28 },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  label: { fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", letterSpacing: "0.5px", textTransform: "uppercase", marginBottom: -4 },
  input: {
    background: "var(--bg-elevated)", border: "1px solid var(--border-bright)",
    borderRadius: "var(--radius)", padding: "10px 14px", color: "var(--text-primary)",
    fontFamily: "var(--font-mono)", fontSize: 14, outline: "none",
  },
  errorBox: {
    background: "var(--red-dim)", border: "1px solid var(--red)",
    borderRadius: "var(--radius)", padding: "10px 14px", color: "var(--red)", fontSize: 13,
  },
  button: {
    background: "var(--accent)", color: "#000", border: "none",
    borderRadius: "var(--radius)", padding: "12px 20px",
    fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600,
    cursor: "pointer", marginTop: 8,
  },
  hint: { marginTop: 20, textAlign: "center" as const },
};