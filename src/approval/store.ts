/**
 * @module approval/store
 *
 * SQLite-backed approval token CRUD.
 */

import { randomUUID, createHash } from "node:crypto";
import { getApprovalsDb } from "../utils/db.js";
import { config } from "../config.js";
import type {
  ApprovalToken,
  OperationContext,
} from "../types.js";

// ── Raw row shape from SQLite ───────────────────────────────────────

interface RawApprovalRow {
  readonly token: string;
  readonly request_hash: string;
  readonly tool: string;
  readonly operation: string;
  readonly status: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly requested_by: string;
  readonly risk_score: number;
  readonly params: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly consumed_at: string | null;
}

export type ConsumeApprovalFailure =
  | "not_found"
  | "not_approved"
  | "expired"
  | "hash_mismatch"
  | "already_consumed";

export type ConsumeApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ConsumeApprovalFailure };

// ── Public API ──────────────────────────────────────────────────────

export function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (key === "approval_token" || value === undefined) continue;
    result[key] = canonicalize(value);
  }
  return result;
}

export function computeRequestHash(context: OperationContext): string {
  const { capability, params } = context;
  const canonicalParams = canonicalize(params);
  const idempotencyKey = String(params.idempotency_key ?? "");

  return createHash("sha256")
    .update(capability.tool)
    .update("|")
    .update(capability.operation)
    .update("|")
    .update(idempotencyKey)
    .update("|")
    .update(JSON.stringify(canonicalParams))
    .digest("hex");
}

export function createApproval(
  context: OperationContext,
  riskScore: number,
): ApprovalToken {
  const db = getApprovalsDb();
  const token = randomUUID();
  const requestHash = computeRequestHash(context);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.approvalExpiryMinutes * 60_000,
  );

  db.prepare(
    `INSERT INTO approvals
       (token, request_hash, tool, operation, status, created_at, expires_at, requested_by, risk_score, params)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    token,
    requestHash,
    context.capability.tool,
    context.capability.operation,
    now.toISOString(),
    expiresAt.toISOString(),
    "mcp-agent",
    riskScore,
    JSON.stringify(context.params),
  );
  return {
    token,
    requestHash,
    tool: context.capability.tool,
    operation: context.capability.operation,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    requestedBy: "mcp-agent",
    riskScore,
    params: context.params,
    consumedAt: null,
  };
}

export function getApproval(token: string): ApprovalToken | null {
  expireStaleApprovals();
  const db = getApprovalsDb();
  const row = db
    .prepare("SELECT * FROM approvals WHERE token = ?")
    .get(token) as RawApprovalRow | undefined;

  if (row === undefined) return null;
  return parseApprovalRow(row);
}

export function approveToken(
  token: string,
  decidedBy: string = "admin",
): ApprovalToken | null {
  expireStaleApprovals();
  const db = getApprovalsDb();
  const result = db
    .prepare(
      `UPDATE approvals
       SET status = 'approved', decided_at = ?, decided_by = ?
       WHERE token = ? AND status = 'pending'`,
    )
    .run(new Date().toISOString(), decidedBy, token);

  if (result.changes === 0) return null;
  return getApproval(token);
}

export function rejectToken(
  token: string,
  decidedBy: string = "admin",
): ApprovalToken | null {
  expireStaleApprovals();
  const db = getApprovalsDb();
  const result = db
    .prepare(
      `UPDATE approvals
       SET status = 'expired', decided_at = ?, decided_by = ?
       WHERE token = ? AND status = 'pending'`,
    )
    .run(new Date().toISOString(), decidedBy, token);

  if (result.changes === 0) return null;
  return getApproval(token);
}

export function consumeApprovalInTransaction(
  token: string,
  requestHash: string,
  db: ReturnType<typeof getApprovalsDb>,
): ConsumeApprovalResult {
  const row = db
    .prepare("SELECT status, request_hash, expires_at FROM approvals WHERE token = ?")
    .get(token) as
    | { status: string; request_hash: string; expires_at: string }
    | undefined;

  if (!row) {
    return { ok: false, reason: "not_found" };
  }

  if (row.status === "consumed") {
    return { ok: false, reason: "already_consumed" };
  }

  if (row.status === "expired") {
    return { ok: false, reason: "expired" };
  }

  if (row.status !== "approved") {
    return { ok: false, reason: "not_approved" };
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(
      `UPDATE approvals SET status = 'expired' WHERE token = ? AND status = 'approved'`,
    ).run(token);
    return { ok: false, reason: "expired" };
  }

  if (row.request_hash !== requestHash) {
    return { ok: false, reason: "hash_mismatch" };
  }

  const result = db.prepare(
    `UPDATE approvals SET status = 'consumed', consumed_at = ?
     WHERE token = ? AND status = 'approved' AND request_hash = ?`,
  ).run(new Date().toISOString(), token, requestHash);

  if (result.changes === 0) {
    return { ok: false, reason: "already_consumed" };
  }

  return { ok: true };
}

/** Atomically consumes an approved token (standalone; prefer {@link beginExecution}). */
export function consumeApproval(
  token: string,
  requestHash: string,
): ConsumeApprovalResult {
  return consumeApprovalInTransaction(token, requestHash, getApprovalsDb());
}

function expireStaleApprovals(): void {
  const db = getApprovalsDb();
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
  ).run(now);
  db.prepare(
    "UPDATE approvals SET status = 'expired' WHERE status = 'approved' AND expires_at < ?",
  ).run(now);
}

function parseApprovalRow(row: RawApprovalRow): ApprovalToken {
  return {
    token: row.token,
    requestHash: row.request_hash,
    tool: row.tool,
    operation: row.operation as ApprovalToken["operation"],
    status: row.status as ApprovalToken["status"],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    requestedBy: row.requested_by,
    riskScore: row.risk_score,
    params: JSON.parse(row.params) as Record<string, unknown>,
    consumedAt: row.consumed_at,
  };
}
