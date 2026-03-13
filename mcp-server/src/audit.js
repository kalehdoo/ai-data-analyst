import { Database } from "@sqlitecloud/drivers";

let auditDb = null;

function getDb() {
  if (!auditDb) {
    auditDb = new Database(process.env.SQLITE_CLOUD_URL);
  }
  return auditDb;
}

export async function logAudit({
  username = "unknown",
  role = "unknown",
  action_type = "unknown",
  details = null,
  model = null,
  context_mode = null,
  duration_ms = null,
  row_count = null,
  status = "success",
  error_msg = null,
}) {
  try {
    const db = getDb();
    await db.sql`
      INSERT INTO audit_logs 
        (username, role, action_type, details, model, context_mode, duration_ms, row_count, status, error_msg)
      VALUES 
        (${username}, ${role}, ${action_type}, ${details}, ${model}, ${context_mode}, ${duration_ms}, ${row_count}, ${status}, ${error_msg})
    `;
  } catch (e) {
    // Never let audit logging break the main flow
    console.warn("Audit log failed:", e.message);
  }
}