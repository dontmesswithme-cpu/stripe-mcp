/**
 * @module tools/audit
 *
 * MCP tool handlers for administrative queries:
 * - `get_audit_log`       — Query the operation audit log
 * - `get_approval_status` — Check the status of an approval token
 *
 * Both are read-only and bypass the middleware pipeline.
 */

import type { McpToolResponse, AuditEntry, AuditFilters, ApprovalToken } from "../types.js";
import { queryAuditLog } from "../audit/log.js";
import { getApproval } from "../approval/store.js";

// ═════════════════════════════════════════════════════════════════════
// § getAuditLog
// ═════════════════════════════════════════════════════════════════════

/** Input shape for the audit log query tool. */
export interface GetAuditLogInput {
  readonly customer_id?: string;
  readonly tool_name?: string;
  readonly operation_type?: string;
  readonly outcome?: string;
  readonly start_date?: string;
  readonly end_date?: string;
  readonly limit?: number;
}

/**
 * Query the operation audit log with optional filters.
 *
 * @description Returns audit entries ordered by timestamp descending
 *   (newest first). Supports filtering by customer, tool, operation
 *   type, outcome, and date range.
 * @param input - Validated filter parameters. All optional.
 * @returns A {@link McpToolResponse} containing an array of
 *   {@link AuditEntry} objects.
 */
export async function getAuditLog(
  input: GetAuditLogInput,
): Promise<McpToolResponse<AuditEntry[]>> {
  try {
    const filters: AuditFilters = {
      customerId: input.customer_id,
      toolName: input.tool_name,
      operationType: input.operation_type as AuditFilters["operationType"],
      outcome: input.outcome as AuditFilters["outcome"],
      startDate: input.start_date,
      endDate: input.end_date,
      limit: input.limit,
    };

    const entries = queryAuditLog(filters);

    return { success: true, data: entries };
  } catch (error: unknown) {
    return {
      success: false,
      error: {
        code: "audit_query_error",
        type: "internal_error",
        message:
          error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ═════════════════════════════════════════════════════════════════════
// § getApprovalStatus
// ═════════════════════════════════════════════════════════════════════

/** Input shape for the approval status check tool. */
export interface GetApprovalStatusInput {
  readonly token: string;
}

/**
 * Check the status of an approval token.
 *
 * @description Returns the full approval token record including its
 *   current status, risk score, expiry, and the original operation
 *   parameters. Automatically expires stale tokens before returning.
 * @param input - The approval token UUID.
 * @returns A {@link McpToolResponse} containing the {@link ApprovalToken}
 *   on success, or an error if the token is not found.
 */
export async function getApprovalStatus(
  input: GetApprovalStatusInput,
): Promise<McpToolResponse<ApprovalToken>> {
  try {
    const approval = getApproval(input.token);

    if (approval === null) {
      return {
        success: false,
        error: {
          code: "token_not_found",
          type: "invalid_request_error",
          message: `Approval token "${input.token}" not found.`,
        },
      };
    }

    return { success: true, data: approval };
  } catch (error: unknown) {
    return {
      success: false,
      error: {
        code: "approval_query_error",
        type: "internal_error",
        message:
          error instanceof Error ? error.message : String(error),
      },
    };
  }
}
