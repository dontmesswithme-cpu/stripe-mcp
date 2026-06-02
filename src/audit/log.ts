/**
 * @module audit/log
 *
 * SQLite-backed audit log for all mutating Stripe operations.
 *
 * Every mutation that flows through the middleware pipeline writes an
 * audit entry — before the operation resolves (for blocked/dry-run
 * outcomes) and after (for success/error outcomes).
 *
 * The {@link queryAuditLog} function supports filtered, paginated
 * reads and powers the `get_audit_log` MCP tool.
 */

import { getAuditDb } from "../utils/db.js";
import type { AuditEntry, AuditFilters, OperationContext } from "../types.js";

// ── Raw row shape from SQLite ───────────────────────────────────────

interface RawAuditRow {
  readonly id: number;
  readonly timestamp: string;
  readonly tool_name: string;
  readonly customer_id: string | null;
  readonly operation_type: string;
  readonly amount: number | null;
  readonly currency: string | null;
  readonly outcome: string;
  readonly risk_score: number | null;
  readonly metadata: string;
}

// ── Write ───────────────────────────────────────────────────────────

/**
 * Write an audit entry for a mutation.
 *
 * @description Synchronous SQLite insert — returns in microseconds.
 *   Called by the middleware pipeline for every outcome (success, error,
 *   blocked, dry_run, pending_approval).
 * @param context - The operation context from the tool handler.
 * @param outcome - What happened to the operation.
 * @param riskScore - Risk score if computed, otherwise `null`.
 * @param metadata - Arbitrary JSON metadata (params, error details, etc.).
 */
export function writeAuditEntry(
  context: OperationContext,
  outcome: AuditEntry["outcome"],
  riskScore: number | null,
  metadata: Record<string, unknown>,
): void {
  try {
    const db = getAuditDb();

    db.prepare(
      `INSERT INTO audit_log
         (tool_name, customer_id, operation_type, amount, currency, outcome, risk_score, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      context.capability.tool,
      context.customerId ?? null,
      context.capability.operation,
      context.amount ?? null,
      context.currency ?? null,
      outcome,
      riskScore,
      JSON.stringify(metadata),
    );
  } catch (error) {
    console.error(`stripe-mcp CRITICAL: Failed to write audit log.`, error);
  }
}

// ── Read ────────────────────────────────────────────────────────────

/**
 * Query the audit log with optional filters and pagination.
 *
 * @description Builds a parameterized WHERE clause from the provided
 *   filters. Results are ordered by timestamp descending (newest first).
 *   Maximum limit is 500 (enforced by the Zod schema); default is 50.
 * @param filters - Optional filters for customer, tool, operation,
 *   outcome, date range, and limit.
 * @returns Array of {@link AuditEntry} objects.
 */
export function queryAuditLog(filters: AuditFilters): AuditEntry[] {
  const db = getAuditDb();

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.customerId !== undefined) {
    conditions.push("customer_id = ?");
    params.push(filters.customerId);
  }
  if (filters.toolName !== undefined) {
    conditions.push("tool_name = ?");
    params.push(filters.toolName);
  }
  if (filters.operationType !== undefined) {
    conditions.push("operation_type = ?");
    params.push(filters.operationType);
  }
  if (filters.outcome !== undefined) {
    conditions.push("outcome = ?");
    params.push(filters.outcome);
  }
  if (filters.startDate !== undefined) {
    conditions.push("timestamp >= ?");
    params.push(filters.startDate);
  }
  if (filters.endDate !== undefined) {
    conditions.push("timestamp <= ?");
    params.push(filters.endDate);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;

  const rows = db
    .prepare(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(...params, limit) as RawAuditRow[];

  return rows.map(parseAuditRow);
}

/**
 * Count operations matching a filter — used by the risk engine for
 * velocity checks.
 *
 * @param customerId - Customer to scope the count to.
 * @param operationType - Operation type to count.
 * @param since - ISO 8601 timestamp — only count entries after this time.
 * @returns The count of matching audit entries with outcome = 'success'.
 */
export function countRecentOperations(
  customerId: string,
  operationType: string,
  since: string,
): number {
  const db = getAuditDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM audit_log
       WHERE customer_id = ? AND operation_type = ? AND outcome = 'success' AND timestamp > ?`,
    )
    .get(customerId, operationType, since) as { cnt: number };
  return row.cnt;
}

// ── Internal ────────────────────────────────────────────────────────

/** Convert a raw SQLite row to a typed {@link AuditEntry}. */
function parseAuditRow(row: RawAuditRow): AuditEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    toolName: row.tool_name,
    customerId: row.customer_id,
    operationType: row.operation_type as AuditEntry["operationType"],
    amount: row.amount,
    currency: row.currency,
    outcome: row.outcome as AuditEntry["outcome"],
    riskScore: row.risk_score,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}
