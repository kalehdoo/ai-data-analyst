"use client";
import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/lib/authContext";
import * as mcp from "@/lib/mcpClient";
import SchemaExplorer from "./SchemaExplorer";
import QueryRunner from "./QueryRunner";
import PromptRunner from "./PromptRunner";
import ToolsPanel from "./ToolsPanel";
import Chat from "./Chat";
import DataLineage from "./DataLineage";
import ETLLineage from "./ETLLineage";

type Tab = "schemas" | "query" | "tools" | "prompts" | "chat" | "datamodel" | "etl";

export default function Workbench() {
  const { user, logout } = useAuth();
  const [tab, setTab] = useState<Tab>("schemas");
  const [connected, setConnected] = useState<"idle" | "connecting" | "ok" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    setConnected("connecting");
    mcp.initializeMCP()
      .then(() => { setConnected("ok"); setStatusMsg("Connected"); })
      .catch((e: Error) => { setConnected("error"); setStatusMsg(e.message); });
  }, []);

  const allTabs: { id: Tab; label: string; icon: string; roles: string[] }[] = [
    { id: "schemas", label: "Schema Explorer", icon: "⬡", roles: ["Admin", "Analyst", "Viewer"] },
    { id: "datamodel", label: "Data Model", icon: "⟺", roles: ["Admin", "Analyst", "Viewer"] },
    { id: "query",   label: "SQL Query",       icon: "▶", roles: ["Admin", "Analyst", "Viewer"] },
    { id: "tools",   label: "Analysis Tools",  icon: "⚙", roles: ["Admin", "Analyst"] },
    { id: "prompts", label: "AI Prompts",       icon: "✦", roles: ["Admin", "Analyst"] },
    { id: "chat", label: "Data Chat", icon: "💬", roles: ["Admin", "Analyst"] },
    { id: "etl", label: "ETL Lineage", icon: "⬡", roles: ["Admin", "Analyst", "Viewer"] },
  ];

  const tabs = allTabs.filter((t) => t.roles.includes(user?.role || ""));

  return (
    <div style={s.root}>
      {/* Sidebar */}
      <aside style={s.sidebar}>
        <div style={s.sideTop}>
          <div style={s.brand}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="var(--accent-dim)" />
            <path d="M8 22 L16 10 L24 22" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx="16" cy="10" r="2" fill="var(--accent)" />
          </svg>
            <span style={s.brandText}>Retrieval Augmented Natural Agent</span>
          </div>

          <div style={s.statusRow}>
            <span style={{ ...s.statusDot, background: connected === "ok" ? "var(--green)" : connected === "error" ? "var(--red)" : "var(--amber)" }} />
            <span style={s.statusText}>
              {connected === "ok" ? "MCP Connected" : connected === "error" ? "Connection error" : "Connecting…"}
            </span>
          </div>
          {connected === "error" && <p style={s.statusErr}>{statusMsg}</p>}

          <nav style={s.nav}>
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{ ...s.navBtn, ...(tab === t.id ? s.navBtnActive : {}) }}
              >
                <span style={s.navIcon}>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </nav>
        </div>

        <div style={s.sideBottom}>
          <div style={s.userRow}>
            <div style={s.avatar}>{user?.displayName[0]}</div>
            <div>
              <div style={s.userName}>{user?.displayName}</div>
              <div style={s.userRole}>{user?.role}</div>
            </div>
          </div>
          <button onClick={logout} style={s.logoutBtn}>Sign out</button>
        </div>
      </aside>

      {/* Main content */}
      <main style={s.main}>
        {connected !== "ok" ? (
  <div style={{ padding: 40, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
    {connected === "connecting" && "⟳ Connecting to MCP server…"}
    {connected === "error" && `⚠ Connection failed: ${statusMsg}`}
  </div>
) : (
  <>
    {tab === "schemas" && <SchemaExplorer />}
    {tab === "datamodel" && <DataLineage />}
    {tab === "etl" && <ETLLineage />}
    {tab === "query"   && <QueryRunner />}
    {tab === "tools"   && <ToolsPanel />}
    {tab === "prompts" && <PromptRunner />}
    {tab === "chat"    && <Chat />}
  </>
)}
      </main>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg)" },
  sidebar: {
    width: 220,
    minWidth: 220,
    background: "var(--bg-panel)",
    borderRight: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "space-between",
    padding: "20px 0",
  },
  sideTop: { padding: "0 16px" },
  brand: { display: "flex", alignItems: "center", gap: 8, marginBottom: 24 },
  brandText: { fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 14, color: "var(--text-primary)" },
  statusRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  statusDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  statusText: { fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  statusErr: { fontSize: 11, color: "var(--red)", marginBottom: 12, wordBreak: "break-word" as const },
  nav: { display: "flex", flexDirection: "column", gap: 2, marginTop: 24 },
  navBtn: {
    display: "flex", alignItems: "center", gap: 8,
    background: "none",
    borderTop: "none", borderRight: "none", borderBottom: "none", borderLeft: "2px solid transparent",
    cursor: "pointer",
    color: "var(--text-secondary)", fontSize: 13, fontFamily: "var(--font-sans)",
    paddingTop: "8px", paddingBottom: "8px", paddingRight: "10px", paddingLeft: "10px",
    borderRadius: "var(--radius)",
    textAlign: "left" as const, transition: "all 0.1s",
  },
  navBtnActive: {
    background: "var(--accent-dim)",
    color: "var(--accent)",
    borderLeft: "2px solid var(--accent)",
    paddingLeft: 8,
  },
  navIcon: { fontSize: 14, width: 16, textAlign: "center" as const },
  sideBottom: { padding: "16px" },
  userRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 },
  avatar: {
    width: 32, height: 32, borderRadius: "50%",
    background: "var(--accent-dim)", border: "1px solid var(--accent-border)",
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "var(--accent)", fontSize: 13, fontWeight: 600, flexShrink: 0,
  },
  userName: { fontSize: 13, fontWeight: 500, color: "var(--text-primary)" },
  userRole: { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  logoutBtn: {
    width: "100%", background: "none", border: "1px solid var(--border-bright)",
    color: "var(--text-secondary)", borderRadius: "var(--radius)",
    padding: "6px", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)",
  },
  main: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" },
};
