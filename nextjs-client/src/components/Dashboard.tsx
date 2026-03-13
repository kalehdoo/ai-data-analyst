"use client";
import { useState, useEffect, useRef } from "react";
import * as mcp from "@/lib/mcpClient";
import { useAuth } from "@/lib/authContext";

interface SavedQuery {
  id: number;
  name: string;
  description: string;
  sql: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  is_pinned: number;
  is_shared: number;
  tags: string;
  run_count: number;
  last_run_at: string;
}

interface QueryTemplate {
  id: number;
  name: string;
  description: string;
  category: string;
  sql: string;
}

interface HistoryEntry {
  id: number;
  timestamp: string;
  username: string;
  details: string;
  duration_ms: number;
  row_count: number;
  status: string;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  columns: { name: string }[];
  rowCount: number;
  executionMs: number;
}

type Section = "pinned" | "history" | "shared" | "templates";

const SECTION_CONFIG = [
  { id: "pinned",    label: "Pinned Queries",  icon: "📌", desc: "Daily monitoring queries" },
  { id: "history",   label: "Query History",   icon: "🕐", desc: "Recently run queries" },
  { id: "shared",    label: "Shared Library",  icon: "📚", desc: "Team shared queries" },
  { id: "templates", label: "Templates",       icon: "📋", desc: "Common query patterns" },
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  Monitoring:  "#e8b84b",
  Exploration: "#58a6ff",
  Quality:     "#f78166",
  Filtering:   "#bc8cff",
  Analysis:    "#3fb950",
};

