"use client";
import { useAuth } from "@/lib/authContext";
import { useState, useEffect } from "react";

// ── API Key utilities (exported for use in other components) ──────────────────

export interface UserApiKeys {
  anthropic?: string;
  gemini?: string;
  openai?: string;
}

const STORAGE_KEY = "rana_user_api_keys";

export function saveApiKeys(keys: UserApiKeys) {
  try {
    localStorage.setItem(STORAGE_KEY, btoa(JSON.stringify(keys)));
  } catch (_) {}
}

export function loadApiKeys(): UserApiKeys {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(atob(raw));
  } catch (_) {
    return {};
  }
}

export function getMissingKeyMessage(model: string, keys: UserApiKeys): string | null {
  if (model === "claude" && !keys.anthropic) return "Add your Anthropic API key in Settings → API Keys to use Claude";
  if (model === "gemini" && !keys.gemini)    return "Add your Gemini API key in Settings → API Keys to use Gemini";
  if (model === "openai" && !keys.openai)    return "Add your OpenAI API key in Settings → API Keys to use GPT-4o";
  return null;
}

// ── Section definitions ───────────────────────────────────────────────────────

type SettingsSection = "apikeys" | "appearance" | "about";

const SECTIONS = [
  {
    id: "apikeys" as const,
    label: "API Keys",
    icon: "🔑",
    description: "Manage your personal AI provider keys",
    color: "#e8b84b",
  },
  {
    id: "appearance" as const,
    label: "Appearance",
    icon: "🎨",
    description: "Customize the look and feel",
    color: "#bc8cff",
  },
  {
    id: "about" as const,
    label: "About",
    icon: "ℹ",
    description: "App version and info",
    color: "#58a6ff",
  },
];

// ── Main Settings component ───────────────────────────────────────────────────

export default function Settings() {
  const [section, setSection] = useState<SettingsSection>("apikeys");

  return (
    <div style={s.root}>
      {/* Left sidebar */}
      <div style={s.sidebar}>
        <div style={s.sidebarTitle}>Settings</div>
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            onClick={() => setSection(sec.id)}
            style={{
              ...s.sectionBtn,
              background: section === sec.id ? `${sec.color}18` : "transparent",
              borderLeft: `3px solid ${section === sec.id ? sec.color : "transparent"}`,
              color: section === sec.id ? sec.color : "var(--text-secondary)",
            }}
          >
            <span style={s.sectionIcon}>{sec.icon}</span>
            <div>
              <div style={s.sectionLabel}>{sec.label}</div>
              <div style={s.sectionDesc}>{sec.description}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Right panel */}
      <div style={s.panel}>
        {section === "apikeys"    && <ApiKeysSection />}
        {section === "appearance" && <AppearanceSection />}
        {section === "about"      && <AboutSection />}
      </div>
    </div>
  );
}

// ── API Keys Section ──────────────────────────────────────────────────────────

function ApiKeysSection() {
    const { user } = useAuth();
    const isAdmin = user?.role === "Admin";
    function useIsAdmin() { return isAdmin; }
  const [keys, setKeys]     = useState<UserApiKeys>({});
  const [show, setShow]     = useState({ anthropic: false, gemini: false, openai: false });
  const [saved, setSaved]   = useState(false);

  useEffect(() => { setKeys(loadApiKeys()); }, []);

  function handleSave() {
    saveApiKeys(keys);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleClear() {
    localStorage.removeItem(STORAGE_KEY);
    setKeys({});
    setSaved(false);
  }

  const fields = [
    {
      id:          "anthropic" as keyof UserApiKeys,
      label:       "Anthropic API Key",
      model:       "Claude",
      placeholder: "sk-ant-...",
      helpUrl:     "https://console.anthropic.com/keys",
      color:       "#e8b84b",
      icon:        "🟡",
    },
    {
      id:          "gemini" as keyof UserApiKeys,
      label:       "Gemini API Key",
      model:       "Gemini",
      placeholder: "AIza...",
      helpUrl:     "https://aistudio.google.com/app/apikey",
      color:       "#58a6ff",
      icon:        "🔵",
    },
    {
      id:          "openai" as keyof UserApiKeys,
      label:       "OpenAI API Key",
      model:       "GPT-4o",
      placeholder: "sk-...",
      helpUrl:     "https://platform.openai.com/api-keys",
      color:       "#3fb950",
      icon:        "🟢",
    },
  ];

  return (
    <div style={p.root}>
      <div style={p.header}>
        <div>
          <h2 style={p.title}>🔑 API Keys</h2>
          <p style={p.sub}>
            Enter your own API keys to use your personal quota.
            Keys are stored locally in your browser and never sent to our servers.
          </p>
        </div>
        <div style={p.headerActions}>
          {saved && <span style={p.savedMsg}>✓ Saved!</span>}
          <button onClick={handleSave} style={p.saveBtn}>Save Keys</button>
        </div>
      </div>

      <div style={p.body}>
        {/* Info banner */}
        <div style={p.infoBanner}>
  <span style={{ fontSize: 16 }}>💡</span>
  <div>
    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 }}>
      How it works
    </div>
    <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.6 }}>
      {useIsAdmin()
        ? "As Admin you can use the server keys or override with your own. Your own key takes priority if provided."
        : "You need to provide your own API keys to use AI features. Keys are stored locally in your browser only."}
    </div>
  </div>
