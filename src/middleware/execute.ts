/**
 * @module middleware/execute
 *
 * Central execution pipeline for all mutating Stripe operations.
 *
 * Every tool handler that performs a mutation calls
 * {@link executeStripeOperation} instead of calling the Stripe SDK
 * directly. This function enforces:
 *
 * 1. **Read-only mode** — blocks if `STRIPE_READ_ONLY=true`
 * 2. **Dry-run mode** — simulates without executing if `STRIPE_DRY_RUN=true`
 * 3. **Risk scoring** — evaluates risk factors (if `riskScored`)
 * 4. **Approval gate** — generates tokens for high-risk/high-value ops
 * 5. **Execution** — calls the Stripe SDK
 * 6. **Audit logging** — writes every outcome to the audit log
 *
 * Read-only tools (retrieve, list) bypass this middleware entirely.
 */

import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { config } from "../config.js";
import { writeAuditEntry } from "../audit/log.js";
import { scoreRisk } from "../risk/engine.js";
import { getApproval, createApproval, consumeApproval } from "../approval/store.js";
import { toErrorResponse } from "../utils/errors.js";
import type { McpToolResponse, OperationContext, RiskScore } from "../types.js";

// ── Public API ──────────────────────────────────────────────────────

/**
 * Execute a mutating Stripe operation through the full middleware pipeline.
 *
 * @description This is the single gateway for all mutations. It checks
 *   policy (read-only, dry-run), evaluates risk, gates on approval,
 *   executes, and audits — in that order.
 *
 *   The `operation` parameter is a lazy thunk so that the Stripe API
 *   call only executes if all policy checks pass.
 *
 * @typeParam T - The Stripe response type (e.g. `Stripe.Refund`).
 * @param context - Describes what is about to happen (tool, customer, amount, etc.).
 * @param operation - A zero-arg async function that performs the actual Stripe SDK call.
 * @returns A standardized `McpToolResponse` with either `success: true` or `success: false`.
 */
