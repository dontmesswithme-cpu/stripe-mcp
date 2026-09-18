/**
 * @module audit/prune
 *
 * Prunes the audit log by exporting old records to CSV and reclaiming DB space.
 * Also prunes terminal approvals (`consumed`/`expired`) and terminal executions
 * (`completed`/`failed_terminal`/`cancelled`) from approvals.db with the same
 * CSV-archive treatment. Live rows are never touched: `pending`/`approved`
 * approvals and `executing`/`unknown_outcome` executions are excluded by the
 * WHERE clauses below.
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getApprovalsDb, getAuditDb } from "../utils/db.js";
import { logger } from "../utils/logger.js";

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

interface RawApprovalRow {
  readonly token: string;
  readonly request_hash: string;
  readonly tool: string;
  readonly operation: string;
  readonly status: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly requested_by: string;
  readonly risk_score: number | null;
  readonly params: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly consumed_at: string | null;
}

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

function escapeCsv(val: string | number | null): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes("\n") || str.includes("\r") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function pruneAuditLog(): void {
  try {
    const auditDb = getAuditDb();
    
    // Calculate cutoff date
    const cutoffDate = new Date(Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoffDate.toISOString();

    const oldRecords = auditDb.prepare(
      `SELECT * FROM audit_log WHERE timestamp < ?`
    ).all(cutoffIso) as RawAuditRow[];

    let prunedAudit = 0;
    let auditArchivePath: string | null = null;

    if (oldRecords.length > 0) {
      // Write to CSV
      auditArchivePath = join(config.dataDir, "audit_archive.csv");
      const auditHeader =
        "id,timestamp,tool_name,customer_id,operation_type,amount,currency,outcome,risk_score,metadata\n";
      const csvLines = oldRecords.map(row => {
        return [
          row.id,
          row.timestamp,
          row.tool_name,
          row.customer_id,
          row.operation_type,
          row.amount,
          row.currency,
          row.outcome,
          row.risk_score,
          row.metadata
        ].map(escapeCsv).join(",");
      });

      appendFileSync(
        auditArchivePath,
        (existsSync(auditArchivePath) ? "" : auditHeader) + csvLines.join("\n") + "\n",
        "utf8",
      );

      // Delete exactly the exported rows by id (crash-safe: a crash between
      // export and delete can't duplicate rows on retry).
      const auditIds = oldRecords.map((row) => row.id);
      prunedAudit = 0;
      for (let i = 0; i < auditIds.length; i += 500) {
        const chunk = auditIds.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const deleteInfo = auditDb
          .prepare(`DELETE FROM audit_log WHERE id IN (${placeholders})`)
          .run(...chunk);
        prunedAudit += Number(deleteInfo.changes);
      }

      // Reclaim disk space
      auditDb.exec(`VACUUM`);
    }

    // ── Approvals + executions (approvals.db, EXECUTION_RETENTION_DAYS window) ──
    // Terminal states only — never touch pending/approved approvals or
    // executing/unknown_outcome executions (reconciliation still needs them).
    const approvalsDb = getApprovalsDb();
    const execCutoffIso = new Date(
      Date.now() - config.executionRetentionDays * 24 * 60 * 60 * 1000
    ).toISOString();

    // Approvals: consumed/expired past retention → CSV-archive + delete.
    const oldApprovals = approvalsDb.prepare(
      `SELECT * FROM approvals WHERE status IN ('consumed','expired') AND expires_at < ?`
    ).all(execCutoffIso) as RawApprovalRow[];

    let prunedApprovals = 0;
    if (oldApprovals.length > 0) {
      const approvalsArchivePath = join(config.dataDir, "approvals_archive.csv");
      const approvalsHeader =
        "token,request_hash,tool,operation,status,created_at,expires_at,requested_by,risk_score,params,decided_at,decided_by,consumed_at\n";
      const approvalLines = oldApprovals.map(row => {
        return [
          row.token,
          row.request_hash,
          row.tool,
          row.operation,
          row.status,
          row.created_at,
          row.expires_at,
          row.requested_by,
          row.risk_score,
          row.params,
          row.decided_at,
          row.decided_by,
          row.consumed_at
        ].map(escapeCsv).join(",");
      });

      appendFileSync(
        approvalsArchivePath,
        (existsSync(approvalsArchivePath) ? "" : approvalsHeader) +
          approvalLines.join("\n") +
          "\n",
        "utf8",
      );

      // Delete exactly the exported rows by token (crash-safe).
      const approvalTokens = oldApprovals.map((row) => row.token);
      prunedApprovals = 0;
      for (let i = 0; i < approvalTokens.length; i += 500) {
        const chunk = approvalTokens.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const deleteApprovals = approvalsDb
          .prepare(`DELETE FROM approvals WHERE token IN (${placeholders})`)
          .run(...chunk);
        prunedApprovals += Number(deleteApprovals.changes);
      }
    }

    // Executions: terminal states past retention → CSV-archive + delete.
    const oldExecutions = approvalsDb.prepare(
      `SELECT * FROM executions WHERE status IN ('completed','failed_terminal','cancelled') AND completed_at < ?`
    ).all(execCutoffIso) as RawExecutionRow[];

    let prunedExecutions = 0;
    if (oldExecutions.length > 0) {
      const executionsArchivePath = join(config.dataDir, "executions_archive.csv");
      const executionsHeader =
        "execution_id,approval_token,request_hash,idempotency_key,status,worker_hostname,worker_pid,worker_uuid,started_at,completed_at,stripe_object_id,last_error,reconcile_tool,reconcile_operation,reconcile_params,last_reconcile_at,reconcile_attempts\n";
      const executionLines = oldExecutions.map(row => {
        return [
          row.execution_id,
          row.approval_token,
          row.request_hash,
          row.idempotency_key,
          row.status,
          row.worker_hostname,
          row.worker_pid,
          row.worker_uuid,
          row.started_at,
          row.completed_at,
          row.stripe_object_id,
          row.last_error,
          row.reconcile_tool,
          row.reconcile_operation,
          row.reconcile_params,
          row.last_reconcile_at,
          row.reconcile_attempts
        ].map(escapeCsv).join(",");
      });

      appendFileSync(
        executionsArchivePath,
        (existsSync(executionsArchivePath) ? "" : executionsHeader) +
          executionLines.join("\n") +
          "\n",
        "utf8",
      );

      // Delete exactly the exported rows by execution_id (crash-safe).
      const executionIds = oldExecutions.map((row) => row.execution_id);
      prunedExecutions = 0;
      for (let i = 0; i < executionIds.length; i += 500) {
        const chunk = executionIds.slice(i, i + 500);
        const placeholders = chunk.map(() => "?").join(",");
        const deleteExecutions = approvalsDb
          .prepare(`DELETE FROM executions WHERE execution_id IN (${placeholders})`)
          .run(...chunk);
        prunedExecutions += Number(deleteExecutions.changes);
      }
    }

    if (prunedApprovals > 0 || prunedExecutions > 0) {
      // Reclaim disk space
      approvalsDb.exec(`VACUUM`);
    }

    if (prunedAudit === 0 && prunedApprovals === 0 && prunedExecutions === 0) {
      return; // Nothing to prune
    }

    logger.info(
      {
        prunedRecords: prunedAudit,
        prunedApprovals,
        prunedExecutions,
        retentionDays: config.auditRetentionDays,
        executionRetentionDays: config.executionRetentionDays,
        archivePath: auditArchivePath
      },
      "Audit log pruned and vacuumed successfully"
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to prune audit log"
    );
  }
}
