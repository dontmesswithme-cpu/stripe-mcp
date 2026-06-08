/**
 * @module audit/prune
 *
 * Prunes the audit log by exporting old records to CSV and reclaiming DB space.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { getAuditDb } from "../utils/db.js";
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

function escapeCsv(val: string | number | null): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes("\\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function pruneAuditLog(): void {
  try {
    const db = getAuditDb();
    
    // Calculate cutoff date
    const cutoffDate = new Date(Date.now() - config.auditRetentionDays * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoffDate.toISOString();

    const oldRecords = db.prepare(
      `SELECT * FROM audit_log WHERE timestamp < ?`
    ).all(cutoffIso) as RawAuditRow[];

    if (oldRecords.length === 0) {
      return; // Nothing to prune
    }

    // Write to CSV
    const archivePath = join(config.dataDir, "audit_archive.csv");
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

    appendFileSync(archivePath, csvLines.join("\n") + "\n", "utf8");

    // Delete exported records
    const deleteInfo = db.prepare(
      `DELETE FROM audit_log WHERE timestamp < ?`
    ).run(cutoffIso);

    // Reclaim disk space
    db.exec(`VACUUM`);

    logger.info(
      {
        prunedRecords: deleteInfo.changes,
        retentionDays: config.auditRetentionDays,
        archivePath
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
