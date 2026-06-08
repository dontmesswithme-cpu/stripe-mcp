import { runDbOp } from "../worker/db/db.client.js";
import type { AuditEntry, AuditFilters, OperationContext } from "../types.js";

export async function writeAuditEntry(
  context: OperationContext,
  outcome: AuditEntry["outcome"],
  riskScore: number | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  return runDbOp("writeAuditEntry", context, outcome, riskScore, metadata);
}

export async function queryAuditLog(filters: AuditFilters): Promise<AuditEntry[]> {
  return runDbOp("queryAuditLog", filters);
}

export async function countRecentOperations(
  customerId: string,
  operationType: string,
  since: string,
): Promise<number> {
  return runDbOp("countRecentOperations", customerId, operationType, since);
}
