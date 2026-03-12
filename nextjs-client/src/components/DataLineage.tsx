"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import * as mcp from "@/lib/mcpClient";

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ForeignKey {
  from: string;
  table: string;
  to: string;
}

interface TableNode {
  name: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Relationship {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export default function DataLineage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [tables, setTables] = useState<TableNode[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hoveredTable, setHoveredTable] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [impactTables, setImpactTables] = useState<string[]>([]);
  const [dependencyTables, setDependencyTables] = useState<string[]>([]);

  useEffect(() => {
    loadLineage();
  }, []);

  async function loadLineage() {
    setLoading(true);
    setError("");
    try {
      // Get all tables
      const res = await mcp.readResource("schemas://list");
      const data = JSON.parse(res.contents[0].text);
      const tableList = data.tables || [];

      const tableNodes: TableNode[] = [];
      const allRelationships: Relationship[] = [];

      // Get columns and foreign keys for each table
      await Promise.all(
        tableList.map(async (t: { name: string }, idx: number) => {
          try {
            const detail = await mcp.readResource(`table://main/${t.name}`);
            const d = JSON.parse(detail.contents[0].text);

            // Layout in a grid
            const cols = 3;
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const x = 60 + col * 340;
            const y = 60 + row * 300;

            const columns: Column[] = (d.columns || []).map((c: Record<string, unknown>) => ({
              name: String(c.name || c.column_name || ""),
              type: String(c.type || c.data_type || ""),
              notnull: Number(c.notnull ?? (c.is_nullable === "NO" ? 1 : 0)),
              pk: Number(c.pk ?? 0),
            }));

            const foreignKeys: ForeignKey[] = (d.foreignKeys || []).map((fk: Record<string, unknown>) => ({
              from: String(fk.from || fk.column_name || ""),
              table: String(fk.table || fk.foreign_table || ""),
              to: String(fk.to || fk.foreign_column || ""),
            }));

            // Add relationships
            foreignKeys.forEach((fk) => {
              allRelationships.push({
                fromTable: t.name,
                fromColumn: fk.from,
                toTable: fk.table,
                toColumn: fk.to,
              });
            });

            const colHeight = 28;
            const headerHeight = 40;
            const height = headerHeight + columns.length * colHeight + 12;

            tableNodes.push({
              name: t.name,
              columns,
              foreignKeys,
              x, y,
              width: 280,
              height,
            });
          } catch (_) {}
        })
      );

      setTables(tableNodes);
      setRelationships(allRelationships);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Calculate impact when table is selected
  useEffect(() => {
    if (!selectedTable) {
      setImpactTables([]);
      setDependencyTables([]);
      return;
    }

    // Tables that depend ON selected table (will break if selected is removed)
    const impacts = relationships
      .filter((r) => r.toTable === selectedTable)
      .map((r) => r.fromTable)
      .filter((t, i, arr) => arr.indexOf(t) === i);

    // Tables that selected table depends ON
    const dependencies = relationships
      .filter((r) => r.fromTable === selectedTable)
      .map((r) => r.toTable)
      .filter((t, i, arr) => arr.indexOf(t) === i);

    setImpactTables(impacts);
    setDependencyTables(dependencies);
  }, [selectedTable, relationships]);

  // Drag table
  function handleTableMouseDown(e: React.MouseEvent, tableName: string) {
    e.stopPropagation();
    const table = tables.find((t) => t.name === tableName);
    if (!table) return;
    setDragging(tableName);
    setDragOffset({
      x: e.clientX / zoom - table.x,
      y: e.clientY / zoom - table.y,
    });
    setSelectedTable(tableName);
  }

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      setTables((prev) =>
        prev.map((t) =>
          t.name === dragging
            ? { ...t, x: e.clientX / zoom - dragOffset.x, y: e.clientY / zoom - dragOffset.y }
            : t
        )
      );
    } else if (isPanning) {
      panMoved.current = true;
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
    }
  }, [dragging, dragOffset, isPanning, panStart, zoom]);

  function handleMouseUp(e: React.MouseEvent) {
    if (isPanning && !panMoved.current && e.target === canvasRef.current) {
      setSelectedTable(null);
    }
    setDragging(null);
    setIsPanning(false);
  }

