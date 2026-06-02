/**
 * @module middleware/execute
 *
 * Core execution pipeline for all Stripe MCP tools.
 */

import { config } from "../config.js";
import { writeAuditEntry } from "../audit/log.js";
import { scoreRisk } from "../risk/engine.js";
import {
  getApproval,
  createApproval,
  computeRequestHash,
  type ConsumeApprovalFailure,
} from "../approval/store.js";
import { beginExecution, updateExecutionStatus } from "../execution/store.js";
import { WORKER_ID } from "../worker/identity.js";
import {
  isStripeTerminalError,
  toErrorResponse,
  toolErrorFromResponse,
} from "../utils/errors.js";
import type { McpToolResponse, OperationContext, RiskScore, ToolError } from "../types.js";

export async function executeStripeOperation<T>(
  context: OperationContext,
  operation: (params: { idempotencyKey: string }) => Promise<T>,
): Promise<McpToolResponse<T>> {
  if (context.capability.readOnly) {
    throw new Error(
      `BUG: read-only tool "${context.capability.tool}" routed through middleware`,
    );
  }

  const idempotencyKey = context.params.idempotency_key as string | undefined;

  if (!idempotencyKey) {
    return {
      success: false,
      error: {
        code: "missing_idempotency_key",
        type: "validation_error",
        message: "Mutating operations require an idempotency_key parameter.",
      },
    };
  }

  if (config.readOnly) {
    writeAuditEntry(context, "blocked", null, {
      reason: "read_only_mode",
      idempotency_key: idempotencyKey,
    });
    return {
      success: false,
      error: {
        code: "read_only",
        type: "policy_error",
        message:
          "STRIPE_READ_ONLY is enabled — all mutating operations are blocked.",
      },
    };
  }

  let isPreApproved = false;
  let riskResult: RiskScore | undefined;

  if (context.capability.approvalEligible && context.params.approval_token) {
    const approval = getApproval(context.params.approval_token as string);

    if (!approval) {
      return policyError(
        "invalid_approval_token",
        "The provided approval token does not exist or has expired.",
      );
    }
    if (approval.status !== "approved") {
      return policyError(
        "token_not_approved",
        `Token is in state '${approval.status}', expected 'approved'.`,
      );
    }
    if (
      approval.tool !== context.capability.tool ||
      approval.operation !== context.capability.operation
    ) {
      return policyError(
        "approval_mismatch",
        "Approval token does not match the requested tool or operation.",
      );
    }

    isPreApproved = true;
  }

  if (config.dryRun) {
    if (context.capability.riskScored && !isPreApproved) {
      riskResult = await scoreRisk(context);
      const block = checkRiskBlock(context, riskResult);
      if (block) return block;
    }

    const metadata: Record<string, unknown> = {
      dry_run: true,
      idempotency_key: idempotencyKey,
    };
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

  const requestHash = computeRequestHash(context);

  if (context.capability.riskScored && !isPreApproved) {
    riskResult = await scoreRisk(context);
    const block = checkRiskBlock(context, riskResult);
    if (block) return block;
  }

  if (!isPreApproved && shouldRequireApproval(context, riskResult)) {
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
          `This operation requires approval. Token: ${approval.token} | Expires: ${approval.expiresAt}.`,
      },
    };
  }

  const approvalToken = isPreApproved
    ? (context.params.approval_token as string)
    : null;

  const reconcileParams = { ...context.params };
  delete (reconcileParams as { approval_token?: string }).approval_token;

  const begun = beginExecution(
    approvalToken,
    requestHash,
    idempotencyKey,
    WORKER_ID,
    {
      tool: context.capability.tool,
      operation: context.capability.operation,
      params: reconcileParams,
    },
  );

  if (!begun.ok) {
    return consumeFailureToResponse(begun.reason);
  }

  const executionId = begun.executionId;

  try {
    const result = await operation({ idempotencyKey });

    const stripeObjectId =
      result && typeof result === "object" && "id" in result
        ? String((result as { id: unknown }).id)
        : null;

    updateExecutionStatus(executionId, "completed", { stripeObjectId });

    const metadata: Record<string, unknown> = { idempotency_key: idempotencyKey };
    if (isPreApproved) {
      metadata.pre_approved_by_token = context.params.approval_token;
    }
    if (riskResult) {
      metadata.risk_score = riskResult.total;
      metadata.risk_reasons = riskResult.reasons;
    }

    writeAuditEntry(
      context,
      "success",
      riskResult ? riskResult.total : null,
      metadata,
    );

    return { success: true, data: result };
  } catch (error: unknown) {
    const errorResponse = toErrorResponse(error);
    const lastError = toolErrorFromResponse(errorResponse);

    const lastErrorRecord = lastError
      ? (lastError as unknown as Record<string, unknown>)
      : undefined;

    if (isStripeTerminalError(error)) {
      updateExecutionStatus(executionId, "failed_terminal", {
        lastError: lastErrorRecord,
      });
    } else {
      updateExecutionStatus(executionId, "unknown_outcome", {
        lastError: lastErrorRecord,
      });
    }

    writeAuditEntry(context, "error", riskResult?.total ?? null, {
      error: lastError ?? { code: "unknown" },
    });

    return errorResponse;
  }
}

function checkRiskBlock(
  context: OperationContext,
  riskResult: RiskScore,
): McpToolResponse<never> | null {
  if (!context.capability.riskScored || riskResult.outcome !== "block") {
    return null;
  }

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

function shouldRequireApproval(
  context: OperationContext,
  riskResult?: RiskScore,
): boolean {
  const op = context.capability.operation;

  if (op === "delete" || op === "purge") return true;

  const amount = context.amount ?? 0;

  if (op === "refund" && amount >= config.approvalRefundThreshold) {
    return true;
  }

  if (op === "cancel" && amount >= config.approvalCancelThreshold) {
    return true;
  }

  if (
    context.capability.approvalEligible &&
    context.capability.riskScored &&
    riskResult &&
    riskResult.outcome === "flag"
  ) {
    return true;
  }

  return false;
}

function policyError(code: string, message: string): McpToolResponse<never> {
  return {
    success: false,
    error: { code, type: "policy_error", message },
  };
}

function consumeFailureToResponse(
  reason: ConsumeApprovalFailure | "duplicate_in_flight",
): McpToolResponse<never> {
  const map: Record<
    ConsumeApprovalFailure | "duplicate_in_flight",
    ToolError
  > = {
    not_found: {
      code: "invalid_approval_token",
      type: "policy_error",
      message: "The provided approval token does not exist.",
    },
    not_approved: {
      code: "token_not_approved",
      type: "policy_error",
      message: "The approval token is not in approved state.",
    },
    expired: {
      code: "approval_expired",
      type: "policy_error",
      message: "The approval token has expired.",
    },
    hash_mismatch: {
      code: "approval_hash_mismatch",
      type: "policy_error",
      message:
        "Request parameters do not match the approved operation (hash mismatch).",
    },
    already_consumed: {
      code: "token_already_consumed",
      type: "policy_error",
      message: "This approval token has already been consumed.",
    },
    duplicate_in_flight: {
      code: "duplicate_in_flight",
      type: "policy_error",
      message:
        "An execution with this idempotency_key is already in progress. Wait for it to finish or reconcile.",
    },
  };

  return { success: false, error: map[reason] };
}
