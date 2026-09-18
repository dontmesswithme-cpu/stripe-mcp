import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDbOp } from "../worker/db/db.client.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { AuditEntry, AuditFilters, OperationContext } from "../types.js";

/**
 * Write an audit entry via the DB worker.
 *
 * @description Never throws and never rejects: audit is best-effort per
 *   README (mutations still succeed if the audit DB is down). If the
 *   worker IPC call itself fails (worker crash / timeout), the entry is
 *   preserved to `<dataDir>/audit-fallback.log` as JSON-lines. DB-layer
 *   failures inside the worker are handled by `log.worker.ts`, which
 *   performs the same fallback before resolving.
 */
export async function writeAuditEntry(
  context: OperationContext,
  outcome: AuditEntry["outcome"],
  riskScore: number | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await runDbOp("writeAuditEntry", context, outcome, riskScore, metadata);
  } catch (error) {
    logger.fatal(
      { error: error instanceof Error ? error.message : String(error) },
      "stripe-mcp CRITICAL: Failed to write audit log (DB worker)",
    );
    persistAuditFallback(context, outcome, riskScore, metadata, error);
  }
}

/**
 * Append a JSON-lines record to `<dataDir>/audit-fallback.log`.
 * Never throws — all I/O and serialization errors are swallowed.
 */
function persistAuditFallback(
  context: OperationContext,
  outcome: AuditEntry["outcome"],
  riskScore: number | null,
  metadata: Record<string, unknown>,
  dbError: unknown,
): void {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    let line: string;
    try {
      line = JSON.stringify({
        fallback: true,
        timestamp: new Date().toISOString(),
        tool_name: context.capability.tool,
        customer_id: context.customerId ?? null,
        operation_type: context.capability.operation,
        amount: context.amount ?? null,
        currency: context.currency ?? null,
        outcome,
        risk_score: riskScore,
        metadata,
        audit_error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    } catch {
      line = JSON.stringify({
        fallback: true,
        timestamp: new Date().toISOString(),
        tool_name: context.capability.tool,
        customer_id: context.customerId ?? null,
        operation_type: context.capability.operation,
        amount: context.amount ?? null,
        currency: context.currency ?? null,
        outcome,
        risk_score: riskScore,
        metadata: "[unserializable]",
        audit_error: dbError instanceof Error ? dbError.message : String(dbError),
      });
    }
    appendFileSync(join(config.dataDir, "audit-fallback.log"), `${line}\n`, "utf8");
  } catch {
    // Intentionally swallowed — writeAuditEntry must never throw.
  }
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
