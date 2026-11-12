// AuditRun is the admin-only engine-validation research log. The research
// functions write it with the service role, which bypasses the entity's own
// row-level security, so the trust boundary is enforced here: only an admin may
// run a mode that writes an audit record, and free-text request input is
// bounded before it lands in the shared log.
export const AUDIT_LABEL_MAX = 300;

export function canWriteAuditLog(user) {
  return Boolean(user && user.role === "admin");
}

export function auditLabel(text) {
  return String(text || "").slice(0, AUDIT_LABEL_MAX);
}