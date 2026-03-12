"use client";
import { useState, useEffect } from "react";
import * as mcp from "@/lib/mcpClient";

interface SchemaInfo { schemas?: string[]; tables?: Array<{ name: string; type: string }> }
interface TableInfo { schema: string; tables: Array<{ table_name: string; table_type: string; column_count: number }> }
interface TableDetail {
  schema: string; table: string; rowCountEstimate?: number; rowCount?: number;
  columns: Array<{ column_name?: string; name?: string; data_type?: string; type?: string; is_nullable?: string; notnull?: number; column_default?: string; dflt_value?: string }>;
  indexes: Array<{ index_name?: string; name?: string; is_primary?: boolean; is_unique?: boolean; unique?: number; columns?: string[] }>;
  foreignKeys: Array<{ column_name?: string; from?: string; foreign_table?: string; table?: string; foreign_column?: string; to?: string }>;
}

export default function SchemaExplorer() {
  const [schemas, setSchemas] = useState<string[]>([]);
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null);
  const [tables, setTables] = useState<TableInfo | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableDetail, setTableDetail] = useState<TableDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    mcp.readResource("schemas://list")
      .then((r) => {
        const data = JSON.parse(r.contents[0].text);
        // Support both PostgreSQL (schemas) and SQLite (tables)
        if (data.schemas) {
          setSchemas(data.schemas);
          if (data.schemas.length > 0) setSelectedSchema(data.schemas[0]);
        } else if (data.tables) {
          setSchemas(["main"]);
          setSelectedSchema("main");
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedSchema) return;
    setTables(null); setSelectedTable(null); setTableDetail(null);
    mcp.readResource(`schema://${selectedSchema}`)
      .then((r) => {
        const data = JSON.parse(r.contents[0].text);
        // Normalize SQLite format {name, type} to expected format {table_name, table_type, column_count}
        if (data.tables && data.tables[0] && data.tables[0].name) {
          setTables({
            schema: "main",
            tables: data.tables.map((t: { name: string; type: string }) => ({
              table_name: t.name,
              table_type: t.type === "view" ? "VIEW" : "BASE TABLE",
              column_count: "?",
            })),
          });
        } else {
          setTables(data);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [selectedSchema]);

  useEffect(() => {
    if (!selectedSchema || !selectedTable) return;
    setTableDetail(null);
    mcp.readResource(`table://${selectedSchema}/${selectedTable}`)
      .then((r) => setTableDetail(JSON.parse(r.contents[0].text)))
      .catch((e: Error) => setError(e.message));
  }, [selectedSchema, selectedTable]);

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <h2 style={s.title}>⬡ Schema Explorer</h2>
        <p style={s.sub}>Browse table schemas, columns, indexes, and foreign keys</p>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {loading && <div style={s.loading}>Loading schemas…</div>}

      <div style={s.body}>
        {/* Schema selector */}
        <div style={s.schemaBar}>
          {schemas.map((sc) => (
            <button
              key={sc}
              onClick={() => setSelectedSchema(sc)}
              style={{ ...s.schemaChip, ...(selectedSchema === sc ? s.schemaChipActive : {}) }}
            >{sc}</button>
          ))}
        </div>

        <div style={s.splitPane}>
          {/* Table list */}
          <div style={s.tableList}>
            <div style={s.listHeader}>
              Tables
              <span style={s.badge}>{tables?.tables.length ?? 0}</span>
            </div>
            {tables?.tables.map((t) => (
              <button
                key={t.table_name}
                onClick={() => setSelectedTable(t.table_name)}
                style={{ ...s.tableItem, ...(selectedTable === t.table_name ? s.tableItemActive : {}) }}
              >
                <span style={s.tableIcon}>{t.table_type === "VIEW" ? "◈" : "▦"}</span>
                <span style={s.tableName}>{t.table_name}</span>
                <span style={s.colCount}>{t.column_count}c</span>
              </button>
            ))}
          </div>

          {/* Table detail */}
          <div style={s.detail}>
            {!selectedTable && (
              <div style={s.placeholder}>
                <div style={s.placeholderIcon}>▦</div>
                <p>Select a table to inspect its schema</p>
              </div>
            )}
            {selectedTable && !tableDetail && (
              <div style={s.loading}>Loading table details…</div>
            )}
            {tableDetail && (
              <>
                <div style={s.detailHeader}>
                  <div>
                    <h3 style={s.detailTitle}>{tableDetail.schema}.<strong>{tableDetail.table}</strong></h3>
                    <p style={s.detailSub}>~{(tableDetail.rowCountEstimate ?? tableDetail.rowCount ?? 0).toLocaleString()} rows estimated</p>
                  </div>
                </div>

                {/* Columns */}
                <SectionLabel>Columns ({tableDetail.columns.length})</SectionLabel>
                <div style={s.tableWrapper}>
                  <table style={s.table}>
                    <thead>
                      <tr>
                        {["#", "Column", "Type", "Nullable", "Default"].map((h) => (
                          <th key={h} style={s.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {tableDetail.columns.map((col, i) => {
  const colName = col.column_name ?? col.name ?? "—";
  const colType = col.data_type ?? col.type ?? "—";
  const colDefault = col.column_default ?? col.dflt_value ?? "—";
  const isNullable = col.is_nullable === "YES" || col.notnull === 0;
  return (
    <tr key={colName} style={i % 2 === 0 ? {} : { background: "var(--bg-elevated)" }}>
      <td style={{ ...s.td, color: "var(--text-muted)" }}>{i + 1}</td>
      <td style={{ ...s.td, fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{colName}</td>
      <td style={{ ...s.td, fontFamily: "var(--font-mono)", color: "var(--accent)" }}>{colType}</td>
      <td style={{ ...s.td, color: isNullable ? "var(--amber)" : "var(--green)" }}>
        {isNullable ? "nullable" : "not null"}
      </td>
      <td style={{ ...s.td, color: "var(--text-secondary)", fontSize: 12 }}>{colDefault}</td>
    </tr>
  );
})}
                    </tbody>
                  </table>
                </div>

                {/* Indexes */}
                {tableDetail.indexes.length > 0 && (
                  <>
                    <SectionLabel>Indexes ({tableDetail.indexes.length})</SectionLabel>
                    <div style={s.tableWrapper}>
                      <table style={s.table}>
                        <thead><tr>{["Name", "Primary", "Unique", "Columns"].map((h) => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                        <tbody>
                          {tableDetail.indexes.map((idx, i) => {
  const idxName = idx.index_name ?? idx.name ?? `index_${i}`;
  const isPrimary = idx.is_primary ?? false;
  const isUnique = idx.is_unique ?? idx.unique === 1;
  return (
    <tr key={idxName}>
      <td style={{ ...s.td, fontFamily: "var(--font-mono)" }}>{idxName}</td>
      <td style={{ ...s.td, color: isPrimary ? "var(--green)" : "var(--text-muted)" }}>{isPrimary ? "✓" : "—"}</td>
      <td style={{ ...s.td, color: isUnique ? "var(--accent)" : "var(--text-muted)" }}>{isUnique ? "✓" : "—"}</td>
      <td style={{ ...s.td, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{idx.columns?.join(", ") ?? "—"}</td>
    </tr>
  );
})}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {/* Foreign Keys */}
                {tableDetail.foreignKeys.length > 0 && (
                  <>
                    <SectionLabel>Foreign Keys ({tableDetail.foreignKeys.length})</SectionLabel>
                    <div style={s.tableWrapper}>
                      <table style={s.table}>
                        <thead><tr>{["Column", "→ Table", "→ Column"].map((h) => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                        <tbody>
                          {tableDetail.foreignKeys.map((fk, i) => (
  <tr key={i}>
    <td style={{ ...s.td, fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{fk.column_name ?? fk.from ?? "—"}</td>
    <td style={{ ...s.td, fontFamily: "var(--font-mono)", color: "var(--purple)" }}>{fk.foreign_table ?? fk.table ?? "—"}</td>
    <td style={{ ...s.td, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{fk.foreign_column ?? fk.to ?? "—"}</td>
  </tr>
))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const,
      letterSpacing: "1px", color: "var(--text-muted)", padding: "16px 0 8px",
    }}>
      {children}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: { padding: "24px 28px 16px", borderBottom: "1px solid var(--border)" },
  title: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub: { color: "var(--text-secondary)", fontSize: 13 },
  error: { margin: "12px 28px", padding: "10px 14px", background: "var(--red-dim)", color: "var(--red)", borderRadius: "var(--radius)", border: "1px solid var(--red)", fontSize: 13 },
  loading: { padding: "24px 28px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 },
  body: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", padding: "16px 28px" },
  schemaBar: { display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" as const },
  schemaChip: { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "4px 12px", borderRadius: 99, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
  schemaChipActive: { background: "var(--accent-dim)", border: "1px solid var(--accent-border)", color: "var(--accent)" },
  splitPane: { display: "flex", gap: 16, flex: 1, overflow: "hidden" },
  tableList: { width: 200, minWidth: 200, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "auto" },
  listHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, fontWeight: 600, letterSpacing: "0.8px", textTransform: "uppercase" as const, color: "var(--text-muted)" },
  badge: { background: "var(--bg-elevated)", color: "var(--text-secondary)", borderRadius: 99, padding: "1px 7px", fontSize: 11 },
  tableItem: { display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", cursor: "pointer", padding: "7px 12px", color: "var(--text-secondary)", fontSize: 12, textAlign: "left" as const, transition: "all 0.1s" },
  tableItemActive: { background: "var(--accent-dim)", color: "var(--accent)" },
  tableIcon: { fontSize: 10, flexShrink: 0, color: "var(--text-muted)" },
  tableName: { flex: 1, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  colCount: { fontSize: 10, color: "var(--text-muted)", flexShrink: 0 },
  detail: { flex: 1, overflow: "auto", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "20px 24px" },
  placeholder: { height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", gap: 12 },
  placeholderIcon: { fontSize: 32 },
  detailHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 },
  detailTitle: { fontSize: 15, color: "var(--text-primary)", fontFamily: "var(--font-mono)" },
  detailSub: { fontSize: 12, color: "var(--text-secondary)", marginTop: 4 },
  tableWrapper: { overflowX: "auto" as const, border: "1px solid var(--border)", borderRadius: "var(--radius)" },
  table: { width: "100%", borderCollapse: "collapse" as const, fontSize: 13 },
  th: { padding: "8px 12px", textAlign: "left" as const, fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.5px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" },
  td: { padding: "7px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)", verticalAlign: "middle" as const },
};
