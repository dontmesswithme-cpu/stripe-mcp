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

const APPROVALS_SCHEMA_V9 = `
CREATE TABLE IF NOT EXISTS approvals (
  token                   TEXT    PRIMARY KEY,
  request_hash            TEXT    NOT NULL,
  tool                    TEXT    NOT NULL,
  operation               TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at              TEXT    NOT NULL,
  requested_by            TEXT    NOT NULL DEFAULT 'mcp-agent',
  risk_score              INTEGER NOT NULL DEFAULT 0,
  params                  TEXT    NOT NULL DEFAULT '{}',
  decided_at              TEXT,
  decided_by              TEXT,
  consumed_at             TEXT
);

CREATE TABLE IF NOT EXISTS executions (
  execution_id            TEXT    PRIMARY KEY,
  approval_token          TEXT,
  request_hash            TEXT    NOT NULL,
  idempotency_key         TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'executing'
                                  CHECK (status IN ('executing', 'unknown_outcome', 'completed', 'failed_terminal', 'cancelled')),
  worker_hostname         TEXT    NOT NULL,
  worker_pid              INTEGER NOT NULL,
  worker_uuid             TEXT    NOT NULL,
  started_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at            TEXT,
  stripe_object_id        TEXT,
  last_error              TEXT,
  reconcile_tool          TEXT    NOT NULL DEFAULT '',
  reconcile_operation     TEXT    NOT NULL DEFAULT 'create',
  reconcile_params        TEXT    NOT NULL DEFAULT '{}',
  last_reconcile_at       TEXT,
  reconcile_attempts      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);
CREATE INDEX IF NOT EXISTS idx_executions_status    ON executions (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idemp_key ON executions (idempotency_key);
`;

// ── Migration locking (multi-process safe) ──────────────────────────

function withExclusiveMigrationLock<T>(db: Database.Database, migrate: () => T): T {
  db.pragma("busy_timeout = 30000");
  db.pragma("locking_mode = EXCLUSIVE");
  // Force immediate lock acquisition to prevent deadlocks
  db.exec("BEGIN EXCLUSIVE; COMMIT;");
  try {
    return migrate();
  } finally {
    db.pragma("locking_mode = NORMAL");
  }
}