export default function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.role === "Admin";

  const [section, setSection] = useState<Section>("pinned");
  const [pinnedQueries, setPinnedQueries] = useState<SavedQuery[]>([]);
  const [sharedQueries, setSharedQueries] = useState<SavedQuery[]>([]);
  const [myQueries, setMyQueries] = useState<SavedQuery[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [templates, setTemplates] = useState<QueryTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  // Editor state
  const [editorSql, setEditorSql] = useState("");
  const [editorName, setEditorName] = useState("");
  const [editorDesc, setEditorDesc] = useState("");
  const [editorTags, setEditorTags] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const [activeQueryId, setActiveQueryId] = useState<number | null>(null);

  // Save modal
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePin, setSavePin] = useState(false);
  const [saveShare, setSaveShare] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState("");

  // Search
  const [search, setSearch] = useState("");

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      await Promise.all([loadSavedQueries(), loadHistory(), loadTemplates()]);
    } finally {
      setLoading(false);
    }
  }

  async function loadSavedQueries() {
    try {
      const res = await mcp.callTool("execute_query", {
        sql: `SELECT * FROM saved_queries ORDER BY is_pinned DESC, updated_at DESC`,
      });
      const data = JSON.parse(res.content[0].text);
      const rows: SavedQuery[] = data.rows || [];
      setPinnedQueries(rows.filter((r) => r.is_pinned === 1));
      setSharedQueries(rows.filter((r) => r.is_shared === 1));
      setMyQueries(rows.filter((r) => r.created_by === user?.username));
    } catch (e) { console.error(e); }
  }

  async function loadHistory() {
    try {
      const sql = isAdmin
        ? `SELECT * FROM audit_logs WHERE action_type = 'query' AND status = 'success' ORDER BY timestamp DESC LIMIT 100`
        : `SELECT * FROM audit_logs WHERE action_type = 'query' AND username = '${user?.username}' AND status = 'success' ORDER BY timestamp DESC LIMIT 100`;
      const res = await mcp.callTool("execute_query", { sql });
      const data = JSON.parse(res.content[0].text);
      setHistory(data.rows || []);
    } catch (e) { console.error(e); }
  }

  async function loadTemplates() {
    try {
      const res = await mcp.callTool("execute_query", {
        sql: `SELECT * FROM query_templates ORDER BY category, name`,
      });
      const data = JSON.parse(res.content[0].text);
      setTemplates(data.rows || []);
    } catch (e) { console.error(e); }
  }

  async function runQuery() {
    if (!editorSql.trim()) return;
    setRunning(true);
    setRunError("");
    setResult(null);
    try {
      const res = await mcp.callTool("execute_query", {
        sql: editorSql,
        _username: user?.username || "unknown",
        _role: user?.role || "unknown",
      });
      const data = JSON.parse(res.content[0].text);
      setResult(data);
      // Update run count if this is a saved query
      if (activeQueryId) {
        await mcp.callTool("execute_query", {
          sql: `UPDATE saved_queries SET run_count = run_count + 1, last_run_at = CURRENT_TIMESTAMP WHERE id = ${activeQueryId}`,
        });
        await loadSavedQueries();
      }
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function saveQuery() {
    if (!editorSql.trim() || !editorName.trim()) return;
    setSaving(true);
    try {
      await mcp.callTool("execute_query", {
        sql: `INSERT INTO saved_queries (name, description, sql, created_by, is_pinned, is_shared, tags)
              VALUES ('${editorName.replace(/'/g, "''")}', '${editorDesc.replace(/'/g, "''")}',
              '${editorSql.replace(/'/g, "''")}', '${user?.username}',
              ${savePin ? 1 : 0}, ${saveShare ? 1 : 0}, '${editorTags.replace(/'/g, "''")}')`,
      });
      await loadSavedQueries();
      setShowSaveModal(false);
      setSaveSuccess("Query saved!");
      setTimeout(() => setSaveSuccess(""), 3000);
    } catch (e: unknown) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function togglePin(q: SavedQuery) {
    await mcp.callTool("execute_query", {
      sql: `UPDATE saved_queries SET is_pinned = ${q.is_pinned ? 0 : 1} WHERE id = ${q.id}`,
    });
    await loadSavedQueries();
  }

  async function toggleShare(q: SavedQuery) {
    await mcp.callTool("execute_query", {
      sql: `UPDATE saved_queries SET is_shared = ${q.is_shared ? 0 : 1} WHERE id = ${q.id}`,
    });
    await loadSavedQueries();
  }

  async function deleteQuery(id: number) {
    await mcp.callTool("execute_query", {
      sql: `DELETE FROM saved_queries WHERE id = ${id}`,
    });
    await loadSavedQueries();
    if (activeQueryId === id) {
      setActiveQueryId(null);
      setEditorSql("");
      setEditorName("");
    }
  }

  function loadIntoEditor(sql: string, name = "", id: number | null = null) {
    setEditorSql(sql);
    setEditorName(name);
    setActiveQueryId(id);
    setResult(null);
    setRunError("");
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      runQuery();
    }
  }

  // Filter helpers
  const filteredPinned    = pinnedQueries.filter((q) => q.name.toLowerCase().includes(search.toLowerCase()) || q.sql.toLowerCase().includes(search.toLowerCase()));
  const filteredShared    = sharedQueries.filter((q) => q.name.toLowerCase().includes(search.toLowerCase()) || q.sql.toLowerCase().includes(search.toLowerCase()));
  const filteredHistory   = history.filter((h) => (h.details || "").toLowerCase().includes(search.toLowerCase()));
  const filteredTemplates = templates.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.category.toLowerCase().includes(search.toLowerCase()));

  const categories = Array.from(new Set(templates.map((t) => t.category)));

  return (
    <div style={s.root}>
      {/* Left sidebar */}
      <div style={s.sidebar}>
        <div style={s.sidebarHeader}>
          <div style={s.sidebarTitle}>Dashboard</div>
          <input
            style={s.sidebarSearch}
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {SECTION_CONFIG.map((sec) => (
          <button
            key={sec.id}
            onClick={() => setSection(sec.id)}
            style={{
              ...s.sectionBtn,
              background: section === sec.id ? "rgba(232,184,75,0.1)" : "transparent",
              borderLeft: `3px solid ${section === sec.id ? "var(--accent)" : "transparent"}`,
              color: section === sec.id ? "var(--accent)" : "var(--text-secondary)",
            }}
          >
            <span style={s.sectionIcon}>{sec.icon}</span>
            <div>
              <div style={s.sectionLabel}>{sec.label}</div>
              <div style={s.sectionDesc}>{sec.desc}</div>
            </div>
            <span style={s.sectionCount}>
              {sec.id === "pinned"    ? filteredPinned.length
               : sec.id === "shared"   ? filteredShared.length
               : sec.id === "history"  ? filteredHistory.length
               : filteredTemplates.length}
            </span>
          </button>
        ))}

        <div style={s.sidebarDivider} />

        {/* My saved queries */}
        <div style={s.myQueriesTitle}>My Saved Queries</div>
        {myQueries.map((q) => (
          <button
            key={q.id}
            onClick={() => loadIntoEditor(q.sql, q.name, q.id)}
            style={{
              ...s.myQueryBtn,
              background: activeQueryId === q.id ? "rgba(232,184,75,0.08)" : "transparent",
              color: activeQueryId === q.id ? "var(--accent)" : "var(--text-secondary)",
            }}
          >
            <span style={{ flexShrink: 0 }}>{q.is_pinned ? "📌" : "📄"}</span>
            <span style={s.myQueryName}>{q.name}</span>
          </button>
        ))}
      </div>

      {/* Main content */}
      <div style={s.main}>
        {/* Top: query list */}
        <div style={s.listPanel}>

          {/* Pinned */}
          {section === "pinned" && (
            <>
              <div style={s.listHeader}>
                <span style={s.listTitle}>📌 Pinned Queries</span>
                <span style={s.listSub}>Click any query to load it in the editor</span>
              </div>
              {filteredPinned.length === 0 && (
                <div style={s.empty}>No pinned queries yet — save a query and pin it for quick access</div>
              )}
              <div style={s.queryGrid}>
                {filteredPinned.map((q) => (
                  <QueryCard key={q.id} q={q} active={activeQueryId === q.id}
                    onLoad={() => loadIntoEditor(q.sql, q.name, q.id)}
                    onPin={() => togglePin(q)}
                    onShare={() => toggleShare(q)}
                    onDelete={() => deleteQuery(q.id)}
                    canEdit={isAdmin || q.created_by === user?.username}
                  />
                ))}
              </div>
            </>
          )}

          {/* History */}
          {section === "history" && (
            <>
              <div style={s.listHeader}>
                <span style={s.listTitle}>🕐 Query History</span>
                <span style={s.listSub}>{isAdmin ? "All users" : "Your queries"} — click to load</span>
              </div>
              <div style={s.historyList}>
                {filteredHistory.map((h) => (
                  <div key={h.id} style={s.historyRow} onClick={() => loadIntoEditor(h.details || "")}>
                    <div style={s.historyMeta}>
                      <span style={s.historyTime}>{new Date(h.timestamp).toLocaleString()}</span>
                      {isAdmin && <span style={s.historyUser}>{h.username}</span>}
                      <span style={{ color: "var(--green)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{h.duration_ms}ms</span>
                      <span style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "var(--font-mono)" }}>{h.row_count} rows</span>
                    </div>
                    <div style={s.historySql}>{(h.details || "").slice(0, 120)}{(h.details || "").length > 120 ? "…" : ""}</div>
                  </div>
                ))}
                {filteredHistory.length === 0 && <div style={s.empty}>No query history yet</div>}
              </div>
            </>
          )}

          {/* Shared */}
          {section === "shared" && (
            <>
              <div style={s.listHeader}>
                <span style={s.listTitle}>📚 Shared Library</span>
                <span style={s.listSub}>Queries shared by the team</span>
              </div>
              {filteredShared.length === 0 && (
                <div style={s.empty}>No shared queries yet — save a query and toggle Share to add it here</div>
              )}
              <div style={s.queryGrid}>
                {filteredShared.map((q) => (
                  <QueryCard key={q.id} q={q} active={activeQueryId === q.id}
                    onLoad={() => loadIntoEditor(q.sql, q.name, q.id)}
                    onPin={() => togglePin(q)}
                    onShare={() => toggleShare(q)}
                    onDelete={() => deleteQuery(q.id)}
                    canEdit={isAdmin || q.created_by === user?.username}
                  />
                ))}
              </div>
            </>
          )}

          {/* Templates */}
          {section === "templates" && (
            <>
              <div style={s.listHeader}>
                <span style={s.listTitle}>📋 Query Templates</span>
                <span style={s.listSub}>Click to load — replace {"{placeholders}"} before running</span>
              </div>
              {categories.map((cat) => (
                <div key={cat} style={{ marginBottom: 20 }}>
                  <div style={{
                    ...s.catLabel,
                    color: CATEGORY_COLORS[cat] || "var(--text-muted)",
                    borderBottom: `1px solid ${CATEGORY_COLORS[cat] || "var(--border)"}44`,
                  }}>
                    {cat}
                  </div>
                  <div style={s.queryGrid}>
                    {filteredTemplates.filter((t) => t.category === cat).map((t) => (
                      <div
                        key={t.id}
                        style={{
                          ...s.templateCard,
                          borderLeft: `3px solid ${CATEGORY_COLORS[cat] || "var(--border-bright)"}`,
                        }}
                        onClick={() => loadIntoEditor(t.sql, t.name)}
                      >
                        <div style={s.templateName}>{t.name}</div>
                        <div style={s.templateDesc}>{t.description}</div>
                        <div style={s.templateSql}>{t.sql.slice(0, 80)}…</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Bottom: editor + results */}
        <div style={s.editorPanel}>
          <div style={s.editorHeader}>
            <div style={s.editorTitle}>
              {activeQueryId ? (
                <span style={{ color: "var(--accent)" }}>📌 {editorName}</span>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>Query Editor</span>
              )}
            </div>
            <div style={s.editorActions}>
              {saveSuccess && <span style={s.saveSuccess}>{saveSuccess}</span>}
              {editorSql && (
                <>
                  <button onClick={() => setShowSaveModal(true)} style={s.saveBtn}>💾 Save</button>
                  <button
                    onClick={runQuery}
                    disabled={running}
                    style={{ ...s.runBtn, opacity: running ? 0.6 : 1 }}
                  >
                    {running ? "⟳ Running…" : "▶ Run (⌘+Enter)"}
                  </button>
                </>
              )}
              {editorSql && (
                <button onClick={() => { setEditorSql(""); setEditorName(""); setActiveQueryId(null); setResult(null); }} style={s.clearBtn}>✕</button>
              )}
            </div>
          </div>

          <textarea
            ref={textareaRef}
            style={s.editor}
            value={editorSql}
            onChange={(e) => setEditorSql(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Click a query or template to load it here, or type your own SQL…"
            spellCheck={false}
          />

          {runError && <div style={s.runError}>{runError}</div>}

          {result && (
            <div style={s.results}>
              <div style={s.resultsHeader}>
                <span style={s.resultsMeta}>
                  {result.rowCount} rows · {result.executionMs}ms
                </span>
                <button onClick={() => {
                  const csv = [
                    result.columns.map((c) => c.name).join(","),
                    ...result.rows.map((r) => result.columns.map((c) => JSON.stringify(r[c.name] ?? "")).join(","))
                  ].join("\n");
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                  a.download = "query_result.csv";
                  a.click();
                }} style={s.csvBtn}>↓ CSV</button>
              </div>
              <div style={s.tableWrap}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th key={c.name} style={s.th}>{c.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "var(--bg-elevated)" }}>
                        {result.columns.map((c) => (
                          <td key={c.name} style={s.td}>
                            {row[c.name] === null ? <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>null</span>
                             : String(row[c.name])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Save modal */}
      {showSaveModal && (
        <div style={s.modalOverlay} onClick={() => setShowSaveModal(false)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <div style={s.modalTitle}>💾 Save Query</div>

            <div style={s.modalField}>
              <label style={s.modalLabel}>Name *</label>
              <input style={s.modalInput} placeholder="e.g. Daily Order Count" value={editorName} onChange={(e) => setEditorName(e.target.value)} />
            </div>

            <div style={s.modalField}>
              <label style={s.modalLabel}>Description</label>
              <input style={s.modalInput} placeholder="What does this query do?" value={editorDesc} onChange={(e) => setEditorDesc(e.target.value)} />
            </div>

            <div style={s.modalField}>
              <label style={s.modalLabel}>Tags</label>
              <input style={s.modalInput} placeholder="e.g. orders, daily, monitoring" value={editorTags} onChange={(e) => setEditorTags(e.target.value)} />
            </div>

            <div style={s.modalToggles}>
              <label style={s.toggleLabel}>
                <input type="checkbox" checked={savePin} onChange={(e) => setSavePin(e.target.checked)} />
                <span>📌 Pin to dashboard</span>
              </label>
              <label style={s.toggleLabel}>
                <input type="checkbox" checked={saveShare} onChange={(e) => setSaveShare(e.target.checked)} />
                <span>📚 Share with team</span>
              </label>
            </div>

            <div style={s.modalActions}>
              <button onClick={() => setShowSaveModal(false)} style={s.cancelBtn}>Cancel</button>
              <button
                onClick={saveQuery}
                disabled={saving || !editorName.trim()}
                style={{ ...s.confirmBtn, opacity: saving || !editorName.trim() ? 0.5 : 1 }}
              >
                {saving ? "Saving…" : "Save Query"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Query card sub-component
function QueryCard({ q, active, onLoad, onPin, onShare, onDelete, canEdit }: {
  q: SavedQuery;
  active: boolean;
  onLoad: () => void;
  onPin: () => void;
  onShare: () => void;
  onDelete: () => void;
  canEdit: boolean;
}) {
  const tags = q.tags ? q.tags.split(",").filter(Boolean) : [];
  return (
    <div style={{
      ...qc.card,
      borderTop: `1px solid ${active ? "var(--accent)" : "var(--border-bright)"}`,
      borderRight: `1px solid ${active ? "var(--accent)" : "var(--border-bright)"}`,
      borderBottom: `1px solid ${active ? "var(--accent)" : "var(--border-bright)"}`,
      borderLeft: `3px solid ${active ? "var(--accent)" : "var(--border-bright)"}`,
      background: active ? "rgba(232,184,75,0.05)" : "var(--bg-elevated)",
    }}>
      <div style={qc.header} onClick={onLoad}>
        <span style={qc.name}>{q.name}</span>
        <span style={qc.author}>{q.created_by}</span>
      </div>
      {q.description && <div style={qc.desc} onClick={onLoad}>{q.description}</div>}
      <div style={qc.sql} onClick={onLoad}>{q.sql.slice(0, 100)}{q.sql.length > 100 ? "…" : ""}</div>
      {tags.length > 0 && (
        <div style={qc.tags}>
          {tags.map((t) => <span key={t} style={qc.tag}>{t.trim()}</span>)}
        </div>
      )}
      <div style={qc.footer}>
        <span style={qc.meta}>
          {q.run_count > 0 ? `▶ ${q.run_count} runs` : "Never run"}
          {q.last_run_at ? ` · ${new Date(q.last_run_at).toLocaleDateString()}` : ""}
        </span>
        {canEdit && (
          <div style={qc.actions}>
            <button onClick={onPin} style={qc.iconBtn} title={q.is_pinned ? "Unpin" : "Pin"}>
              {q.is_pinned ? "📌" : "📍"}
            </button>
            <button onClick={onShare} style={qc.iconBtn} title={q.is_shared ? "Unshare" : "Share with team"}>
              {q.is_shared ? "📚" : "🔒"}
            </button>
            <button onClick={onDelete} style={{ ...qc.iconBtn, color: "var(--red)" }} title="Delete">✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:           { display: "flex", height: "100%", overflow: "hidden" },
  sidebar:        { width: 240, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg-elevated)", overflow: "hidden" },
  sidebarHeader:  { padding: "16px 12px 8px", borderBottom: "1px solid var(--border)" },
  sidebarTitle:   { fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "1px", fontFamily: "var(--font-mono)", marginBottom: 8 },
  sidebarSearch:  { width: "100%", background: "var(--bg)", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "5px 8px", borderRadius: "var(--radius)", fontSize: 12, outline: "none", boxSizing: "border-box" as const },
  sectionBtn:     { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "none", border: "none", borderLeft: "3px solid transparent", cursor: "pointer", textAlign: "left", width: "100%", transition: "all 0.15s" },
  sectionIcon:    { fontSize: 16, flexShrink: 0 },
  sectionLabel:   { fontSize: 12, fontWeight: 600 },
  sectionDesc:    { fontSize: 10, color: "var(--text-muted)", marginTop: 1 },
  sectionCount:   { marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", background: "var(--bg)", padding: "1px 6px", borderRadius: 99, flexShrink: 0 },
  sidebarDivider: { height: 1, background: "var(--border)", margin: "8px 0" },
  myQueriesTitle: { fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "1px", padding: "4px 12px 6px", fontFamily: "var(--font-mono)" },
  myQueryBtn:     { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", background: "none", border: "none", cursor: "pointer", textAlign: "left", width: "100%", fontSize: 12 },
  myQueryName:    { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  main:           { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  listPanel:      { height: 280, borderBottom: "1px solid var(--border)", overflow: "auto", padding: "12px 20px", flexShrink: 0 },
  listHeader:     { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 },
  listTitle:      { fontSize: 14, fontWeight: 600, color: "var(--text-primary)" },
  listSub:        { fontSize: 12, color: "var(--text-muted)" },
  queryGrid:      { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 },
  catLabel:       { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "1px", fontFamily: "var(--font-mono)", padding: "6px 0 8px", marginBottom: 8 },
  templateCard:   { padding: "10px 14px", borderRadius: "var(--radius)", background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", cursor: "pointer", transition: "all 0.15s" },
  templateName:   { fontSize: 12, fontWeight: 600, color: "var(--text-primary)", marginBottom: 3 },
  templateDesc:   { fontSize: 11, color: "var(--text-secondary)", marginBottom: 6 },
  templateSql:    { fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", wordBreak: "break-all" as const },
  historyList:    { display: "flex", flexDirection: "column", gap: 4 },
  historyRow:     { padding: "8px 12px", borderRadius: "var(--radius)", background: "var(--bg-elevated)", border: "1px solid var(--border)", cursor: "pointer", transition: "all 0.15s" },
  historyMeta:    { display: "flex", gap: 12, alignItems: "center", marginBottom: 4 },
  historyTime:    { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  historyUser:    { fontSize: 11, fontWeight: 600, color: "var(--accent)", fontFamily: "var(--font-mono)" },
  historySql:     { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)", wordBreak: "break-all" as const },
  empty:          { color: "var(--text-muted)", fontSize: 13, fontStyle: "italic", padding: "20px 0" },
  editorPanel:    { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  editorHeader:   { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0 },
  editorTitle:    { fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)" },
  editorActions:  { display: "flex", gap: 8, alignItems: "center" },
  saveSuccess:    { fontSize: 12, color: "var(--green)", fontFamily: "var(--font-mono)" },
  saveBtn:        { background: "none", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 12px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
  runBtn:         { background: "var(--accent)", border: "none", color: "#000", padding: "5px 14px", borderRadius: "var(--radius)", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-mono)" },
  clearBtn:       { background: "none", border: "none", color: "var(--text-muted)", fontSize: 14, cursor: "pointer", padding: "4px 6px" },
  editor:         { flex: "0 0 120px", background: "var(--bg)", borderTop: "none", borderRight: "none", borderBottom: "1px solid var(--border)", borderLeft: "none", color: "var(--text-primary)", padding: "12px 20px", fontSize: 13, fontFamily: "var(--font-mono)", outline: "none", resize: "none" as const, lineHeight: 1.6 },
  runError:       { padding: "8px 20px", background: "var(--red-dim)", color: "var(--red)", fontSize: 12, fontFamily: "var(--font-mono)", flexShrink: 0 },
  results:        { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  resultsHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 20px", borderBottom: "1px solid var(--border)", flexShrink: 0 },
  resultsMeta:    { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" },
  csvBtn:         { background: "none", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "3px 10px", borderRadius: "var(--radius)", fontSize: 11, cursor: "pointer", fontFamily: "var(--font-mono)" },
  tableWrap:      { flex: 1, overflow: "auto" },
  table:          { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 },
  th:             { padding: "6px 12px", textAlign: "left" as const, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.6px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" as const, position: "sticky" as const, top: 0 },
  td:             { padding: "6px 12px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" as const },
  modalOverlay:   { position: "fixed" as const, inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  modal:          { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", borderRadius: "var(--radius)", padding: 24, width: 440, display: "flex", flexDirection: "column", gap: 16 },
  modalTitle:     { fontSize: 15, fontWeight: 700, color: "var(--text-primary)" },
  modalField:     { display: "flex", flexDirection: "column", gap: 6 },
  modalLabel:     { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  modalInput:     { background: "var(--bg)", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "8px 12px", borderRadius: "var(--radius)", fontSize: 13, outline: "none" },
  modalToggles:   { display: "flex", gap: 20 },
  toggleLabel:    { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-secondary)", cursor: "pointer" },
  modalActions:   { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  cancelBtn:      { background: "none", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "7px 16px", borderRadius: "var(--radius)", fontSize: 13, cursor: "pointer" },
  confirmBtn:     { background: "var(--accent)", border: "none", color: "#000", padding: "7px 16px", borderRadius: "var(--radius)", fontSize: 13, fontWeight: 700, cursor: "pointer" },
};

const qc: Record<string, React.CSSProperties> = {
  card:    { borderRadius: "var(--radius)", padding: "10px 12px", cursor: "pointer", transition: "all 0.15s", display: "flex", flexDirection: "column", gap: 4 },
  header:  { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  name:    { fontSize: 12, fontWeight: 600, color: "var(--text-primary)" },
  author:  { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 },
  desc:    { fontSize: 11, color: "var(--text-secondary)" },
  sql:     { fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)", wordBreak: "break-all" as const },
  tags:    { display: "flex", flexWrap: "wrap" as const, gap: 4, marginTop: 2 },
  tag:     { fontSize: 9, color: "var(--accent)", background: "rgba(232,184,75,0.1)", padding: "1px 6px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  footer:  { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  meta:    { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  actions: { display: "flex", gap: 4 },
  iconBtn: { background: "none", border: "none", cursor: "pointer", fontSize: 12, padding: "2px 4px", opacity: 0.7 },
};
