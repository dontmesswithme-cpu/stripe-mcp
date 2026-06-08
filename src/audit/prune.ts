import { runDbOp } from "../worker/db/db.client.js";

export async function pruneAuditLog(): Promise<void> {
  return runDbOp("pruneAuditLog");
}