function runApprovalsMigrations(db: Database.Database): void {
  let userVersion = db.pragma("user_version", { simple: true }) as number;

    if (userVersion === 0) {
      // If table exists but user_version is 0, it means it's the unversioned V1 schema.
      // We check if the table actually exists.
      const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approvals'").get();
      
      if (!tableExists) {
        db.exec(APPROVALS_SCHEMA_V9);
        db.pragma("user_version = 9");
        userVersion = 9;
      } else {
        // Table exists, treat as V1
        userVersion = 1;
      }
    }

    if (userVersion === 1) {
      // Migrate V1 -> V2
      db.exec(`
        BEGIN TRANSACTION;
        
        CREATE TABLE approvals_new (
          token           TEXT    PRIMARY KEY,
          request_hash    TEXT    NOT NULL DEFAULT '',
          tool            TEXT    NOT NULL,
          operation       TEXT    NOT NULL,
          status          TEXT    NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executing', 'completed', 'failed')),
          created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          expires_at      TEXT    NOT NULL,
          requested_by    TEXT    NOT NULL DEFAULT 'mcp-agent',
          risk_score      INTEGER NOT NULL DEFAULT 0,
          params          TEXT    NOT NULL DEFAULT '{}',
          decided_at      TEXT,
          decided_by      TEXT,
          consumed_at     TEXT
        );

        INSERT INTO approvals_new (token, tool, operation, status, created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by)
        SELECT token, tool, operation, status, created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by 
        FROM approvals;

        -- We ignore moving consumed_at since we can safely drop it or just leave it NULL in the new table 
        -- (the ALTER TABLE trick in V1 might not have run on all DBs, so SELECT consumed_at might fail).

        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
        
        CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
        CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);

        PRAGMA user_version = 2;
        COMMIT;
      `);
      userVersion = 2;
    }

    if (userVersion === 2) {
      // Migrate V2 -> V3
      db.exec(`
        BEGIN TRANSACTION;
        
        CREATE TABLE approvals_new (
          token                 TEXT    PRIMARY KEY,
          request_hash          TEXT    NOT NULL DEFAULT '',
          idempotency_key       TEXT    NOT NULL DEFAULT '',
          execution_node        TEXT,
          execution_started_at  TEXT,
          tool                  TEXT    NOT NULL,
          operation             TEXT    NOT NULL,
          status                TEXT    NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executing', 'completed', 'failed', 'stuck')),
          created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          expires_at            TEXT    NOT NULL,
          requested_by          TEXT    NOT NULL DEFAULT 'mcp-agent',
          risk_score            INTEGER NOT NULL DEFAULT 0,
          params                TEXT    NOT NULL DEFAULT '{}',
          decided_at            TEXT,
          decided_by            TEXT,
          consumed_at           TEXT
        );

        INSERT INTO approvals_new (token, request_hash, tool, operation, status, created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at)
        SELECT token, request_hash, tool, operation, status, created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at 
        FROM approvals;

        -- Extract idempotency_key from JSON params using JSON1 extension built into SQLite
        UPDATE approvals_new
        SET idempotency_key = COALESCE(json_extract(params, '$.idempotency_key'), '');

        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
        
        CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
        CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_idemp_key  ON approvals (idempotency_key);

        PRAGMA user_version = 3;
        COMMIT;
      `);
      userVersion = 3;
    }

    if (userVersion === 3) {
      // Migrate V3 -> V4
      db.exec(`
        BEGIN TRANSACTION;
        
        CREATE TABLE approvals_new (
          token                 TEXT    PRIMARY KEY,
          request_hash          TEXT    NOT NULL DEFAULT '',
          idempotency_key       TEXT    NOT NULL DEFAULT '',
          execution_node        TEXT,
          execution_started_at  TEXT,
          execution_expires_at  TEXT,
          tool                  TEXT    NOT NULL,
          operation             TEXT    NOT NULL,
          status                TEXT    NOT NULL DEFAULT 'pending'
                                        CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executing', 'completed', 'failed', 'reconciling')),
          created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          expires_at            TEXT    NOT NULL,
          requested_by          TEXT    NOT NULL DEFAULT 'mcp-agent',
          risk_score            INTEGER NOT NULL DEFAULT 0,
          params                TEXT    NOT NULL DEFAULT '{}',
          decided_at            TEXT,
          decided_by            TEXT,
          consumed_at           TEXT
        );

        INSERT INTO approvals_new (token, request_hash, idempotency_key, execution_node, execution_started_at, tool, operation, status, created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at)
        SELECT token, request_hash, idempotency_key, execution_node, execution_started_at, tool, operation, 
               CASE WHEN status = 'stuck' THEN 'failed' ELSE status END, 
               created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at 
        FROM approvals;

        -- Invalidate legacy approvals with empty request_hash
        UPDATE approvals_new
        SET status = 'expired'
        WHERE request_hash = '' AND status = 'pending';

        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
        
        CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
        CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_idemp_key  ON approvals (idempotency_key);

        PRAGMA user_version = 4;
        COMMIT;
      `);
      userVersion = 4;
    }

    if (userVersion === 4) {
      // Migrate V4 -> V5
      db.exec(`
        BEGIN TRANSACTION;
        
        CREATE TABLE approvals_new (
          token                   TEXT    PRIMARY KEY,
          request_hash            TEXT    NOT NULL DEFAULT '',
          idempotency_key         TEXT    NOT NULL DEFAULT '',
          execution_worker_hostname TEXT,
          execution_worker_pid      INTEGER,
          execution_worker_uuid     TEXT,
          execution_started_at    TEXT,
          execution_expires_at    TEXT,
          tool                    TEXT    NOT NULL,
          operation               TEXT    NOT NULL,
          status                  TEXT    NOT NULL DEFAULT 'pending'
                                          CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executing', 'unknown_outcome', 'completed', 'failed_terminal', 'cancelled')),
          created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          expires_at              TEXT    NOT NULL,
          requested_by            TEXT    NOT NULL DEFAULT 'mcp-agent',
          risk_score              INTEGER NOT NULL DEFAULT 0,
          params                  TEXT    NOT NULL DEFAULT '{}',
          decided_at              TEXT,
          decided_by              TEXT,
          consumed_at             TEXT
        );

        INSERT INTO approvals_new (
          token, request_hash, idempotency_key, 
          execution_worker_hostname, execution_worker_pid, execution_worker_uuid,
          execution_started_at, execution_expires_at, 
          tool, operation, status, 
          created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at
        )
        SELECT 
          token, request_hash, idempotency_key, 
          NULL, NULL, NULL, -- drop old execution_node
          execution_started_at, execution_expires_at, 
          tool, operation, 
          CASE 
            WHEN status = 'failed' THEN 'failed_terminal' 
            WHEN status = 'reconciling' THEN 'unknown_outcome' 
            ELSE status 
          END, 
          created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at 
        FROM approvals;

        -- Invalidate legacy approvals with empty request_hash (in case V4 didn't catch them)
        UPDATE approvals_new
        SET status = 'expired'
        WHERE request_hash = '' AND status = 'pending';

        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
        
        CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
        CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);
        CREATE INDEX IF NOT EXISTS idx_approvals_idemp_key  ON approvals (idempotency_key);

        PRAGMA user_version = 5;
        COMMIT;
      `);
      userVersion = 5;
    }

    if (userVersion === 5) {
      // Migrate V5 -> V6 (Separate Executions)
      db.exec(`
        BEGIN TRANSACTION;
        
        CREATE TABLE approvals_new (
          token                   TEXT    PRIMARY KEY,
          request_hash            TEXT    NOT NULL,
          tool                    TEXT    NOT NULL,
          operation               TEXT    NOT NULL,
          status                  TEXT    NOT NULL DEFAULT 'pending'
                                          CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
          created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          expires_at              TEXT    NOT NULL,
          requested_by            TEXT    NOT NULL DEFAULT 'mcp-agent',
          risk_score              INTEGER NOT NULL DEFAULT 0,
          params                  TEXT    NOT NULL DEFAULT '{}',
          decided_at              TEXT,
          decided_by              TEXT,
          consumed_at             TEXT
        );

        CREATE TABLE executions (
          execution_id            TEXT    PRIMARY KEY,
          approval_token          TEXT,
          request_hash            TEXT    NOT NULL,
          idempotency_key         TEXT    NOT NULL,
          status                  TEXT    NOT NULL DEFAULT 'executing'
                                          CHECK (status IN ('executing', 'unknown_outcome', 'completed', 'failed_terminal', 'cancelled')),
          worker_hostname         TEXT    NOT NULL,
          worker_pid              INTEGER NOT NULL,
          worker_uuid             TEXT    NOT NULL,
          started_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          completed_at            TEXT,
          stripe_object_id        TEXT,
          last_error              TEXT
        );

        INSERT INTO approvals_new (
          token, request_hash, tool, operation, status, 
          created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at
        )
        SELECT 
          token, request_hash, tool, operation, 
          CASE 
            WHEN status IN ('executing', 'unknown_outcome', 'completed', 'failed_terminal', 'cancelled') THEN 'consumed'
            WHEN status = 'rejected' THEN 'expired'
            ELSE status 
          END, 
          created_at, expires_at, requested_by, risk_score, params, decided_at, decided_by, consumed_at 
        FROM approvals;

        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
        
        CREATE INDEX IF NOT EXISTS idx_approvals_status     ON approvals (status);
        CREATE INDEX IF NOT EXISTS idx_approvals_expires_at ON approvals (expires_at);
        CREATE INDEX IF NOT EXISTS idx_executions_status    ON executions (status);
        CREATE INDEX IF NOT EXISTS idx_executions_idemp_key ON executions (idempotency_key);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idemp_executing ON executions (idempotency_key) WHERE status = 'executing';

        PRAGMA user_version = 6;
        COMMIT;
      `);
      userVersion = 6;
    }

    if (userVersion === 6) {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idemp_executing
          ON executions (idempotency_key) WHERE status = 'executing';
      `);
      db.pragma("user_version = 7");
      userVersion = 7;
    }

    if (userVersion === 7) {
      db.exec(`
        ALTER TABLE executions ADD COLUMN reconcile_tool TEXT NOT NULL DEFAULT '';
        ALTER TABLE executions ADD COLUMN reconcile_operation TEXT NOT NULL DEFAULT 'create';
        ALTER TABLE executions ADD COLUMN reconcile_params TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE executions ADD COLUMN last_reconcile_at TEXT;
        ALTER TABLE executions ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
      `);
      db.pragma("user_version = 8");
      userVersion = 8;
    }

    if (userVersion === 8) {
      db.exec(`
        DROP INDEX IF EXISTS idx_executions_idemp_executing;
        DROP INDEX IF EXISTS idx_executions_idemp_key;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idemp_key ON executions (idempotency_key);
      `);
      db.pragma("user_version = 9");
      userVersion = 9;
    }
}

/**
 * Eagerly open and migrate both databases. Call once at process startup
 * before workers or timers touch SQLite.
 */
export function initializeAllDatabases(): void {
  getAuditDb();
  getApprovalsDb();
}

/**
 * Get the audit database connection (lazy init + migration).
 */
export function getAuditDb(): Database.Database {
  if (auditDb === null) {
    auditDb = openDatabase("audit.db");
    withExclusiveMigrationLock(auditDb, () => {
      const userVersion = auditDb!.pragma("user_version", { simple: true }) as number;
      if (userVersion === 0) {
        auditDb!.exec(AUDIT_SCHEMA);
        auditDb!.pragma("user_version = 2");
      }
    });
  }
  return auditDb;
}

/**
 * Get the approvals database connection (lazy init + migration).
 */
export function getApprovalsDb(): Database.Database {
  if (approvalsDb === null) {
    approvalsDb = openDatabase("approvals.db");
    withExclusiveMigrationLock(approvalsDb, () => {
      runApprovalsMigrations(approvalsDb!);
    });
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
