/**
 * @module utils/db
 *
 * SQLite connection factory and schema migration.
 *
 * Uses `better-sqlite3` for synchronous, high-performance single-row
 * operations. WAL mode is enabled for concurrent read/write access.
 *
 * Two databases are managed:
 * - `audit.db`     — append-only operation audit log
 * - `approvals.db` — approval token lifecycle
 *
 * Both are lazily initialized on first access and migrated automatically.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

// ── Singleton connections ───────────────────────────────────────────

let auditDb: Database.Database | null = null;
let approvalsDb: Database.Database | null = null;

// ── Internal helpers ────────────────────────────────────────────────

/** Ensure the data directory exists (recursive mkdir). */
function ensureDataDir(): void {
  mkdirSync(config.dataDir, { recursive: true });
}

/**
 * Open a SQLite database at `<dataDir>/<filename>` with WAL mode
 * and foreign key enforcement.
 */
function openDatabase(filename: string): Database.Database {
  ensureDataDir();
  const dbPath = resolve(config.dataDir, filename);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

// ── Audit DB schema ─────────────────────────────────────────────────

const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  tool_name       TEXT    NOT NULL,
  customer_id     TEXT,
  operation_type  TEXT    NOT NULL,
  amount          INTEGER,
  currency        TEXT,
  outcome         TEXT    NOT NULL CHECK (outcome IN ('success', 'error', 'blocked', 'dry_run', 'pending_approval')),
  risk_score      INTEGER,
  metadata        TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_customer_id  ON audit_log (customer_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp    ON audit_log (timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_outcome      ON audit_log (outcome);
CREATE INDEX IF NOT EXISTS idx_audit_tool_name    ON audit_log (tool_name);
`;

// ── Approvals DB schema ─────────────────────────────────────────────

const APPROVALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  token           TEXT    PRIMARY KEY,
  tool            TEXT    NOT NULL,
  operation       TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at      TEXT    NOT NULL,
  requested_by    TEXT    NOT NULL DEFAULT 'mcp-agent',
  risk_score      INTEGER NOT NULL DEFAULT 0,
  params          TEXT    NOT NULL DEFAULT '{}',
  decided_at      TEXT,
  decided_by      TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);
`;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get the audit database connection (lazy init + migration).
 * The returned database uses WAL mode and is safe for concurrent reads.
 */
export function getAuditDb(): Database.Database {
  if (auditDb === null) {
    auditDb = openDatabase("audit.db");
    auditDb.exec(AUDIT_SCHEMA);
  }
  return auditDb;
}

/**
 * Get the approvals database connection (lazy init + migration).
 * The returned database uses WAL mode and is safe for concurrent reads.
 */
export function getApprovalsDb(): Database.Database {
  if (approvalsDb === null) {
    approvalsDb = openDatabase("approvals.db");
    approvalsDb.exec(APPROVALS_SCHEMA);
  }
  return approvalsDb;
}

/**
 * Close all open database connections. Call during graceful shutdown
 * to flush WAL and release file handles.
 */
export function closeAllDatabases(): void {
  if (auditDb !== null) {
    auditDb.close();
    auditDb = null;
  }
  if (approvalsDb !== null) {
    approvalsDb.close();
    approvalsDb = null;
  }
}
