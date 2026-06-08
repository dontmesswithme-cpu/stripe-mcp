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
import { logger } from "../utils/logger.js";
import { createHash } from "node:crypto";

export async function executeStripeOperation<T>(
  context: OperationContext,
  operation: (params: { idempotencyKey: string }) => Promise<T>,
): Promise<McpToolResponse<T>> {
  if (context.capability.readOnly) {
    throw new Error(
      `BUG: read-only tool "${context.capability.tool}" routed through middleware`,
    );
  }

  const rawIdempotencyKey = context.params.idempotency_key as string | undefined;

  if (!rawIdempotencyKey) {
    return {
      success: false,
      error: {
        code: "missing_idempotency_key",
        type: "validation_error",
        message: "Mutating operations require an idempotency_key parameter.",
      },
    };
  }

  const scopePrefix = context.customerId
    ? context.customerId
    : createHash("sha256").update(JSON.stringify(context.params)).digest("hex").slice(0, 16);

  const idempotencyKey = `${scopePrefix}:${rawIdempotencyKey}`;

  if (config.readOnly) {
    await writeAuditEntry(context, "blocked", null, {
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
    const approval = await getApproval(context.params.approval_token as string);

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
      try {
        riskResult = await scoreRisk(context);
      } catch (error) {
        return toErrorResponse(error);
      }
      const block = await checkRiskBlock(context, riskResult);
      if (block) return block;
    }

    const metadata: Record<string, unknown> = {
      dry_run: true,
      idempotency_key: idempotencyKey,
    };
    if (isPreApproved) {
      metadata.pre_approved_by_token = context.params.approval_token;
    }
    await writeAuditEntry(
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
    try {
      riskResult = await scoreRisk(context);
    } catch (error) {
      return toErrorResponse(error);
    }
    const block = await checkRiskBlock(context, riskResult);
    if (block) return block;
  }

  if (!isPreApproved && shouldRequireApproval(context, riskResult)) {
    const approval = await createApproval(context, riskResult?.total ?? 0);
    await writeAuditEntry(context, "pending_approval", riskResult?.total ?? null, {
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

  const begun = await beginExecution(
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
  const execLogger = logger.child({ worker_id: WORKER_ID, execution_id: executionId, idempotency_key: idempotencyKey });
  execLogger.info("execution started");

  try {
    const result = await operation({ idempotencyKey });

    const stripeObjectId =
      result && typeof result === "object" && "id" in result
        ? String((result as { id: unknown }).id)
        : null;

    await updateExecutionStatus(executionId, "completed", { stripeObjectId });
    execLogger.info({ stripeObjectId }, "execution completed");

    const metadata: Record<string, unknown> = { idempotency_key: idempotencyKey };
    if (isPreApproved) {
      metadata.pre_approved_by_token = context.params.approval_token;
    }
    if (riskResult) {
      metadata.risk_score = riskResult.total;
      metadata.risk_reasons = riskResult.reasons;
    }

    await writeAuditEntry(
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
      await updateExecutionStatus(executionId, "failed_terminal", {
        lastError: lastErrorRecord,
      });
      execLogger.error({ error: lastErrorRecord }, "execution failed (terminal)");
    } else {
      await updateExecutionStatus(executionId, "unknown_outcome", {
        lastError: lastErrorRecord,
      });
      execLogger.error({ error: lastErrorRecord }, "execution failed (unknown outcome)");
    }

    await writeAuditEntry(context, "error", riskResult?.total ?? null, {
      error: lastError ?? { code: "unknown" },
    });

    return errorResponse;
  }
}

async function checkRiskBlock(
  context: OperationContext,
  riskResult: RiskScore,
): Promise<McpToolResponse<never> | null> {
  if (!context.capability.riskScored || riskResult.outcome !== "block") {
    return null;
  }

  await writeAuditEntry(context, "blocked", riskResult.total, {
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
  reason: ConsumeApprovalFailure | "duplicate_in_flight" | "already_completed",
): McpToolResponse<never> {
  const map: Record<
    ConsumeApprovalFailure | "duplicate_in_flight" | "already_completed",
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
    already_completed: {
      code: "already_completed",
      type: "policy_error",
      message:
        "An execution with this idempotency_key has already been processed.",
    },
  };

  return { success: false, error: map[reason] };
}
