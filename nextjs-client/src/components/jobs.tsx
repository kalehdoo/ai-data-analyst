"use client";
import { useAuth } from "@/lib/authContext";
import { useState, useRef, useEffect } from "react";
import { loadApiKeys } from "./Settings";

const JOBS = [
  {
    id: "infa_to_dbt",
    label: "Infa to dbt Migration",
    icon: "⟳",
    description: "Convert Informatica XML mappings to enterprise-grade dbt models",
    color: "#bc8cff",
    mcpTool: "run_infa_to_dbt",
    outputFileName: "dbt_migration.txt",
  },
  {
    id: "infa_to_airflow",
    label: "Infa to Airflow",
    icon: "✈",
    description: "Convert Informatica workflows to Apache Airflow DAGs",
    color: "#58a6ff",
    mcpTool: "run_infa_to_airflow",
    outputFileName: "airflow_dag.py",
  },
];

const MODEL_OPTIONS = [
  { id: "claude", label: "Claude Opus", color: "#e8b84b" },
  { id: "gemini", label: "Gemini 2.5",  color: "#58a6ff" },
  { id: "openai", label: "GPT-4o",      color: "#3fb950" },
];

const MAPPING_TYPES = [
  { id: "truncate_load",  label: "Truncate & Load" },
  { id: "full_refresh",   label: "Full Refresh" },
  { id: "scd_type1_dim",  label: "SCD Type 1 Dimension" },
  { id: "scd_type2_dim",  label: "SCD Type 2 Dimension" },
  { id: "fact_table",     label: "Fact Table" },
  { id: "auto",           label: "Auto Detect" },
];