</div>

        {/* Key fields */}
        {fields.map((f) => {
          const val    = keys[f.id] || "";
          const hasKey = val.length > 0;
          return (
            <div key={f.id} style={p.card}>
              <div style={p.cardHeader}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 20 }}>{f.icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: f.color }}>{f.model}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{f.label}</div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {hasKey ? (
                    <span style={{ ...p.badge, background: `${f.color}22`, color: f.color, borderColor: `${f.color}55` }}>
                      ✓ Active — using your quota
                    </span>
                  ) : (
                    <span style={{ ...p.badge, background: "var(--bg)", color: "var(--text-muted)", borderColor: "var(--border)" }}>
                      Using server key
                    </span>
                  )}
                  <a href={f.helpUrl} target="_blank" rel="noreferrer" style={p.getKey}>
                    Get key →
                  </a>
                </div>
              </div>

              <div style={p.inputWrap}>
                <input
                  style={{
                    ...p.input,
                    borderColor: hasKey ? f.color : "var(--border-bright)",
                  }}
                  type={show[f.id as keyof typeof show] ? "text" : "password"}
                  placeholder={f.placeholder}
                  value={val}
                  onChange={(e) => setKeys({ ...keys, [f.id]: e.target.value })}
                />
                <button
                  style={p.iconBtn}
                  onClick={() => setShow({ ...show, [f.id as keyof typeof show]: !show[f.id as keyof typeof show] })}
                  title={show[f.id as keyof typeof show] ? "Hide key" : "Show key"}
                >
                  {show[f.id as keyof typeof show] ? "🙈" : "👁"}
                </button>
                {hasKey && (
                  <button
                    style={{ ...p.iconBtn, color: "var(--red)" }}
                    onClick={() => setKeys({ ...keys, [f.id]: "" })}
                    title="Remove key"
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* Clear all */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={handleClear} style={p.clearBtn}>
            Clear All Keys
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Appearance Section ────────────────────────────────────────────────────────

function AppearanceSection() {
  return (
    <div style={p.root}>
      <div style={p.header}>
        <div>
          <h2 style={p.title}>🎨 Appearance</h2>
          <p style={p.sub}>Customize the look and feel of the app.</p>
        </div>
      </div>
      <div style={p.body}>
        <div style={p.card}>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", fontStyle: "italic" }}>
            Appearance settings coming soon — dark mode customization, font size, and more.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── About Section ─────────────────────────────────────────────────────────────

function AboutSection() {
  return (
    <div style={p.root}>
      <div style={p.header}>
        <div>
          <h2 style={p.title}>ℹ About</h2>
          <p style={p.sub}>App information and version details.</p>
        </div>
      </div>
      <div style={p.body}>
        <div style={p.card}>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
            {[
              { label: "App Name",    value: "RANA — AI Data Analyst Workbench" },
              { label: "Version",     value: "1.0.0" },
              { label: "Stack",       value: "Next.js · MCP · SQLite Cloud · Anthropic · Gemini · OpenAI" },
              { label: "MCP Server",  value: process.env.NEXT_PUBLIC_MCP_SERVER_URL || "localhost:3001" },
            ].map((row) => (
              <div key={row.label} style={{ display: "flex", gap: 16 }}>
                <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", width: 120, flexShrink: 0 }}>
                  {row.label}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root:        { display: "flex", height: "100%", overflow: "hidden" },
  sidebar:     { width: 220, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" as const, padding: "16px 0", flexShrink: 0, background: "var(--bg-elevated)" },
  sidebarTitle:{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "1px", padding: "0 16px 12px", fontFamily: "var(--font-mono)" },
  sectionBtn:  { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: "none", border: "none", borderLeft: "3px solid transparent", cursor: "pointer", textAlign: "left" as const, width: "100%", transition: "all 0.15s" },
  sectionIcon: { fontSize: 18, flexShrink: 0 },
  sectionLabel:{ fontSize: 13, fontWeight: 500 },
  sectionDesc: { fontSize: 10, color: "var(--text-muted)", marginTop: 1 },
  panel:       { flex: 1, display: "flex", flexDirection: "column" as const, overflow: "hidden" },
};

const p: Record<string, React.CSSProperties> = {
  root:         { display: "flex", flexDirection: "column" as const, height: "100%", overflow: "hidden" },
  header:       { padding: "20px 28px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 },
  title:        { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: 0, marginBottom: 4 },
  sub:          { fontSize: 12, color: "var(--text-secondary)", margin: 0, maxWidth: 500 },
  headerActions:{ display: "flex", alignItems: "center", gap: 10 },
  savedMsg:     { fontSize: 12, color: "var(--green)", fontFamily: "var(--font-mono)" },
  saveBtn:      { background: "var(--accent)", border: "none", color: "#000", padding: "8px 20px", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-mono)" },
  body:         { flex: 1, overflow: "auto", padding: "20px 28px", display: "flex", flexDirection: "column" as const, gap: 16 },
  infoBanner:   { display: "flex", gap: 12, padding: "12px 16px", background: "rgba(232,184,75,0.06)", border: "1px solid rgba(232,184,75,0.2)", borderRadius: "var(--radius)" },
  card:         { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", borderRadius: "var(--radius)", padding: "16px 20px", display: "flex", flexDirection: "column" as const, gap: 12 },
  cardHeader:   { display: "flex", justifyContent: "space-between", alignItems: "center" },
  badge:        { fontSize: 10, fontWeight: 600, border: "1px solid", padding: "2px 8px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  getKey:       { fontSize: 11, color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)" },
  inputWrap:    { display: "flex", gap: 8, alignItems: "center" },
  input:        { flex: 1, background: "var(--bg)", borderTop: "1px solid", borderRight: "1px solid", borderBottom: "1px solid", borderLeft: "1px solid", color: "var(--text-primary)", padding: "8px 12px", borderRadius: "var(--radius)", fontSize: 13, outline: "none", fontFamily: "var(--font-mono)" },
  iconBtn:      { background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: "4px 6px", flexShrink: 0 },
  clearBtn:     { background: "none", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)", textDecoration: "underline" },
};
