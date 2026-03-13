"use client";
import { useState, useEffect } from "react";
import * as mcp from "@/lib/mcpClient";
import { useAuth } from "@/lib/authContext";

interface AuditEntry {
  id: number;
  timestamp: string;
  username: string;
  role: string;
  action_type: string;
  details: string;
  model: string;
  context_mode: string;
  duration_ms: number;
  row_count: number;
  status: string;
  error_msg: string;
}

const ACTION_COLORS: Record<string, string> = {
  query:    "#58a6ff",
  ai_chat:  "#bc8cff",
  login:    "#3fb950",
  logout:   "#e8b84b",
  tool_call:"#f78166",
};

export default function AuditLog() {
  const { user } = useAuth();
  const isAdmin = user?.role === "Admin";

  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterUser, setFilterUser] = useState("all");
  const [filterAction, setFilterAction] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const pageSize = 50;

  useEffect(() => { loadLogs(); }, []);

  async function loadLogs() {
    setLoading(true);
    setError("");
    try {
      const sql = isAdmin
        ? `SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 500`
        : `SELECT * FROM audit_logs WHERE username = '${user?.username}' ORDER BY timestamp DESC LIMIT 500`;

      const res = await mcp.callTool("execute_query", { sql });
      const data = JSON.parse(res.content[0].text);
      setLogs(data.rows || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const users = Array.from(new Set(logs.map((l) => l.username))).sort();
  const actions = Array.from(new Set(logs.map((l) => l.action_type))).sort();

  const filtered = logs.filter((l) => {
    if (filterUser !== "all" && l.username !== filterUser) return false;
    if (filterAction !== "all" && l.action_type !== filterAction) return false;
    if (filterStatus !== "all" && l.status !== filterStatus) return false;
    if (search && !l.details?.toLowerCase().includes(search.toLowerCase()) &&
        !l.username?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(filtered.length / pageSize);

  // Stats
  const totalQueries = logs.filter((l) => l.action_type === "query").length;
  const totalChats = logs.filter((l) => l.action_type === "ai_chat").length;
  const totalErrors = logs.filter((l) => l.status === "error").length;
  const avgDuration = logs.filter((l) => l.duration_ms).reduce((a, b) => a + b.duration_ms, 0) / (logs.filter((l) => l.duration_ms).length || 1);

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>📋 Audit Log</h2>
          <p style={s.sub}>
            {isAdmin ? "Full activity log for all users" : `Your activity log`}
          </p>
        </div>
        <button onClick={loadLogs} style={s.refreshBtn}>↻ Refresh</button>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        {[
          { label: "Total Events",   value: logs.length,               color: "var(--text-primary)" },
          { label: "SQL Queries",    value: totalQueries,              color: "#58a6ff" },
          { label: "AI Chats",       value: totalChats,                color: "#bc8cff" },
          { label: "Errors",         value: totalErrors,               color: "var(--red)" },
          { label: "Avg Query Time", value: `${Math.round(avgDuration)}ms`, color: "var(--amber)" },
        ].map((stat) => (
          <div key={stat.label} style={s.statCard}>
            <div style={{ ...s.statValue, color: stat.color }}>{stat.value}</div>
            <div style={s.statLabel}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={s.filters}>
        <input
          style={s.search}
          placeholder="Search queries or users…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
        />
        {isAdmin && (
          <select style={s.select} value={filterUser} onChange={(e) => { setFilterUser(e.target.value); setPage(0); }}>
            <option value="all">All Users</option>
            {users.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        )}
        <select style={s.select} value={filterAction} onChange={(e) => { setFilterAction(e.target.value); setPage(0); }}>
          <option value="all">All Actions</option>
          {actions.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select style={s.select} value={filterStatus} onChange={(e) => { setFilterStatus(e.target.value); setPage(0); }}>
          <option value="all">All Status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
        <span style={s.resultCount}>{filtered.length} events</span>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {loading && <div style={s.loading}>Loading audit logs…</div>}

      {/* Table */}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              {["Time", "User", "Role", "Action", "Details", "Model", "Duration", "Rows", "Status"].map((h) => (
                <th key={h} style={s.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginated.map((log) => (
              <tr key={log.id} style={{ background: log.status === "error" ? "var(--red-dim)" : "transparent" }}>
                <td style={s.td}>
                  <span style={s.timestamp}>
                    {new Date(log.timestamp).toLocaleDateString()} {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </td>
                <td style={s.td}>
                  <span style={s.username}>{log.username}</span>
                </td>
                <td style={s.td}>
                  <span style={s.roleBadge}>{log.role}</span>
                </td>
                <td style={s.td}>
                  <span style={{
                    ...s.actionBadge,
                    background: `${ACTION_COLORS[log.action_type] || "var(--text-muted)"}22`,
                    color: ACTION_COLORS[log.action_type] || "var(--text-muted)",
                    borderColor: `${ACTION_COLORS[log.action_type] || "var(--text-muted)"}55`,
                  }}>
                    {log.action_type}
                  </span>
                </td>
                <td style={{ ...s.td, maxWidth: 300 }}>
                  {log.details ? (
                    <span style={s.details} title={log.details}>
                      {log.details.slice(0, 80)}{log.details.length > 80 ? "…" : ""}
                    </span>
                  ) : <span style={s.empty}>—</span>}
                </td>
                <td style={s.td}>
                  {log.model ? <span style={s.model}>{log.model}</span> : <span style={s.empty}>—</span>}
                </td>
                <td style={s.td}>
                  {log.duration_ms ? (
                    <span style={{ color: log.duration_ms > 1000 ? "var(--red)" : "var(--green)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                      {log.duration_ms}ms
                    </span>
                  ) : <span style={s.empty}>—</span>}
                </td>
                <td style={s.td}>
                  {log.row_count != null ? (
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-secondary)" }}>
                      {log.row_count}
                    </span>
                  ) : <span style={s.empty}>—</span>}
                </td>
                <td style={s.td}>
                  <span style={{
                    ...s.statusBadge,
                    background: log.status === "error" ? "var(--red-dim)" : "var(--green-dim)",
                    color: log.status === "error" ? "var(--red)" : "var(--green)",
                    borderColor: log.status === "error" ? "var(--red)" : "var(--green)",
                  }}>
                    {log.status === "error" ? "✗ error" : "✓ ok"}
                  </span>
                  {log.error_msg && (
                    <div style={s.errorMsg} title={log.error_msg}>
                      {log.error_msg.slice(0, 60)}…
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {paginated.length === 0 && !loading && (
          <div style={s.emptyState}>No audit logs found</div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={s.pagination}>
          <button style={s.pageBtn} disabled={page === 0} onClick={() => setPage(0)}>«</button>
          <button style={s.pageBtn} disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span style={s.pageInfo}>Page {page + 1} of {totalPages}</span>
          <button style={s.pageBtn} disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>›</button>
          <button style={s.pageBtn} disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>»</button>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:        { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header:      { padding: "20px 28px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 },
  title:       { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub:         { fontSize: 13, color: "var(--text-secondary)" },
  refreshBtn:  { background: "none", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "6px 14px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  statsRow:    { display: "flex", gap: 1, borderBottom: "1px solid var(--border)", flexShrink: 0 },
  statCard:    { flex: 1, padding: "14px 20px", borderRight: "1px solid var(--border)" },
  statValue:   { fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono)", marginBottom: 2 },
  statLabel:   { fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.6px" },
  filters:     { display: "flex", gap: 8, padding: "12px 28px", borderBottom: "1px solid var(--border)", alignItems: "center", flexShrink: 0, flexWrap: "wrap" as const },
  search:      { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "6px 10px", borderRadius: "var(--radius)", fontSize: 12, outline: "none", width: 220 },
  select:      { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "6px 8px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  resultCount: { fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" },
  error:       { margin: "10px 28px", padding: "10px 14px", background: "var(--red-dim)", color: "var(--red)", borderRadius: "var(--radius)", border: "1px solid var(--red)", fontSize: 12 },
  loading:     { padding: "20px 28px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 },
  tableWrap:   { flex: 1, overflow: "auto" },
  table:       { width: "100%", borderCollapse: "collapse" as const, fontSize: 12 },
  th:          { padding: "8px 12px", textAlign: "left" as const, fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.6px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" as const, position: "sticky" as const, top: 0 },
  td:          { padding: "8px 12px", borderBottom: "1px solid var(--border)", verticalAlign: "top" as const },
  timestamp:   { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" as const },
  username:    { fontSize: 12, fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-mono)" },
  roleBadge:   { fontSize: 10, color: "var(--text-muted)", background: "var(--bg-elevated)", border: "1px solid var(--border)", padding: "1px 6px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  actionBadge: { fontSize: 10, fontWeight: 600, border: "1px solid", padding: "2px 7px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  details:     { fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono)", wordBreak: "break-all" as const },
  model:       { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
  statusBadge: { fontSize: 10, fontWeight: 600, border: "1px solid", padding: "2px 7px", borderRadius: 99, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" as const },
  errorMsg:    { fontSize: 10, color: "var(--red)", marginTop: 3, fontFamily: "var(--font-mono)" },
  empty:       { color: "var(--text-muted)", fontSize: 11 },
  emptyState:  { padding: "40px", textAlign: "center" as const, color: "var(--text-muted)", fontSize: 13 },
  pagination:  { display: "flex", alignItems: "center", gap: 8, padding: "12px 28px", borderTop: "1px solid var(--border)", flexShrink: 0, justifyContent: "center" },
  pageBtn:     { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "4px 10px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  pageInfo:    { fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
};