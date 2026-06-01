/**
 * @module approval/store
 *
 * SQLite-backed approval token CRUD.
 *
 * Tokens are created when a high-risk or high-value operation requires
 * human approval before execution. Tokens expire after a configurable
 * duration (default 60 minutes).
 *
 * The approval HTTP server ({@link ../approval/server}) and the
 * `get_approval_status` MCP tool both read from this store.
 */

import { randomUUID } from "node:crypto";
import { getApprovalsDb } from "../utils/db.js";
import { config } from "../config.js";
import type {
  ApprovalToken,
  OperationContext,
} from "../types.js";

// ── Raw row shape from SQLite ───────────────────────────────────────

interface RawApprovalRow {
  readonly token: string;
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
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a new pending approval token for an operation.
 *
 * @param context - The operation context (tool, params, etc.).
 * @param riskScore - The risk score at the time of creation.
 * @returns The newly created {@link ApprovalToken}.
 */
export function createApproval(
  context: OperationContext,
  riskScore: number,
): ApprovalToken {
  const db = getApprovalsDb();
  const token = randomUUID();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.approvalExpiryMinutes * 60_000,
  );

  db.prepare(
    `INSERT INTO approvals
       (token, tool, operation, status, created_at, expires_at, requested_by, risk_score, params)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    token,
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
    tool: context.capability.tool,
    operation: context.capability.operation,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    requestedBy: "mcp-agent",
    riskScore,
    params: context.params,
  };
}

/**
 * Retrieve an approval token by its UUID.
 *
 * @description Automatically expires any stale pending tokens before
 *   returning the result.
 * @param token - The UUID token string.
 * @returns The {@link ApprovalToken} if found, or `null`.
 */
export function getApproval(token: string): ApprovalToken | null {
  expirePending();
  const db = getApprovalsDb();
  const row = db
    .prepare("SELECT * FROM approvals WHERE token = ?")
    .get(token) as RawApprovalRow | undefined;

  if (row === undefined) return null;
  return parseApprovalRow(row);
}

/**
 * Approve a pending token.
 *
 * @param token - The UUID token to approve.
 * @param decidedBy - Who approved (default: "admin").
 * @returns The updated {@link ApprovalToken}, or `null` if not found/not pending.
 */
export function approveToken(
  token: string,
  decidedBy: string = "admin",
): ApprovalToken | null {
  expirePending();
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

/**
 * Reject a pending token.
 *
 * @param token - The UUID token to reject.
 * @param decidedBy - Who rejected (default: "admin").
 * @returns The updated {@link ApprovalToken}, or `null` if not found/not pending.
 */
export function rejectToken(
  token: string,
  decidedBy: string = "admin",
): ApprovalToken | null {
  expirePending();
  const db = getApprovalsDb();
  const result = db
    .prepare(
      `UPDATE approvals
       SET status = 'rejected', decided_at = ?, decided_by = ?
       WHERE token = ? AND status = 'pending'`,
    )
    .run(new Date().toISOString(), decidedBy, token);

  if (result.changes === 0) return null;
  return getApproval(token);
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Expire all pending tokens whose `expires_at` is in the past.
 * Called automatically before every read/write.
 */
function expirePending(): void {
  const db = getApprovalsDb();
  db.prepare(
    "UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?",
  ).run(new Date().toISOString());
}

/** Convert a raw SQLite row to a typed {@link ApprovalToken}. */
function parseApprovalRow(row: RawApprovalRow): ApprovalToken {
  return {
    token: row.token,
    tool: row.tool,
    operation: row.operation as ApprovalToken["operation"],
    status: row.status as ApprovalToken["status"],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    requestedBy: row.requested_by,
    riskScore: row.risk_score,
    params: JSON.parse(row.params) as Record<string, unknown>,
  };
}