  const panMoved = useRef(false);

function handleCanvasMouseDown(e: React.MouseEvent) {
    if (e.target === canvasRef.current) {
      setIsPanning(true);
      panMoved.current = false;
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setZoom((prev) => Math.max(0.3, Math.min(2, prev - e.deltaY * 0.001)));
  }

  // Get relationship color based on selection
  function getRelationshipStyle(rel: Relationship) {
    if (!selectedTable) return { stroke: "var(--border-bright)", opacity: 0.6 };
    if (rel.fromTable === selectedTable || rel.toTable === selectedTable) {
      return { stroke: "var(--accent)", opacity: 1 };
    }
    return { stroke: "var(--border)", opacity: 0.2 };
  }

  // Get table style based on selection
  function getTableStyle(table: TableNode) {
    if (selectedTable === table.name) return { border: "2px solid var(--accent)", shadow: "0 0 20px rgba(88,166,255,0.3)" };
    if (impactTables.includes(table.name)) return { border: "2px solid var(--red)", shadow: "0 0 12px rgba(248,81,73,0.2)" };
    if (dependencyTables.includes(table.name)) return { border: "2px solid var(--green)", shadow: "0 0 12px rgba(63,185,80,0.2)" };
    if (hoveredTable === table.name) return { border: "1px solid var(--accent)", shadow: "0 4px 20px rgba(0,0,0,0.3)" };
    if (selectedTable) return { border: "1px solid var(--border)", shadow: "none", opacity: 0.4 };
    return { border: "1px solid var(--border-bright)", shadow: "0 2px 8px rgba(0,0,0,0.2)" };
  }

  // Calculate relationship line positions
  function getRelLine(rel: Relationship) {
    const from = tables.find((t) => t.name === rel.fromTable);
    const to = tables.find((t) => t.name === rel.toTable);
    if (!from || !to) return null;

    const fromColIdx = from.columns.findIndex((c) => c.name === rel.fromColumn);
    const toColIdx = to.columns.findIndex((c) => c.name === rel.toColumn);

    const fromY = from.y + 40 + fromColIdx * 28 + 14;
    const toY = to.y + 40 + toColIdx * 28 + 14;

    const fromRight = from.x + from.width;
    const toRight = to.x + to.width;

    // fromTable has the FK (many side), toTable has the PK (one side)
    // Arrow points TO the many side (fromTable)
    let x1, x2, arrowAtStart;
    if (from.x > to.x + to.width) {
      // fromTable is to the right — arrow at fromTable's left
      x1 = toRight;   // line starts at toTable right
      x2 = from.x;    // line ends at fromTable left
      arrowAtStart = false;
    } else if (to.x > fromRight) {
      // toTable is to the right — arrow at fromTable's right
      x1 = to.x;      // line starts at toTable left
      x2 = fromRight; // line ends at fromTable right
      arrowAtStart = false;
    } else {
      x1 = toRight;
      x2 = from.x;
      arrowAtStart = false;
    }

    // Determine relationship type: if FK column is also PK → 1:1, else 1:N
    const fkCol = from.columns.find((c) => c.name === rel.fromColumn);
    const relType = fkCol?.pk ? "1:1" : "1:N";

    const cx1 = x1 + (x2 - x1) * 0.5;
    const cx2 = x2 - (x2 - x1) * 0.5;
    const midX = (x1 + x2) / 2;
    const midY = (fromY + toY) / 2;

    return { x1, y1: toY, x2, y2: fromY, cx1, cy1: toY, cx2, cy2: fromY, relType, midX, midY, arrowAtStart };
  }

  const selectedTableData = tables.find((t) => t.name === selectedTable);

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>⟺ Data Model Lineage</h2>
          <p style={s.sub}>Interactive ERD — drag tables, click to see relationships and impact</p>
        </div>
        <div style={s.headerRight}>
          <button onClick={() => setZoom((z) => Math.min(2, z + 0.1))} style={s.zoomBtn}>+</button>
          <span style={s.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))} style={s.zoomBtn}>−</button>
          <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} style={s.zoomBtn}>Reset</button>
          <button onClick={loadLineage} style={s.refreshBtn}>↻ Refresh</button>
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {loading && <div style={s.loading}>Loading schema relationships…</div>}

      <div style={s.workspace}>
        {/* Canvas */}
        <div
          ref={canvasRef}
          style={s.canvas}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseDown={handleCanvasMouseDown}
          onWheel={handleWheel}
        >
          <div style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
            position: "relative",
            width: "100%",
            height: "100%",
          }}>
            {/* SVG for relationship lines */}
            <svg style={s.svg} width="4000" height="3000">
              <defs>
                <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="var(--accent)" />
                </marker>
                <marker id="arrowhead-dim" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="var(--border-bright)" />
                </marker>
              </defs>

              {relationships.map((rel, i) => {
    const line = getRelLine(rel);
    if (!line) return null;
    const style = getRelationshipStyle(rel);
    const isHighlighted = selectedTable && (rel.fromTable === selectedTable || rel.toTable === selectedTable);
    const isOneToOne = line.relType === "1:1";
    return (
      <g key={i}>
        <path
          d={`M ${line.x1} ${line.y1} C ${line.cx1} ${line.cy1}, ${line.cx2} ${line.cy2}, ${line.x2} ${line.y2}`}
          fill="none"
          stroke={style.stroke}
          strokeWidth={isHighlighted ? 2 : 1}
          strokeOpacity={style.opacity}
          markerEnd={isHighlighted ? "url(#arrowhead)" : "url(#arrowhead-dim)"}
          strokeDasharray={isHighlighted ? "none" : "4 2"}
        />

        {/* Relationship type badge */}
        <rect
          x={line.midX - 16}
          y={line.midY - 10}
          width={32}
          height={18}
          rx={9}
          fill={isHighlighted ? "var(--accent)" : "var(--bg-elevated)"}
          stroke={isHighlighted ? "var(--accent)" : "var(--border-bright)"}
          strokeWidth={1}
          opacity={style.opacity}
        />
        <text
          x={line.midX}
          y={line.midY + 4}
          fontSize="10"
          fill={isHighlighted ? "#000" : "var(--text-secondary)"}
          textAnchor="middle"
          style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}
          opacity={style.opacity}
        >
          {line.relType}
        </text>

        {/* "1" label on the one side (toTable) */}
        <text
          x={line.x1 + (line.x2 > line.x1 ? -16 : 16)}
          y={line.y1 - 6}
          fontSize="11"
          fill={isHighlighted ? "var(--accent)" : "var(--text-muted)"}
          textAnchor="middle"
          style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}
          opacity={style.opacity}
        >
          1
        </text>

        {/* "N" or "1" label on the many side (fromTable) */}
        <text
          x={line.x2 + (line.x2 > line.x1 ? 16 : -16)}
          y={line.y2 - 6}
          fontSize="11"
          fill={isHighlighted ? "var(--accent)" : "var(--text-muted)"}
          textAnchor="middle"
          style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}
          opacity={style.opacity}
        >
          {isOneToOne ? "1" : "N"}
        </text>

        {/* Column labels on highlighted relationships */}
        {isHighlighted && (
          <text
            x={line.midX}
            y={line.midY - 16}
            fontSize="10"
            fill="var(--accent)"
            textAnchor="middle"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {rel.fromColumn} → {rel.toColumn}
          </text>
        )}
      </g>
    );
  })}
            </svg>

            {/* Table nodes */}
            {tables.map((table) => {
              const style = getTableStyle(table);
              return (
                <div
                  key={table.name}
                  style={{
                    position: "absolute",
                    left: table.x,
                    top: table.y,
                    width: table.width,
                    background: "var(--bg-panel)",
                    border: style.border,
                    borderRadius: 8,
                    boxShadow: style.shadow,
                    cursor: dragging === table.name ? "grabbing" : "grab",
                    userSelect: "none",
                    transition: dragging === table.name ? "none" : "box-shadow 0.2s, border 0.2s",
                    opacity: (style as Record<string, unknown>).opacity as number ?? 1,
                  }}
                  onMouseDown={(e) => handleTableMouseDown(e, table.name)}
                  onMouseEnter={() => setHoveredTable(table.name)}
                  onMouseLeave={() => setHoveredTable(null)}
                >
                  {/* Table header */}
                  <div style={{
                    ...s.tableHeader,
                    background: selectedTable === table.name ? "var(--accent-dim)" :
                      impactTables.includes(table.name) ? "var(--red-dim)" :
                      dependencyTables.includes(table.name) ? "var(--green-dim)" :
                      "var(--bg-elevated)",
                  }}>
                    <span style={s.tableIcon}>▦</span>
                    <span style={s.tableName}>{table.name}</span>
                    <span style={s.colCount}>{table.columns.length}c</span>
                  </div>

                  {/* Columns */}
                  <div style={s.columnList}>
                    {table.columns.map((col) => {
                      const isFKCol = table.foreignKeys.some((fk) => fk.from === col.name);
                      const isRelated = selectedTable && relationships.some((r) =>
                        (r.fromTable === table.name && r.fromColumn === col.name) ||
                        (r.toTable === table.name && r.toColumn === col.name)
                      );
                      return (
                        <div key={col.name} style={{
                          ...s.column,
                          background: isRelated ? "var(--accent-dim)" : "transparent",
                        }}>
                          <span style={s.colIcon}>
                            {col.pk ? "🔑" : isFKCol ? "🔗" : "○"}
                          </span>
                          <span style={{
                            ...s.colName,
                            color: col.pk ? "var(--amber)" : isFKCol ? "var(--accent)" : "var(--text-secondary)",
                            fontWeight: col.pk ? 600 : 400,
                          }}>
                            {col.name}
                          </span>
                          <span style={s.colType}>{col.type}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Side panel */}
        {selectedTable && selectedTableData && (
          <div style={s.sidePanel}>
            <div style={s.sidePanelHeader}>
              <span style={s.sidePanelTitle}>{selectedTable}</span>
              <button onClick={() => setSelectedTable(null)} style={s.closeBtn}>✕</button>
            </div>

            {/* Impact Analysis */}
            <div style={s.section}>
              <div style={s.sectionTitle}>Impact Analysis</div>
              <p style={s.sectionDesc}>
                What would break if <strong>{selectedTable}</strong> was removed or changed?
              </p>

              {impactTables.length === 0 ? (
                <div style={s.noImpact}>✓ No tables depend on this table</div>
              ) : (
                <>
                  <div style={s.impactWarning}>
                    ⚠ {impactTables.length} table{impactTables.length > 1 ? "s" : ""} would be affected
                  </div>
                  {impactTables.map((t) => {
                    const rels = relationships.filter((r) => r.fromTable === t && r.toTable === selectedTable);
                    return (
                      <div key={t} style={s.impactItem}>
                        <div style={s.impactTable} onClick={() => setSelectedTable(t)}>▦ {t}</div>
                        {rels.map((r, i) => (
                          <div key={i} style={s.impactRel}>
                            🔗 {r.fromColumn} → {r.toColumn}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Dependencies */}
            <div style={s.section}>
              <div style={s.sectionTitle}>Dependencies</div>
              <p style={s.sectionDesc}>
                Tables that <strong>{selectedTable}</strong> depends on:
              </p>

              {dependencyTables.length === 0 ? (
                <div style={s.noImpact}>✓ This table has no dependencies</div>
              ) : (
                dependencyTables.map((t) => {
                  const rels = relationships.filter((r) => r.fromTable === selectedTable && r.toTable === t);
                  return (
                    <div key={t} style={s.impactItem}>
                      <div style={s.depTable} onClick={() => setSelectedTable(t)}>▦ {t}</div>
                      {rels.map((r, i) => (
                        <div key={i} style={s.impactRel}>
                          🔗 {r.fromColumn} → {r.toColumn}
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>

            {/* Foreign Keys */}
            <div style={s.section}>
              <div style={s.sectionTitle}>Columns</div>
              {selectedTableData.columns.map((col) => {
                const fk = selectedTableData.foreignKeys.find((f) => f.from === col.name);
                return (
                  <div key={col.name} style={s.colDetail}>
                    <span style={s.colDetailIcon}>
                      {col.pk ? "🔑" : fk ? "🔗" : "○"}
                    </span>
                    <div>
                      <div style={{
                        fontSize: 12, fontFamily: "var(--font-mono)",
                        color: col.pk ? "var(--amber)" : fk ? "var(--accent)" : "var(--text-primary)",
                        fontWeight: col.pk || fk ? 600 : 400,
                      }}>
                        {col.name}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {col.type}
                        {col.pk ? " · PRIMARY KEY" : ""}
                        {fk ? ` · FK → ${fk.table}.${fk.to}` : ""}
                        {col.notnull ? " · NOT NULL" : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div style={s.legend}>
              <div style={s.legendTitle}>Legend</div>
              <div style={s.legendItem}><span style={{ color: "var(--accent)" }}>■</span> Selected table</div>
              <div style={s.legendItem}><span style={{ color: "var(--red)" }}>■</span> Affected by changes</div>
              <div style={s.legendItem}><span style={{ color: "var(--green)" }}>■</span> Dependencies</div>
              <div style={s.legendItem}>🔑 Primary key</div>
              <div style={s.legendItem}>🔗 Foreign key</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header: { padding: "20px 28px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 },
  title: { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 },
  sub: { color: "var(--text-secondary)", fontSize: 13 },
  headerRight: { display: "flex", alignItems: "center", gap: 8 },
  zoomBtn: { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", width: 28, height: 28, borderRadius: "var(--radius)", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" },
  zoomLabel: { fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--font-mono)", minWidth: 40, textAlign: "center" as const },
  refreshBtn: { background: "none", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 12px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  error: { margin: "12px 28px", padding: "10px 14px", background: "var(--red-dim)", color: "var(--red)", borderRadius: "var(--radius)", border: "1px solid var(--red)", fontSize: 13 },
  loading: { padding: "24px 28px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 },
  workspace: { display: "flex", flex: 1, overflow: "hidden" },
  canvas: { flex: 1, overflow: "hidden", position: "relative", cursor: "grab", background: "var(--bg)", backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: "24px 24px" },
  svg: { position: "absolute", top: 0, left: 0, pointerEvents: "none", overflow: "visible" },
  tableHeader: { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)", borderRadius: "8px 8px 0 0" },
  tableIcon: { fontSize: 12, color: "var(--text-muted)" },
  tableName: { flex: 1, fontSize: 13, fontWeight: 600, fontFamily: "var(--font-mono)", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  colCount: { fontSize: 10, color: "var(--text-muted)", background: "var(--bg)", padding: "1px 6px", borderRadius: 99, flexShrink: 0 },
  columnList: { padding: "6px 0" },
  column: { display: "flex", alignItems: "center", gap: 6, padding: "4px 12px", transition: "background 0.1s" },
  colIcon: { fontSize: 9, flexShrink: 0, width: 14 },
  colName: { flex: 1, fontSize: 12, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  colType: { fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 },
  sidePanel: { width: 300, borderLeft: "1px solid var(--border)", overflow: "auto", background: "var(--bg-panel)", display: "flex", flexDirection: "column" },
  sidePanelHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)" },
  sidePanelTitle: { fontSize: 14, fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-mono)" },
  closeBtn: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 },
  section: { padding: "16px", borderBottom: "1px solid var(--border)" },
  sectionTitle: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px", marginBottom: 8 },
  sectionDesc: { fontSize: 12, color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 },
  noImpact: { fontSize: 12, color: "var(--green)", fontFamily: "var(--font-mono)" },
  impactWarning: { fontSize: 12, color: "var(--red)", marginBottom: 10, fontFamily: "var(--font-mono)" },
  impactItem: { background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "8px 10px", marginBottom: 6 },
  impactTable: { fontSize: 12, fontWeight: 600, color: "var(--red)", fontFamily: "var(--font-mono)", cursor: "pointer", marginBottom: 4 },
  depTable: { fontSize: 12, fontWeight: 600, color: "var(--green)", fontFamily: "var(--font-mono)", cursor: "pointer", marginBottom: 4 },
  impactRel: { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", paddingLeft: 8 },
  colDetail: { display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 0", borderBottom: "1px solid var(--border)" },
  colDetailIcon: { fontSize: 12, marginTop: 2, flexShrink: 0 },
  legend: { padding: "16px", marginTop: "auto" },
  legendTitle: { fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px", marginBottom: 8 },
  legendItem: { fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 },
};