export default function Jobs() {
  const { user } = useAuth();
  const [selectedJob, setSelectedJob] = useState(JOBS[0].id);
  const [xmlFile, setXmlFile] = useState<File | null>(null);
  const [xmlContent, setXmlContent] = useState("");
  const [jobName, setJobName] = useState("");
  const [mappingType, setMappingType] = useState("auto");
  const DEFAULT_INSTRUCTIONS: Record<string, string> = {
  infa_to_dbt:      "convert to dbt mapping",
  infa_to_airflow:  "convert informatica wf to airflow dag",
};

const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS[JOBS[0].id]);
  const [output, setOutput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [selectedModel, setSelectedModel] = useState("claude");
  const fileRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
  setInstructions(DEFAULT_INSTRUCTIONS[selectedJob] || "");
}, [selectedJob]);

  const job = JOBS.find((j) => j.id === selectedJob)!;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setXmlFile(file);
    const text = await file.text();
    setXmlContent(text);
    if (!jobName) setJobName(file.name.replace(".xml", "").replace(/_/g, " "));
  }

  async function runJob() {
    if (!xmlContent) { setError("Please upload an XML file first"); return; }
    if (!jobName)    { setError("Please enter a job name"); return; }

    setRunning(true);
    setError("");
    setOutput("");
    setDone(false);

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xmlContent,
          jobName,
          mappingType: mappingType === "auto" ? "" : mappingType,
          extraInstructions: instructions,
          model: selectedModel,
          mcpTool: job.mcpTool,
        }),
      });

      if (!res.ok) throw new Error(`API error: ${res.status}`);
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") { setDone(true); continue; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) {
              setOutput((prev) => {
                const next = prev + parsed.text;
                setTimeout(() => outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" }), 0);
                return next;
              });
            }
            if (parsed.error) setError(parsed.error);
          } catch (_) {}
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  function copyOutput() {
    navigator.clipboard.writeText(output);
  }

  function downloadOutput() {
    const blob = new Blob([output], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${jobName.replace(/\s+/g, "_")}_${job.outputFileName}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearAll() {
    setXmlFile(null);
    setXmlContent("");
    setOutput("");
    setError("");
    setDone(false);
    setJobName("");
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div style={s.root}>
      {/* Left sidebar */}
      <div style={s.sidebar}>
        <div style={s.sidebarTitle}>Jobs</div>
        {JOBS.map((j) => (
          <button
            key={j.id}
            onClick={() => { setSelectedJob(j.id); clearAll(); }}
            style={{
              ...s.jobBtn,
              background: selectedJob === j.id ? `${j.color}18` : "transparent",
              borderLeft: `3px solid ${selectedJob === j.id ? j.color : "transparent"}`,
              color: selectedJob === j.id ? j.color : "var(--text-secondary)",
            }}
          >
            <span style={s.jobIcon}>{j.icon}</span>
            <span style={s.jobLabel}>{j.label}</span>
          </button>
        ))}
      </div>

      {/* Right panel */}
      <div style={s.panel}>
        {/* Panel header */}
        <div style={s.panelHeader}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>{job.icon}</span>
              <h2 style={s.panelTitle}>{job.label}</h2>
            </div>
            <p style={s.panelDesc}>{job.description}</p>
          </div>
          {output && (
            <div style={s.headerActions}>
              <button onClick={copyOutput} style={s.actionBtn}>⎘ Copy</button>
              <button onClick={downloadOutput} style={{ ...s.actionBtn, ...s.downloadBtn }}>↓ Download</button>
              <button onClick={clearAll} style={s.clearBtn}>✕ Clear</button>
            </div>
          )}
        </div>

        <div style={s.body}>
          <div style={s.inputSection}>

            {/* File upload */}
            <div style={s.field}>
              <label style={s.label}>Informatica XML File</label>
              <div
                style={{
                  ...s.dropZone,
                  borderColor: xmlFile ? "var(--green)" : "var(--border-bright)",
                  background: xmlFile ? "rgba(63,185,80,0.05)" : "var(--bg-elevated)",
                }}
                onClick={() => fileRef.current?.click()}
              >
                {xmlFile ? (
                  <div style={s.fileInfo}>
                    <span style={s.fileIcon}>📄</span>
                    <div>
                      <div style={s.fileName}>{xmlFile.name}</div>
                      <div style={s.fileSize}>{(xmlFile.size / 1024).toFixed(1)} KB — {xmlContent.split("\n").length} lines</div>
                    </div>
                    <span style={s.fileCheck}>✓</span>
                  </div>
                ) : (
                  <div style={s.dropText}>
                    <span style={{ fontSize: 28, marginBottom: 8 }}>📁</span>
                    <span>Click to upload XML file</span>
                    <span style={s.dropSub}>Informatica mapping or workflow XML</span>
                  </div>
                )}
              </div>
              <input ref={fileRef} type="file" accept=".xml" style={{ display: "none" }} onChange={handleFileChange} />
            </div>

            {/* Job name */}
            <div style={s.field}>
              <label style={s.label}>{selectedJob === "infa_to_dbt" ? "dbt Job Name" : "Airflow DAG Name"}</label>
              <input
                style={s.input}
                placeholder={selectedJob === "infa_to_dbt" ? "e.g. dim_customer_migration" : "e.g. customer_etl_dag"}
                value={jobName}
                onChange={(e) => setJobName(e.target.value)}
              />
            </div>

            {/* Mapping type — dbt only */}
            {selectedJob === "infa_to_dbt" && (
              <div style={s.field}>
                <label style={s.label}>Mapping Type</label>
                <div style={s.typeGrid}>
                  {MAPPING_TYPES.map((mt) => (
                    <button
                      key={mt.id}
                      onClick={() => setMappingType(mt.id)}
                      style={{
                        ...s.typeBtn,
                        background: mappingType === mt.id ? "rgba(188,140,255,0.15)" : "var(--bg-elevated)",
                        borderTop:    `1px solid ${mappingType === mt.id ? "#bc8cff" : "var(--border-bright)"}`,
                        borderRight:  `1px solid ${mappingType === mt.id ? "#bc8cff" : "var(--border-bright)"}`,
                        borderBottom: `1px solid ${mappingType === mt.id ? "#bc8cff" : "var(--border-bright)"}`,
                        borderLeft:   `1px solid ${mappingType === mt.id ? "#bc8cff" : "var(--border-bright)"}`,
                        color: mappingType === mt.id ? "#bc8cff" : "var(--text-secondary)",
                        fontWeight: mappingType === mt.id ? 600 : 400,
                      }}
                    >
                      {mt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Instructions */}
            <div style={s.field}>
              <label style={s.label}>Instructions</label>
              <textarea
                style={s.textarea}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={2}
              />
            </div>

            {/* Model selector */}
            <div style={s.field}>
              <label style={s.label}>AI Model</label>
              <div style={{ display: "flex", gap: 8 }}>
                {MODEL_OPTIONS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setSelectedModel(m.id)}
                    style={{
                      ...s.typeBtn,
                      background: selectedModel === m.id ? `${m.color}22` : "var(--bg-elevated)",
                      borderTop:    `1px solid ${selectedModel === m.id ? m.color : "var(--border-bright)"}`,
                      borderRight:  `1px solid ${selectedModel === m.id ? m.color : "var(--border-bright)"}`,
                      borderBottom: `1px solid ${selectedModel === m.id ? m.color : "var(--border-bright)"}`,
                      borderLeft:   `1px solid ${selectedModel === m.id ? m.color : "var(--border-bright)"}`,
                      color: selectedModel === m.id ? m.color : "var(--text-secondary)",
                      fontWeight: selectedModel === m.id ? 600 : 400,
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {error && <div style={s.error}>{error}</div>}

            <button
              onClick={runJob}
              disabled={running || !xmlContent || !jobName}
              style={{
                ...s.runBtn,
                background: job.color,
                opacity: running || !xmlContent || !jobName ? 0.5 : 1,
                cursor: running || !xmlContent || !jobName ? "not-allowed" : "pointer",
              }}
            >
              {running ? `⟳ Generating ${job.label}…` : `▶ Run ${job.label}`}
            </button>
          </div>

          {/* Output section */}
          {(output || running) && (
            <div style={s.outputSection}>
              <div style={s.outputHeader}>
                <span style={s.outputTitle}>
                  {done ? `✓ ${job.label} Complete` : "⟳ Generating…"}
                </span>
                {done && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={copyOutput} style={s.actionBtn}>⎘ Copy</button>
                    <button onClick={downloadOutput} style={{ ...s.actionBtn, ...s.downloadBtn }}>↓ Download</button>
                  </div>
                )}
              </div>
              <div ref={outputRef} style={s.output}>
                <pre style={s.outputPre}>{output}</pre>
                {running && <span style={s.cursor}>▋</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root:          { display: "flex", height: "100%", overflow: "hidden" },
  sidebar:       { width: 220, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", padding: "16px 0", flexShrink: 0, background: "var(--bg-elevated)" },
  sidebarTitle:  { fontSize: 10, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "1px", padding: "0 16px 12px", fontFamily: "var(--font-mono)" },
  jobBtn:        { display: "flex", alignItems: "center", gap: 10, padding: "10px 16px", background: "none", border: "none", borderLeft: "3px solid transparent", cursor: "pointer", textAlign: "left", width: "100%", transition: "all 0.15s" },
  jobIcon:       { fontSize: 16, flexShrink: 0 },
  jobLabel:      { fontSize: 13, fontWeight: 500, lineHeight: 1.3 },
  panel:         { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  panelHeader:   { padding: "20px 28px 16px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexShrink: 0 },
  panelTitle:    { fontSize: 16, fontWeight: 600, color: "var(--text-primary)", margin: 0 },
  panelDesc:     { fontSize: 12, color: "var(--text-secondary)", marginTop: 4 },
  headerActions: { display: "flex", gap: 8, alignItems: "center" },
  body:          { flex: 1, overflow: "auto", padding: "20px 28px", display: "flex", flexDirection: "column", gap: 20 },
  inputSection:  { display: "flex", flexDirection: "column", gap: 16, maxWidth: 680 },
  field:         { display: "flex", flexDirection: "column", gap: 6 },
  label:         { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  dropZone:      { border: "2px dashed", borderRadius: "var(--radius)", padding: "20px", cursor: "pointer", transition: "all 0.2s", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 90 },
  dropText:      { display: "flex", flexDirection: "column", alignItems: "center", color: "var(--text-muted)", fontSize: 13, gap: 4 },
  dropSub:       { fontSize: 11, color: "var(--text-muted)" },
  fileInfo:      { display: "flex", alignItems: "center", gap: 12, width: "100%" },
  fileIcon:      { fontSize: 24 },
  fileName:      { fontSize: 13, fontWeight: 600, color: "var(--text-primary)", fontFamily: "var(--font-mono)" },
  fileSize:      { fontSize: 11, color: "var(--text-muted)", marginTop: 2 },
  fileCheck:     { marginLeft: "auto", fontSize: 18, color: "var(--green)" },
  input:         { background: "var(--bg-elevated)", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "8px 12px", borderRadius: "var(--radius)", fontSize: 13, outline: "none", fontFamily: "var(--font-mono)" },
  typeGrid:      { display: "flex", flexWrap: "wrap", gap: 8 },
  typeBtn:       { padding: "6px 14px", borderRadius: 99, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)", transition: "all 0.15s" },
  textarea:      { background: "var(--bg-elevated)", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-primary)", padding: "8px 12px", borderRadius: "var(--radius)", fontSize: 13, outline: "none", resize: "vertical" as const, fontFamily: "var(--font-mono)" },
  runBtn:        { color: "#000", border: "none", padding: "10px 24px", borderRadius: "var(--radius)", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-mono)", alignSelf: "flex-start", transition: "all 0.15s" },
  error:         { padding: "10px 14px", background: "var(--red-dim)", color: "var(--red)", borderRadius: "var(--radius)", border: "1px solid var(--red)", fontSize: 12 },
  outputSection: { display: "flex", flexDirection: "column", borderRadius: "var(--radius)", overflow: "hidden", border: "1px solid var(--border-bright)" },
  outputHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border)" },
  outputTitle:   { fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" },
  output:        { maxHeight: 600, overflow: "auto", background: "var(--bg)", padding: "16px", position: "relative" as const },
  outputPre:     { margin: 0, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-primary)", whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const, lineHeight: 1.6 },
  cursor:        { display: "inline-block", animation: "pulse 1s infinite", color: "#bc8cff", fontSize: 14 },
  actionBtn:     { background: "none", borderTop: "1px solid var(--border-bright)", borderRight: "1px solid var(--border-bright)", borderBottom: "1px solid var(--border-bright)", borderLeft: "1px solid var(--border-bright)", color: "var(--text-secondary)", padding: "5px 12px", borderRadius: "var(--radius)", fontSize: 12, cursor: "pointer", fontFamily: "var(--font-mono)" },
  downloadBtn:   { color: "#bc8cff", borderTop: "1px solid #bc8cff", borderRight: "1px solid #bc8cff", borderBottom: "1px solid #bc8cff", borderLeft: "1px solid #bc8cff" },
  clearBtn:      { background: "none", border: "none", color: "var(--text-muted)", padding: "5px 8px", fontSize: 12, cursor: "pointer" },
};
