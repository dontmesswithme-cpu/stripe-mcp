/**
 * @module execution/store
 *
 * SQLite-backed execution record CRUD.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getApprovalsDb } from "../utils/db.js";
import { config } from "../config.js";
import { consumeApprovalInTransaction, type ConsumeApprovalFailure } from "../approval/store.js";
import type {
  ExecutionRecord,
  ExecutionReconcileContext,
  ExecutionStatus,
} from "../types.js";

interface RawExecutionRow {
  readonly execution_id: string;
  readonly approval_token: string | null;
  readonly request_hash: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly worker_hostname: string;
  readonly worker_pid: number;
  readonly worker_uuid: string;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly stripe_object_id: string | null;
  readonly last_error: string | null;
  readonly reconcile_tool: string;
  readonly reconcile_operation: string;
  readonly reconcile_params: string;
  readonly last_reconcile_at: string | null;
  readonly reconcile_attempts: number;
}

export type BeginExecutionFailureReason =
  | ConsumeApprovalFailure
  | "duplicate_in_flight";

export type BeginExecutionResult =
  | { readonly ok: true; readonly executionId: string }
  | { readonly ok: false; readonly reason: BeginExecutionFailureReason };

export function createExecution(
  approvalToken: string | null,
  requestHash: string,
  idempotencyKey: string,
  workerId: { hostname: string; pid: number; uuid: string },
  reconcile: ExecutionReconcileContext,
  db?: Database.Database,
): ExecutionRecord {
  const database = db ?? getApprovalsDb();
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();

  database.prepare(
    `INSERT INTO executions
       (execution_id, approval_token, request_hash, idempotency_key, status,
        worker_hostname, worker_pid, worker_uuid, started_at,
        reconcile_tool, reconcile_operation, reconcile_params)
     VALUES (?, ?, ?, ?, 'executing', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    executionId,
    approvalToken,
    requestHash,
    idempotencyKey,
    workerId.hostname,
    workerId.pid,
    workerId.uuid,
    startedAt,
    reconcile.tool,
    reconcile.operation,
    JSON.stringify(reconcile.params),
  );

  return {
    executionId,
    approvalToken,
    requestHash,
    idempotencyKey,
    status: "executing",
    workerHostname: workerId.hostname,
    workerPid: workerId.pid,
    workerUuid: workerId.uuid,
    startedAt,
    completedAt: null,
    stripeObjectId: null,
    lastError: null,
    reconcileTool: reconcile.tool,
    reconcileOperation: reconcile.operation,
    reconcileParams: reconcile.params,
    lastReconcileAt: null,
    reconcileAttempts: 0,
  };
}

/**
 * Atomically consume approval (if any) and insert execution row.
 */
export function beginExecution(
  approvalToken: string | null,
  requestHash: string,
  idempotencyKey: string,
  workerId: { hostname: string; pid: number; uuid: string },
  reconcile: ExecutionReconcileContext,
): BeginExecutionResult {
  const db = getApprovalsDb();

  const inFlight = db
    .prepare(
      `SELECT execution_id FROM executions
       WHERE idempotency_key = ? AND status = 'executing'`,
    )
    .get(idempotencyKey) as { execution_id: string } | undefined;

  if (inFlight !== undefined) {
    return { ok: false, reason: "duplicate_in_flight" };
  }

  try {
    return db.transaction(() => {
      if (approvalToken !== null) {
        const consumed = consumeApprovalInTransaction(
          approvalToken,
          requestHash,
          db,
        );
        if (!consumed.ok) {
          return { ok: false as const, reason: consumed.reason };
        }
      }

      const execution = createExecution(
        approvalToken,
        requestHash,
        idempotencyKey,
        workerId,
        reconcile,
        db,
      );
      return { ok: true as const, executionId: execution.executionId };
    })();
  } catch (error: unknown) {
    if (isSqliteUniqueConstraint(error)) {
      return { ok: false, reason: "duplicate_in_flight" };
    }
    throw error;
  }
}

function isSqliteUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

export function getExecution(executionId: string): ExecutionRecord | null {
  const db = getApprovalsDb();
  const row = db
    .prepare("SELECT * FROM executions WHERE execution_id = ?")
    .get(executionId) as RawExecutionRow | undefined;

  if (!row) return null;
  return parseExecutionRow(row);
}

export function updateExecutionStatus(
  executionId: string,
  status: ExecutionStatus,
  metadata?: {
    stripeObjectId?: string | null;
    lastError?: Record<string, unknown> | null;
  },
): void {
  const db = getApprovalsDb();
  const completedAt = ["completed", "failed_terminal", "cancelled"].includes(status)
    ? new Date().toISOString()
    : null;

  db.prepare(
    `UPDATE executions
     SET status = ?,
         completed_at = COALESCE(completed_at, ?),
         stripe_object_id = COALESCE(?, stripe_object_id),
         last_error = COALESCE(?, last_error)
     WHERE execution_id = ?`,
  ).run(
    status,
    completedAt,
    metadata?.stripeObjectId ?? null,
    metadata?.lastError ? JSON.stringify(metadata.lastError) : null,
    executionId,
  );
}

export function recordReconcileAttempt(executionId: string): void {
  const db = getApprovalsDb();
  db.prepare(
    `UPDATE executions
     SET last_reconcile_at = ?, reconcile_attempts = reconcile_attempts + 1
     WHERE execution_id = ?`,
  ).run(new Date().toISOString(), executionId);
}

export function findUnknownOutcomes(): ExecutionRecord[] {
  const db = getApprovalsDb();
  const rows = db
    .prepare(`SELECT * FROM executions WHERE status = 'unknown_outcome'`)
    .all() as RawExecutionRow[];
  return rows.map(parseExecutionRow);
}

/**
 * Mark stale in-flight executions as unknown (crash / hung worker).
 */
export function sweepStaleExecutions(): number {
  const db = getApprovalsDb();
  const cutoff = new Date(
    Date.now() - config.executionStaleMinutes * 60_000,
  ).toISOString();

  const result = db.prepare(
    `UPDATE executions
     SET status = 'unknown_outcome', completed_at = COALESCE(completed_at, ?)
     WHERE status = 'executing' AND started_at < ?`,
  ).run(new Date().toISOString(), cutoff);

  return result.changes;
}

function parseExecutionRow(row: RawExecutionRow): ExecutionRecord {
  return {
    executionId: row.execution_id,
    approvalToken: row.approval_token,
    requestHash: row.request_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status as ExecutionStatus,
    workerHostname: row.worker_hostname,
    workerPid: row.worker_pid,
    workerUuid: row.worker_uuid,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    stripeObjectId: row.stripe_object_id,
    lastError: row.last_error ? JSON.parse(row.last_error) : null,
    reconcileTool: row.reconcile_tool ?? "",
    reconcileOperation: (row.reconcile_operation ?? "create") as ExecutionRecord["reconcileOperation"],
    reconcileParams: row.reconcile_params
      ? (JSON.parse(row.reconcile_params) as Record<string, unknown>)
      : {},
    lastReconcileAt: row.last_reconcile_at ?? null,
    reconcileAttempts: row.reconcile_attempts ?? 0,
  };
}