export async function executeStripeOperation<T>(
  context: OperationContext,
  operation: (options: Stripe.RequestOptions) => Promise<T>,
): Promise<McpToolResponse<T>> {
  // ── 1. Sanity check ─────────────────────────────────────────────
  if (context.capability.readOnly) {
    throw new Error(
      `BUG: read-only tool "${context.capability.tool}" routed through middleware`,
    );
  }

  // ── 2. Read-only mode ───────────────────────────────────────────
  if (config.readOnly) {
    writeAuditEntry(context, "blocked", null, { reason: "read_only_mode" });
    return {
      success: false,
      error: {
        code: "read_only",
        type: "policy_error",
        message:
          "STRIPE_READ_ONLY is enabled — all mutating operations are blocked. " +
          "Unset the variable or set it to false to proceed.",
      },
    };
  }

  // ── Idempotency Generation ──────────────────────────────────────
  const idempotencyKey = context.params.idempotency_key ?? randomUUID();

  // ── Approval Token Consumption ──────────────────────────────────
  let riskResult: RiskScore | null = null;
  let isPreApproved = false;

  if (context.params.approval_token) {
    const approval = getApproval(context.params.approval_token);
    
    if (!approval || approval.status !== "approved") {
      return {
        success: false,
        error: {
          code: "invalid_approval",
          type: "policy_error",
          message: "Approval token is invalid, expired, or not yet approved.",
        },
      };
    }

    // Token is valid. Mark as consumed to prevent replay attacks.
    if (!consumeApproval(approval.token)) {
      return {
        success: false,
        error: {
          code: "token_already_consumed",
          type: "policy_error",
          message: "This approval token has already been consumed.",
        },
      };
    }

    isPreApproved = true;
  }

  // ── 3. Dry-run mode ─────────────────────────────────────────────
  if (config.dryRun) {
    // If risk scored, compute it for the audit log
    if (context.capability.riskScored && !isPreApproved) {
      riskResult = await scoreRisk(context);
    }

    const metadata: Record<string, unknown> = { dry_run: true, idempotency_key: idempotencyKey };
    if (isPreApproved) {
      metadata.pre_approved_by_token = context.params.approval_token;
    }
    writeAuditEntry(
      context,
      "dry_run",
      riskResult ? riskResult.total : null,
      metadata,
    );

    return {
      success: true,
      data: {
        dry_run: true,
        simulated_success: true,
        operation: context.capability.operation,
        risk_score: riskResult?.total,
        idempotency_key: idempotencyKey,
        params: context.params,
      } as unknown as T,
    };
  }

  // ── 4. Risk scoring ─────────────────────────────────────────────
  if (context.capability.riskScored && !isPreApproved) {
    riskResult = await scoreRisk(context);

    if (riskResult.outcome === "block") {
      writeAuditEntry(context, "blocked", riskResult.total, {
        reasons: riskResult.reasons,
      });

      return {
        success: false,
        error: {
          code: "risk_blocked",
          type: "policy_error",
          message:
            `Operation blocked by risk engine (score: ${riskResult.total}). ` +
            `Reasons: ${riskResult.reasons.join("; ")}`,
        },
      };
    }
  }

  // ── 5. Approval gate ────────────────────────────────────────────
  if (
    context.capability.approvalEligible &&
    !isPreApproved &&
    shouldRequireApproval(context)
  ) {
    const approval = createApproval(context, riskResult?.total ?? 0);

    writeAuditEntry(context, "pending_approval", riskResult?.total ?? null, {
      approval_token: approval.token,
      expires_at: approval.expiresAt,
    });

    return {
      success: false,
      error: {
        code: "approval_required",
        type: "policy_error",
        message:
          `This operation requires approval. ` +
          `Token: ${approval.token} | Expires: ${approval.expiresAt}. ` +
          `Check status: GET http://localhost:${config.approvalPort}/approvals/${approval.token}. ` +
          `Approve: POST .../approve | Reject: POST .../reject`,
      },
    };
  }

  // ── 6. Execute ──────────────────────────────────────────────────
  try {
    const result = await operation({ idempotencyKey });

    const metadata: Record<string, unknown> = { idempotency_key: idempotencyKey };
    if (isPreApproved) {
      metadata.pre_approved_by_token = context.params.approval_token;
    }
    if (riskResult) {
      metadata.risk_score = riskResult.total;
      metadata.risk_reasons = riskResult.reasons;
    }

    try {
      writeAuditEntry(
        context,
        "success",
        riskResult ? riskResult.total : null,
        metadata,
      );
    } catch (auditError) {
      console.error(`stripe-mcp CRITICAL: Failed to write audit log for successful operation.`, auditError);
    }

    return { success: true, data: result };

    // ── 7. Error handling ───────────────────────────────────────
  } catch (error: unknown) {
    const errorResponse = toErrorResponse(error);

    writeAuditEntry(context, "error", riskResult?.total ?? null, {
      error:
        errorResponse.success === false
          ? errorResponse.error
          : { code: "unknown" },
    });

    return errorResponse;
  }
}

// ── Approval policy ─────────────────────────────────────────────────

/**
 * Determine whether an operation requires human approval.
 *
 * Policy:
 * - `delete` and `purge`: always require approval
 * - `refund`: requires approval if amount > APPROVAL_REFUND_THRESHOLD
 * - `cancel`: requires approval if amount > APPROVAL_CANCEL_THRESHOLD
 * - All other operations: no approval required
 */
function shouldRequireApproval(context: OperationContext): boolean {
  const op = context.capability.operation;

  // Destructive operations always require approval
  if (op === "delete" || op === "purge") return true;

  // High-value refunds
  if (op === "refund" && (context.amount ?? 0) > config.approvalRefundThreshold) {
    return true;
  }

  // High-value subscription cancellations
  if (op === "cancel" && (context.amount ?? 0) > config.approvalCancelThreshold) {
    return true;
  }

  return false;
}
