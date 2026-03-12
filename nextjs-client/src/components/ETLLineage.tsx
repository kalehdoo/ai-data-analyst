"use client";
import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ManifestNode {
  unique_id: string;
  name: string;
  resource_type: string;
  path: string;
  schema: string;
  database: string;
  description: string;
  tags: string[];
  config?: { materialized?: string };
  depends_on?: { nodes: string[] };
  columns: Record<string, { name: string; description: string; data_type?: string }>;
}

interface ManifestSource {
  unique_id: string;
  name: string;
  source_name: string;
  resource_type: string;
  schema: string;
  database: string;
  description: string;
  tags: string[];
  loader?: string;
  columns: Record<string, { name: string; description: string }>;
}

interface Manifest {
  metadata: { dbt_version: string; generated_at: string; project_name: string };
  nodes: Record<string, ManifestNode>;
  sources: Record<string, ManifestSource>;
  parent_map: Record<string, string[]>;
  child_map: Record<string, string[]>;
}

interface GraphNode {
  id: string;
  name: string;
  layer: "source" | "staging" | "intermediate" | "mart";
  sublayer: string;
  resourceType: string;
  materialized: string;
  description: string;
  tags: string[];
  columns: Record<string, { name: string; description: string; data_type?: string }>;
  parents: string[];
  children: string[];
  x: number;
  y: number;
  loader?: string;
  path?: string;
}

// ── Layer config ───────────────────────────────────────────────────────────────
const LAYER_CONFIG: Record<string, { color: string; bg: string; border: string; label: string; order: number }> = {
  source:       { color: "#e8b84b", bg: "rgba(232,184,75,0.12)",  border: "rgba(232,184,75,0.5)",  label: "Sources",      order: 0 },
  staging:      { color: "#58a6ff", bg: "rgba(88,166,255,0.12)",  border: "rgba(88,166,255,0.5)",  label: "Staging",      order: 1 },
  intermediate: { color: "#bc8cff", bg: "rgba(188,140,255,0.12)", border: "rgba(188,140,255,0.5)", label: "Intermediate", order: 2 },
  mart:         { color: "#3fb950", bg: "rgba(63,185,80,0.12)",   border: "rgba(63,185,80,0.5)",   label: "Marts",        order: 3 },
};

