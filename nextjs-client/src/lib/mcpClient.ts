const MCP_URL = process.env.NEXT_PUBLIC_MCP_SERVER_URL || "http://localhost:3001/mcp";

interface MCPRequest { method: string; params?: Record<string, unknown>; }
interface MCPResponse<T = unknown> { result?: T; error?: { code: number; message: string }; }

let sessionId: string | null = null;
let requestId = 1;
let initialized = false;

export function resetMCPSession() {
  sessionId = null;
  requestId = 1;
  initialized = false;
}

async function sendMCP<T = unknown>(request: MCPRequest): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: requestId++, method: request.method, params: request.params ?? {} });
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP_URL, { method: "POST", headers, body });
  const newSession = res.headers.get("mcp-session-id");
  if (newSession) sessionId = newSession;
  if (!res.ok) throw new Error(`MCP HTTP error ${res.status}: ${await res.text()}`);

  const contentType = res.headers.get("content-type") || "";
  let data: MCPResponse<T>;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    const last = lines[lines.length - 1]?.replace("data: ", "").trim();
    data = last ? JSON.parse(last) : { error: { code: -1, message: "Empty SSE stream" } };
  } else {
    data = await res.json();
  }

  if (data.error) throw new Error(data.error.message);
  return data.result as T;
}

export async function initializeMCP() {
  if (initialized) return;
  const result = await sendMCP({ method: "initialize", params: { 
    protocolVersion: "2024-11-05", 
    capabilities: { resources: {}, tools: {}, prompts: {} }, 
    clientInfo: { name: "pg-analyst-ui", version: "1.0.0" } 
  }});
  initialized = true;
  return result;
}
export async function listResources() {
  return sendMCP<{ resources: Array<{ uri: string; name: string }> }>({ method: "resources/list" });
}
export async function readResource(uri: string) {
  return sendMCP<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>({ method: "resources/read", params: { uri } });
}
export async function listTools() {
  return sendMCP<{ tools: Array<{ name: string; description: string }> }>({ method: "tools/list" });
}
export async function callTool(name: string, args: Record<string, unknown>) {
  return sendMCP<{ content: Array<{ type: string; text: string }> }>({ method: "tools/call", params: { name, arguments: args } });
}
export async function listPrompts() {
  return sendMCP<{ prompts: Array<{ name: string; description: string }> }>({ method: "prompts/list" });
}
export async function getPrompt(name: string, args: Record<string, string>) {
  return sendMCP<{ messages: Array<{ role: string; content: { type: string; text: string } }> }>({ method: "prompts/get", params: { name, arguments: args } });
}