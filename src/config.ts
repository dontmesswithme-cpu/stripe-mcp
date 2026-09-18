/**
 * @module config
 *
 * Centralized, typed configuration parsed from environment variables.
 * Every value has a sensible default. Parsed once at module load and
 * frozen — no mutation possible after initialization.
 *
 * All stderr-safe: no stdout output.
 */

import { createHash } from "node:crypto";

// ── Parsing helpers ─────────────────────────────────────────────────

function envBool(key: string, fallback: boolean, safeDirection = true): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  const normalized = val.trim().toLowerCase();
  if (
    normalized === "true" ||
    normalized === "1" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "false" ||
    normalized === "0" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  // Fail-closed: unrecognized values resolve to the safe direction.
  return safeDirection;
}

function envInt(
  key: string,
  fallback: number,
  opts?: { min?: number; max?: number },
): number {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  const trimmed = val.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid integer for environment variable ${key}: "${val}"`,
    );
  }
  const parsed = parseInt(trimmed, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid integer for environment variable ${key}: "${val}"`,
    );
  }
  if (opts?.min !== undefined && parsed < opts.min) {
    throw new Error(
      `Environment variable ${key} out of range: got ${parsed}, expected >= ${opts.min}`,
    );
  }
  if (opts?.max !== undefined && parsed > opts.max) {
    throw new Error(
      `Environment variable ${key} out of range: got ${parsed}, expected <= ${opts.max}`,
    );
  }
  return parsed;
}

function envStr(key: string, fallback: string): string {
  const val = process.env[key];
  return val !== undefined && val !== "" ? val : fallback;
}

function envStrHashed(key: string, fallback: string): string {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  return createHash("sha256").update(val).digest("hex");
}

// ── Configuration interface ─────────────────────────────────────────

/** Typed, readonly configuration for stripe-mcp. */
export interface StripeMcpConfig {
  // ── Core
  readonly readOnly: boolean;
  readonly dryRun: boolean;
  readonly dataDir: string;

  // ── Approval server
  readonly approvalApiHash: string;
  readonly approvalPort: number;
  readonly approvalExpiryMinutes: number;
  readonly approvalRefundThreshold: number;
  readonly approvalCancelThreshold: number;
  readonly approvalChargeThreshold: number;

  // ── Risk engine
  readonly riskAmountHigh: number;
  readonly riskAmountCritical: number;
  readonly riskBlockThreshold: number;
  readonly riskFlagThreshold: number;
  readonly riskVelocity24hMax: number;
  readonly riskVelocity30dMax: number;

  // ── Archive
  readonly archiveDeleteAfterDays: number;

  // ── Audit Pruning
  readonly auditRetentionDays: number;
  readonly auditPruneIntervalMs: number;
  readonly executionRetentionDays: number;

  // ── Execution / reconciliation
  readonly executionStaleMinutes: number;
  readonly reconciliationIntervalMs: number;
  readonly reconciliationRetryIntervalMs: number;
  readonly reconciliationMaxAgeHours: number;

  // ── Stripe write throttling (background jobs)
  readonly stripeWriteConcurrency: number;
  readonly stripeWriteIntervalMs: number;
}

// ── Singleton config instance ───────────────────────────────────────

/**
 * Frozen configuration object. Values are parsed from `process.env`
 * at module load time and never change.
 */
export const config: StripeMcpConfig = Object.freeze({
  // Core
  readOnly: envBool("STRIPE_READ_ONLY", false, true),
  dryRun: envBool("STRIPE_DRY_RUN", false, true),
  dataDir: envStr("STRIPE_MCP_DATA_DIR", "./data"),

  // Approval server
  approvalApiHash: envStrHashed("APPROVAL_API_KEY", ""),
  approvalPort: envInt("APPROVAL_PORT", 3001, { min: 0, max: 65535 }),
  approvalExpiryMinutes: envInt("APPROVAL_EXPIRY_MINUTES", 60, { min: 1 }),
  approvalRefundThreshold: envInt("APPROVAL_REFUND_THRESHOLD", 100_000, {
    min: 0,
  }),
  approvalCancelThreshold: envInt("APPROVAL_CANCEL_THRESHOLD", 500_000, {
    min: 0,
  }),
  approvalChargeThreshold: envInt("APPROVAL_CHARGE_THRESHOLD", 100_000, {
    min: 0,
  }),

  // Risk engine
  riskAmountHigh: envInt("RISK_AMOUNT_HIGH", 50_000, { min: 0 }),
  riskAmountCritical: envInt("RISK_AMOUNT_CRITICAL", 200_000, { min: 0 }),
  riskBlockThreshold: envInt("RISK_BLOCK_THRESHOLD", 70, { min: 0 }),
  riskFlagThreshold: envInt("RISK_FLAG_THRESHOLD", 40, { min: 0 }),
  riskVelocity24hMax: envInt("RISK_VELOCITY_24H_MAX", 5, { min: 0 }),
  riskVelocity30dMax: envInt("RISK_VELOCITY_30D_MAX", 20, { min: 0 }),

  // Archive
  archiveDeleteAfterDays: envInt("ARCHIVE_DELETE_AFTER_DAYS", 14, { min: 1 }),

  // Audit Pruning
  auditRetentionDays: envInt("AUDIT_RETENTION_DAYS", 90, { min: 1 }),
  auditPruneIntervalMs: envInt("AUDIT_PRUNE_INTERVAL_MS", 86_400_000, {
    min: 1,
  }),
  executionRetentionDays: envInt("EXECUTION_RETENTION_DAYS", 30, { min: 1 }),

  // Execution / reconciliation
  executionStaleMinutes: envInt("EXECUTION_STALE_MINUTES", 5, { min: 1 }),
  reconciliationIntervalMs: envInt("RECONCILIATION_INTERVAL_MS", 60_000, {
    min: 1,
  }),
  reconciliationRetryIntervalMs: envInt(
    "RECONCILIATION_RETRY_INTERVAL_MS",
    900_000,
    { min: 1 },
  ),
  reconciliationMaxAgeHours: envInt("RECONCILIATION_MAX_AGE_HOURS", 24, {
    min: 1,
  }),
  stripeWriteConcurrency: envInt("STRIPE_WRITE_CONCURRENCY", 3, { min: 1 }),
  stripeWriteIntervalMs: envInt("STRIPE_WRITE_INTERVAL_MS", 150, { min: 1 }),
});