const MAT_BADGE: Record<string, { label: string; color: string }> = {
  view:        { label: "VIEW",        color: "#58a6ff" },
  table:       { label: "TABLE",       color: "#3fb950" },
  incremental: { label: "INCR",        color: "#e8b84b" },
  ephemeral:   { label: "EPHEMERAL",   color: "#bc8cff" },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function getLayer(id: string, name: string): "source" | "staging" | "intermediate" | "mart" {
  if (id.startsWith("source.")) return "source";
  if (name.startsWith("stg_")) return "staging";
  if (name.startsWith("int_")) return "intermediate";
  return "mart";
}

function getSublayer(node: GraphNode): string {
  if (node.layer === "mart") {
    if (node.name.startsWith("dim_")) return "dimension";
    if (node.name.startsWith("fct_")) return "fact";
    if (node.name.startsWith("mart_")) return "reporting";
    return "mart";
  }
  return node.layer;
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function ETLLineage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [filterLayer, setFilterLayer] = useState<string>("all");
  const [filterTag, setFilterTag] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [zoom, setZoom] = useState(0.85);
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const panMoved = useRef(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [searchMode, setSearchMode] = useState<"model" | "column">("model");
const [columnSearch, setColumnSearch] = useState("");

  useEffect(() => { loadManifest(); }, []);

  async function loadManifest() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/dbt/manifest.json");
      if (!res.ok) throw new Error(`Could not load manifest.json (${res.status})`);
      const data: Manifest = await res.json();
      setManifest(data);
      buildGraph(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function buildGraph(data: Manifest) {
    const allNodes: GraphNode[] = [];

    // Add sources
    Object.values(data.sources).forEach((src) => {
      allNodes.push({
        id: src.unique_id,
        name: src.name,
        layer: "source",
        sublayer: src.source_name,
        resourceType: "source",
        materialized: "external",
        description: src.description,
        tags: src.tags || [],
        columns: src.columns || {},
        parents: [],
        children: data.child_map[src.unique_id] || [],
        loader: src.loader,
        x: 0, y: 0,
      });
    });

    // Add models
    Object.values(data.nodes).forEach((node) => {
      if (node.resource_type !== "model") return;
      const layer = getLayer(node.unique_id, node.name);
      allNodes.push({
        id: node.unique_id,
        name: node.name,
        layer,
        sublayer: "",
        resourceType: "model",
        materialized: node.config?.materialized || "view",
        description: node.description,
        tags: node.tags || [],
        columns: node.columns || {},
        parents: data.parent_map[node.unique_id] || [],
        children: data.child_map[node.unique_id] || [],
        path: node.path,
        x: 0, y: 0,
      });
    });

    // Compute sublayers
    allNodes.forEach((n) => { n.sublayer = getSublayer(n); });

    // Layout: group by layer, then by sublayer vertically
    const layerOrder = ["source", "staging", "intermediate", "mart"];
    const nodeWidth = 220;
    const nodeGap = 30;
    const layerGap = 120;
    const vertGap = 20;

    // Group nodes by layer
    const byLayer: Record<string, GraphNode[]> = {};
    layerOrder.forEach((l) => { byLayer[l] = allNodes.filter((n) => n.layer === l); });

    let xCursor = 60;
    layerOrder.forEach((layer) => {
      const layerNodes = byLayer[layer];
      if (!layerNodes.length) return;

      // Sort by sublayer so dims, facts, reporting stack nicely
      layerNodes.sort((a, b) => a.sublayer.localeCompare(b.sublayer));

      let yCursor = 60;
      layerNodes.forEach((node) => {
        node.x = xCursor;
        node.y = yCursor;
        const colCount = Object.keys(node.columns).length;
        const nodeHeight = 44 + Math.min(colCount, 8) * 22 + 12;
        yCursor += nodeHeight + vertGap;
      });

      xCursor += nodeWidth + layerGap;
    });

    setNodes(allNodes);
  }

  // ── Interaction ──────────────────────────────────────────────────────────────
  function handleNodeMouseDown(e: React.MouseEvent, nodeId: string) {
    e.stopPropagation();
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    setDragging(nodeId);
    setDragOffset({ x: e.clientX / zoom - node.x, y: e.clientY / zoom - node.y });
    setSelectedNode(node);
  }

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (dragging) {
      setNodes((prev) => prev.map((n) =>
        n.id === dragging
          ? { ...n, x: e.clientX / zoom - dragOffset.x, y: e.clientY / zoom - dragOffset.y }
          : n
      ));
    } else if (isPanning) {
      panMoved.current = true;
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
  }, [dragging, dragOffset, isPanning, panStart, zoom]);

  function handleMouseUp(e: React.MouseEvent) {
    if (isPanning && !panMoved.current && !dragging) {
      setSelectedNode(null);
    }
    setDragging(null);
    setIsPanning(false);
  }

  function handleCanvasMouseDown(e: React.MouseEvent) {
    if (!dragging) {
      setIsPanning(true);
      panMoved.current = false;
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setZoom((prev) => Math.max(0.2, Math.min(2, prev - e.deltaY * 0.001)));
  }

  // ── Derived state ────────────────────────────────────────────────────────────
  const allTags = Array.from(new Set(nodes.flatMap((n) => n.tags))).sort();

  const visibleNodes = nodes.filter((n) => {
    if (filterLayer !== "all" && n.layer !== filterLayer) return false;
    if (filterTag !== "all" && !n.tags.includes(filterTag)) return false;
    if (searchMode === "model" && searchQuery && !n.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    if (searchMode === "column" && columnSearch) {
      const hasCol = Object.values(n.columns).some((c) =>
        c.name.toLowerCase().includes(columnSearch.toLowerCase()) ||
        (c.description || "").toLowerCase().includes(columnSearch.toLowerCase())
      );
      if (!hasCol) return false;
    }
    return true;
  });

  // Columns matching the search within a node
  function getMatchingColumns(node: GraphNode): string[] {
    if (searchMode !== "column" || !columnSearch) return [];
    return Object.values(node.columns)
      .filter((c) =>
        c.name.toLowerCase().includes(columnSearch.toLowerCase()) ||
        (c.description || "").toLowerCase().includes(columnSearch.toLowerCase())
      )
      .map((c) => c.name);
  }

  const visibleIds = new Set(visibleNodes.map((n) => n.id));

  // Highlight: selected node + its ancestors + descendants
  function getHighlight(nodeId: string): "selected" | "ancestor" | "descendant" | "dim" | "normal" {
    if (!selectedNode) return "normal";
    if (nodeId === selectedNode.id) return "selected";

    // Walk ancestors
    function isAncestor(id: string, visited = new Set<string>()): boolean {
      if (visited.has(id)) return false;
      visited.add(id);
      const node = nodes.find((n) => n.id === id);
      if (!node) return false;
      if (node.children.includes(selectedNode.id)) return true;
      return node.children.some((c) => isAncestor(c, visited));
    }

    // Walk descendants
    function isDescendant(id: string, visited = new Set<string>()): boolean {
      if (visited.has(id)) return false;
      visited.add(id);
      const node = nodes.find((n) => n.id === id);
      if (!node) return false;
      if (node.parents.includes(selectedNode.id)) return true;
      return node.parents.some((p) => isDescendant(p, visited));
    }

    if (selectedNode.parents.includes(nodeId) || isAncestor(nodeId)) return "ancestor";
    if (selectedNode.children.includes(nodeId) || isDescendant(nodeId)) return "descendant";
    return "dim";
  }

  function getEdgeStyle(fromId: string, toId: string) {
    if (!selectedNode) return { stroke: "var(--border-bright)", opacity: 0.5, width: 1, dash: "4 3" };
    const fromHL = getHighlight(fromId);
    const toHL = getHighlight(toId);
    if (fromHL === "selected" || toHL === "selected" ||
        fromHL === "ancestor" || fromHL === "descendant" ||
        toHL === "ancestor" || toHL === "descendant") {
      return { stroke: "var(--accent)", opacity: 1, width: 2, dash: "none" };
    }
    return { stroke: "var(--border)", opacity: 0.15, width: 1, dash: "4 3" };
  }

  // ── Node height ──────────────────────────────────────────────────────────────
  function getNodeHeight(node: GraphNode) {
    const colCount = Object.keys(node.columns).length;
    return 44 + Math.min(colCount, 8) * 22 + 12;
  }

  const nodeWidth = 220;

  // ── Layer bands ──────────────────────────────────────────────────────────────
  function getLayerBands() {
    const bands: { layer: string; x: number; width: number }[] = [];
    const layerOrder = ["source", "staging", "intermediate", "mart"];
    layerOrder.forEach((layer) => {
      const layerNodes = nodes.filter((n) => n.layer === layer);
      if (!layerNodes.length) return;
      const minX = Math.min(...layerNodes.map((n) => n.x)) - 16;
      const maxX = Math.max(...layerNodes.map((n) => n.x)) + nodeWidth + 16;
      bands.push({ layer, x: minX, width: maxX - minX });
    });
    return bands;
  }

  return (
    <div style={s.root}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>⬡ ETL Lineage</h2>
          <p style={s.sub}>dbt data pipeline — sources → staging → intermediate → marts</p>
        </div>
        <div style={s.controls}>
          {/* Search mode toggle */}
<div style={s.searchToggle}>
  <button
    style={{ ...s.toggleBtn, ...(searchMode === "model" ? s.toggleActive : {}) }}
    onClick={() => setSearchMode("model")}
  >
    Models
  </button>
  <button
    style={{ ...s.toggleBtn, ...(searchMode === "column" ? s.toggleActive : {}) }}
    onClick={() => setSearchMode("column")}
  >
    Columns
  </button>
</div>
{searchMode === "model" ? (
  <input
    style={s.search}
    placeholder="Search models…"
    value={searchQuery}
    onChange={(e) => setSearchQuery(e.target.value)}
  />
) : (
  <input
    style={{ ...s.search, borderColor: "#e8b84b", width: 200 }}
    placeholder="Search columns…"
    value={columnSearch}
    onChange={(e) => setColumnSearch(e.target.value)}
  />
)}
          {/* Layer filter */}
          <select style={s.select} value={filterLayer} onChange={(e) => setFilterLayer(e.target.value)}>
            <option value="all">All Layers</option>
            <option value="source">Sources</option>
            <option value="staging">Staging</option>
            <option value="intermediate">Intermediate</option>
            <option value="mart">Marts</option>
          </select>
          {/* Tag filter */}
          <select style={s.select} value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
            <option value="all">All Tags</option>
            {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {/* Zoom */}
          <div style={s.zoomRow}>
            <button style={s.zBtn} onClick={() => setZoom((z) => Math.min(2, z + 0.1))}>+</button>
            <span style={s.zLabel}>{Math.round(zoom * 100)}%</span>
            <button style={s.zBtn} onClick={() => setZoom((z) => Math.max(0.2, z - 0.1))}>−</button>
            <button style={s.zBtn} onClick={() => { setZoom(0.85); setPan({ x: 40, y: 40 }); }}>⟳</button>
          </div>
          <button style={s.refreshBtn} onClick={loadManifest}>↻ Reload</button>
        </div>
      </div>

      {/* Layer legend */}
      <div style={s.legend}>
        {Object.entries(LAYER_CONFIG).map(([key, cfg]) => (
          <div
            key={key}
            style={{ ...s.legendItem, borderColor: filterLayer === key ? cfg.color : "transparent", cursor: "pointer" }}
            onClick={() => setFilterLayer(filterLayer === key ? "all" : key)}
          >
            <span style={{ ...s.legendDot, background: cfg.color }} />
            <span style={{ color: filterLayer === key ? cfg.color : "var(--text-secondary)" }}>{cfg.label}</span>
          </div>
        ))}
        <div style={s.legendItem}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {visibleNodes.length} / {nodes.length} models
          </span>
        </div>
        {manifest && (
          <div style={s.legendItem}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              dbt {manifest.metadata.dbt_version} · {manifest.metadata.project_name}
            </span>
          </div>
        )}
      </div>

      {error && <div style={s.error}>⚠ {error} — make sure manifest.json is in public/dbt/</div>}
      {loading && <div style={s.loading}>Parsing dbt manifest…</div>}

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
            width: 3000,
            height: 2400,
          }}>
            {/* Layer band backgrounds */}
            <svg style={{ position: "absolute", top: 0, left: 0, width: 3000, height: 2400, pointerEvents: "none" }}>
              {getLayerBands().map(({ layer, x, width }) => {
                const cfg = LAYER_CONFIG[layer];
                const allY = nodes.filter((n) => n.layer === layer).map((n) => n.y);
                const minY = Math.min(...allY) - 20;
                const maxY = Math.max(...nodes.filter((n) => n.layer === layer).map((n) => n.y + getNodeHeight(n))) + 20;
                return (
                  <g key={layer}>
                    <rect x={x} y={minY} width={width} height={maxY - minY}
                      fill={cfg.bg} rx={12}
                      stroke={cfg.border} strokeWidth={1} strokeDasharray="6 3"
                    />
                    <text x={x + width / 2} y={minY - 8}
                      fontSize={11} fontWeight={700} fill={cfg.color}
                      textAnchor="middle" fontFamily="var(--font-mono)"
                      style={{ textTransform: "uppercase", letterSpacing: "1px" }}
                    >
                      {cfg.label.toUpperCase()}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* SVG edges */}
            <svg style={{ position: "absolute", top: 0, left: 0, width: 3000, height: 2400, pointerEvents: "none", overflow: "visible" }}>
              <defs>
                <marker id="arr" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="var(--accent)" />
                </marker>
                <marker id="arr-dim" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="var(--border-bright)" />
                </marker>
              </defs>

              {nodes.map((node) =>
                node.children
                  .filter((childId) => visibleIds.has(childId) && visibleIds.has(node.id))
                  .map((childId) => {
                    const child = nodes.find((n) => n.id === childId);
                    if (!child) return null;
                    const eStyle = getEdgeStyle(node.id, childId);

                    const x1 = node.x + nodeWidth;
                    const y1 = node.y + getNodeHeight(node) / 2;
                    const x2 = child.x;
                    const y2 = child.y + getNodeHeight(child) / 2;
                    const cx1 = x1 + (x2 - x1) * 0.5;
                    const cx2 = x2 - (x2 - x1) * 0.5;

                    return (
                      <path
                        key={`${node.id}-${childId}`}
                        d={`M ${x1} ${y1} C ${cx1} ${y1}, ${cx2} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke={eStyle.stroke}
                        strokeWidth={eStyle.width}
                        strokeOpacity={eStyle.opacity}
                        strokeDasharray={eStyle.dash}
                        markerEnd={eStyle.opacity > 0.5 ? "url(#arr)" : "url(#arr-dim)"}
                      />
                    );
                  })
              )}
            </svg>

            {/* Nodes */}
            {visibleNodes.map((node) => {
              const hl = getHighlight(node.id);
              const cfg = LAYER_CONFIG[node.layer];
              const mat = MAT_BADGE[node.materialized] || { label: node.materialized.toUpperCase(), color: "var(--text-muted)" };
              const isSelected = hl === "selected";
              const isDim = hl === "dim";
              const colEntries = Object.values(node.columns).slice(0, 8);

              return (
                <div
                  key={node.id}
                  style={{
                    position: "absolute",
                    left: node.x,
                    top: node.y,
                    width: nodeWidth,
                    background: "var(--bg-panel)",
                    border: `${isSelected ? "2px" : "1px"} solid ${isSelected ? cfg.color : hl === "ancestor" ? "#e8b84b" : hl === "descendant" ? "#3fb950" : cfg.border}`,
                    borderRadius: 8,
                    cursor: dragging === node.id ? "grabbing" : "grab",
                    userSelect: "none",
                    opacity: isDim ? 0.25 : 1,
                    transition: dragging === node.id ? "none" : "opacity 0.15s, border 0.15s",
                    boxShadow: isSelected ? `0 0 16px ${cfg.color}44` : hoveredNode === node.id ? "0 4px 16px rgba(0,0,0,0.4)" : "0 2px 6px rgba(0,0,0,0.2)",
                  }}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  onMouseEnter={() => setHoveredNode(node.id)}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  {/* Header */}
                  <div style={{ ...nc.header, background: `${cfg.bg}` }}>
                    <div style={nc.headerTop}>
                      <span style={{ ...nc.layerDot, background: cfg.color }} />
                      <span style={{ ...nc.name, color: cfg.color }}>{node.name}</span>
                    </div>
                    <div style={nc.headerMeta}>
                      <span style={{ ...nc.matBadge, color: mat.color, borderColor: `${mat.color}55` }}>
                        {mat.label}
                      </span>
                      {node.loader && (
                        <span style={nc.loaderBadge}>{node.loader}</span>
                      )}
                      <span style={nc.colCount}>{Object.keys(node.columns).length}c</span>
                    </div>
                  </div>

                  {/* Columns */}
<div style={nc.colList}>
  {colEntries.map((col) => {
    const matchingCols = getMatchingColumns(node);
    const isMatch = matchingCols.includes(col.name);
    return (
      <div key={col.name} style={{
        ...nc.col,
        background: isMatch ? "rgba(232,184,75,0.15)" : "transparent",
        borderRadius: isMatch ? 4 : 0,
      }}>
        <span style={{ ...nc.colBullet, color: isMatch ? "#e8b84b" : "var(--border-bright)" }}>
          {isMatch ? "★" : "·"}
        </span>
        <span style={{ ...nc.colName, color: isMatch ? "#e8b84b" : "var(--text-secondary)", fontWeight: isMatch ? 600 : 400 }}>
          {col.name}
        </span>
        {col.data_type && (
          <span style={nc.colType}>{col.data_type}</span>
        )}
      </div>
    );
  })}
  {Object.keys(node.columns).length > 8 && (
    <div style={nc.moreCol}>+{Object.keys(node.columns).length - 8} more</div>
  )}
</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail panel */}
        {selectedNode && (
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <div>
                <div style={{ ...s.panelTitle, color: LAYER_CONFIG[selectedNode.layer].color }}>
                  {selectedNode.name}
                </div>
                <div style={s.panelSub}>{LAYER_CONFIG[selectedNode.layer].label} · {selectedNode.materialized}</div>
              </div>
              <button onClick={() => setSelectedNode(null)} style={s.closeBtn}>✕</button>
            </div>

            {/* Description */}
            {selectedNode.description && (
              <div style={s.panelSection}>
                <div style={s.sectionLabel}>Description</div>
                <p style={s.descText}>{selectedNode.description}</p>
              </div>
            )}

            {/* Tags */}
            {selectedNode.tags.length > 0 && (
              <div style={s.panelSection}>
                <div style={s.sectionLabel}>Tags</div>
                <div style={s.tagRow}>
                  {selectedNode.tags.map((t) => (
                    <span key={t} style={s.tag}>{t}</span>
                  ))}
                </div>
              </div>
            )}

            {/* Path */}
            {selectedNode.path && (
              <div style={s.panelSection}>
                <div style={s.sectionLabel}>File Path</div>
                <code style={s.pathCode}>{selectedNode.path}</code>
              </div>
            )}

            {/* Upstream */}
            <div style={s.panelSection}>
              <div style={s.sectionLabel}>
                ← Upstream ({selectedNode.parents.length})
              </div>
              {selectedNode.parents.length === 0
                ? <div style={s.emptyDep}>No upstream dependencies</div>
                : selectedNode.parents.map((pid) => {
                    const pNode = nodes.find((n) => n.id === pid);
                    if (!pNode) return null;
                    const cfg = LAYER_CONFIG[pNode.layer];
                    return (
                      <div key={pid} style={s.depItem} onClick={() => setSelectedNode(pNode)}>
                        <span style={{ ...s.depDot, background: cfg.color }} />
                        <span style={{ color: cfg.color, fontSize: 12, fontFamily: "var(--font-mono)" }}>
                          {pNode.name}
                        </span>
                        <span style={s.depLayer}>{cfg.label}</span>
                      </div>
                    );
                  })
              }
            </div>

            {/* Downstream */}
            <div style={s.panelSection}>
              <div style={s.sectionLabel}>
                → Downstream ({selectedNode.children.length})
              </div>
              {selectedNode.children.length === 0
                ? <div style={s.emptyDep}>No downstream consumers — this is an end node</div>
                : selectedNode.children.map((cid) => {
                    const cNode = nodes.find((n) => n.id === cid);
                    if (!cNode) return null;
                    const cfg = LAYER_CONFIG[cNode.layer];
                    return (
                      <div key={cid} style={s.depItem} onClick={() => setSelectedNode(cNode)}>
                        <span style={{ ...s.depDot, background: cfg.color }} />
                        <span style={{ color: cfg.color, fontSize: 12, fontFamily: "var(--font-mono)" }}>
                          {cNode.name}
                        </span>
                        <span style={s.depLayer}>{cfg.label}</span>
                      </div>
                    );
                  })
              }
            </div>

            {/* Columns */}
<div style={{ ...s.sectionLabel, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
  <span>Columns ({Object.keys(selectedNode.columns).length})</span>
  <input
    style={s.colSearchInput}
    placeholder="Filter columns…"
    value={columnSearch}
    onChange={(e) => { setColumnSearch(e.target.value); setSearchMode("column"); }}
  />
</div>

{/* Column count summary */}
<div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
  <span style={s.colStat}>
    <span style={{ color: "var(--accent)" }}>
      {Object.values(selectedNode.columns).filter((c) => c.data_type).length}
    </span> typed
  </span>
  <span style={s.colStat}>
    <span style={{ color: "var(--green)" }}>
      {Object.values(selectedNode.columns).filter((c) => c.description).length}
    </span> documented
  </span>
  <span style={s.colStat}>
    <span style={{ color: "var(--text-muted)" }}>
      {Object.values(selectedNode.columns).filter((c) => !c.description).length}
    </span> undocumented
  </span>
</div>

{/* Column list — all columns, no limit */}
{Object.values(selectedNode.columns)
  .filter((col) =>
    !columnSearch ||
    col.name.toLowerCase().includes(columnSearch.toLowerCase()) ||
    (col.description || "").toLowerCase().includes(columnSearch.toLowerCase())
  )
  .map((col, idx) => {
    const isMatch = !!columnSearch && (
      col.name.toLowerCase().includes(columnSearch.toLowerCase()) ||
      (col.description || "").toLowerCase().includes(columnSearch.toLowerCase())
    );
    return (
      <div key={col.name} style={{
        padding: "8px 10px",
        borderRadius: 6,
        marginBottom: 4,
        background: isMatch
          ? "rgba(232,184,75,0.08)"
          : idx % 2 === 0 ? "var(--bg-elevated)" : "transparent",
        border: isMatch
          ? "1px solid rgba(232,184,75,0.3)"
          : "1px solid transparent",
      }}>
        {/* Column name + type badge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: col.description ? 4 : 0 }}>
          <span style={{
            fontSize: 10, color: "var(--text-muted)",
            fontFamily: "var(--font-mono)", minWidth: 16,
          }}>
            {String(idx + 1).padStart(2, "0")}
          </span>
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            fontWeight: 600,
            color: isMatch ? "#e8b84b" : "var(--text-primary)",
            flex: 1,
          }}>
            {isMatch ? "★ " : ""}{col.name}
          </span>
          {col.data_type && (
            <span style={{
              fontSize: 9,
              color: "var(--accent)",
              background: "var(--bg)",
              border: "1px solid var(--accent-border)",
              padding: "1px 6px",
              borderRadius: 99,
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase" as const,
              flexShrink: 0,
            }}>
              {col.data_type}
            </span>
          )}
        </div>

        {/* Description */}
        {col.description ? (
          <div style={{
            fontSize: 11,
            color: "var(--text-secondary)",
            lineHeight: 1.6,
            paddingLeft: 22,
          }}>
            {col.description}
          </div>
        ) : (
          <div style={{
            fontSize: 10,
            color: "var(--text-muted)",
            fontStyle: "italic" as const,
            paddingLeft: 22,
          }}>
            No description
          </div>
        )}
      </div>
    );
  })
}

{/* No results message */}
{columnSearch && Object.values(selectedNode.columns).filter((col) =>
  col.name.toLowerCase().includes(columnSearch.toLowerCase()) ||
  (col.description || "").toLowerCase().includes(columnSearch.toLowerCase())
).length === 0 && (
  <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" as const, padding: "8px 0" }}>
    No columns matching "{columnSearch}"
  </div>
)}

{/* Column search results across all models */}
{searchMode === "column" && columnSearch && (
  <div style={s.panelSection}>
    <div style={s.sectionLabel}>
      "{columnSearch}" in other models ({
        nodes.filter((n) =>
          n.id !== selectedNode.id &&
          Object.values(n.columns).some((c) =>
            c.name.toLowerCase().includes(columnSearch.toLowerCase())
          )
        ).length
      })
    </div>
    {nodes
      .filter((n) =>
        n.id !== selectedNode.id &&
        Object.values(n.columns).some((c) =>
          c.name.toLowerCase().includes(columnSearch.toLowerCase())
        )
      )
      .map((n) => {
        const cfg = LAYER_CONFIG[n.layer];
        const matchCols = Object.values(n.columns).filter((c) =>
          c.name.toLowerCase().includes(columnSearch.toLowerCase())
        );
        return (
          <div key={n.id} style={{ ...s.depItem, flexDirection: "column", alignItems: "flex-start", gap: 4 }}
            onClick={() => setSelectedNode(n)}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
              <span style={{ ...s.depDot, background: cfg.color }} />
              <span style={{ color: cfg.color, fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                {n.name}
              </span>
              <span style={s.depLayer}>{cfg.label}</span>
            </div>
            {matchCols.map((c) => (
              <div key={c.name} style={{ fontSize: 11, color: "#e8b84b", fontFamily: "var(--font-mono)", paddingLeft: 14 }}>
                ★ {c.name} {c.data_type ? `(${c.data_type})` : ""}
              </div>
            ))}
          </div>
        );
      })
    }
  </div>
)}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s: Record<string, React.CSSProperties> = {
  root:       { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  header:     { padding: "16px 24px 12px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 },
  title:      { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2 },
  sub:        { fontSize: 12, color: "var(--text-secondary)" },
  controls:   { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const },
  search:     { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "5px 10px", borderRadius: "var(--radius)", fontSize: 12, outline: "none", width: 160 },
  select:     { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 8px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  zoomRow:    { display: "flex", alignItems: "center", gap: 4 },
  zBtn:       { background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", width: 26, height: 26, borderRadius: "var(--radius)", cursor: "pointer", fontSize: 14 },
  zLabel:     { fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono)", minWidth: 36, textAlign: "center" as const },
  refreshBtn: { background: "none", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 10px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer" },
  legend:     { display: "flex", gap: 16, padding: "8px 24px", borderBottom: "1px solid var(--border)", flexShrink: 0, alignItems: "center", flexWrap: "wrap" as const },
  legendItem: { display: "flex", alignItems: "center", gap: 6, padding: "2px 8px", border: "1px solid transparent", borderRadius: 99, fontSize: 12, color: "var(--text-secondary)" },
  legendDot:  { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  error:      { margin: "10px 24px", padding: "10px 14px", background: "var(--red-dim)", color: "var(--red)", borderRadius: "var(--radius)", border: "1px solid var(--red)", fontSize: 12 },
  loading:    { padding: "20px 24px", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 },
  workspace:  { display: "flex", flex: 1, overflow: "hidden" },
  canvas:     { flex: 1, overflow: "hidden", position: "relative", cursor: "grab", background: "var(--bg)", backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: "20px 20px" },
  panel:      { width: 320, borderLeft: "1px solid var(--border)", overflow: "auto", background: "var(--bg-panel)", flexShrink: 0, display: "flex", flexDirection: "column" },
  panelHeader:{ padding: "14px 16px", borderBottom: "1px solid var(--border)", background: "var(--bg-elevated)", display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  panelTitle: { fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono)" },
  panelSub:   { fontSize: 11, color: "var(--text-muted)", marginTop: 2 },
  closeBtn:   { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 },
  panelSection:{ padding: "12px 16px", borderBottom: "1px solid var(--border)" },
  sectionLabel:{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.8px", marginBottom: 8 },
  descText:   { fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 },
  tagRow:     { display: "flex", gap: 6, flexWrap: "wrap" as const },
  tag:        { fontSize: 10, background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "2px 8px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  pathCode:   { fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)", wordBreak: "break-all" as const },
  depItem:    { display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", borderRadius: "var(--radius)", cursor: "pointer", marginBottom: 3, background: "var(--bg-elevated)", border: "1px solid var(--border)" },
  depDot:     { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
  depLayer:   { marginLeft: "auto", fontSize: 9, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.5px" },
  emptyDep:   { fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" as const },
  colDetail:  { padding: "5px 0", borderBottom: "1px solid var(--border)" },
  searchToggle:   { display: "flex", background: "var(--bg-elevated)", border: "1px solid var(--border-bright)", borderRadius: "var(--radius)", overflow: "hidden" },
toggleBtn:      { background: "none", border: "none", color: "var(--text-muted)", padding: "5px 10px", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
toggleActive:   { background: "var(--accent)", color: "#000", fontWeight: 600 },
colSearchInput: { background: "var(--bg)", border: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "3px 8px", borderRadius: "var(--radius)", fontSize: 11, outline: "none", width: 120 },
colStat: { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" },
};

const nc: Record<string, React.CSSProperties> = {
  header:     { padding: "8px 10px 6px", borderBottom: "1px solid var(--border)", borderRadius: "7px 7px 0 0" },
  headerTop:  { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  layerDot:   { width: 6, height: 6, borderRadius: "50%", flexShrink: 0 },
  name:       { fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  headerMeta: { display: "flex", gap: 4, alignItems: "center" },
  matBadge:   { fontSize: 9, fontWeight: 700, border: "1px solid", padding: "1px 5px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  loaderBadge:{ fontSize: 9, color: "var(--text-muted)", background: "var(--bg)", border: "1px solid var(--border)", padding: "1px 5px", borderRadius: 99, fontFamily: "var(--font-mono)" },
  colCount:   { marginLeft: "auto", fontSize: 9, color: "var(--text-muted)" },
  colList:    { padding: "4px 0 6px" },
  col:        { display: "flex", alignItems: "center", gap: 4, padding: "2px 10px" },
  colBullet:  { fontSize: 10, color: "var(--border-bright)", flexShrink: 0 },
  colName:    { fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, flex: 1 },
  colType:    { fontSize: 9, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 },
  moreCol:    { fontSize: 10, color: "var(--text-muted)", padding: "2px 10px", fontStyle: "italic" as const },
};