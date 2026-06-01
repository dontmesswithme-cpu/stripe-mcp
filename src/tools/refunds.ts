/**
 * @module tools/refunds
 *
 * MCP tool handlers for Stripe Refund operations.
 *
 * Each function accepts a validated input object (from the corresponding
 * Zod schema in `types.ts`), calls the Stripe SDK, and returns a
 * {@link McpToolResponse} discriminated union.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { toErrorResponse } from "../utils/errors.js";
import { executeStripeOperation } from "../middleware/execute.js";
import type {
  ToolCapability,
  CreateRefundInput,
  ListRefundsInput,
  McpToolResponse,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createRefund
// ═════════════════════════════════════════════════════════════════════

const createRefundCapability: ToolCapability = {
  tool: "create_refund",
  operation: "refund",
  readOnly: false,
  riskScored: true,
  approvalEligible: true,
};

/**
 * Create a refund for a charge or payment intent.
 *
 * @description Refunds a payment — either fully (omit `amount`) or
 *   partially (provide `amount` in smallest currency unit). Exactly
 *   one of `payment_intent` or `charge` must be provided; passing
 *   both or neither returns a validation error before hitting the API.
 *
 *   A full refund returns the entire charged amount. A partial refund
 *   returns the specified amount and leaves the rest captured. Multiple
 *   partial refunds can be issued until the full amount is returned.
 * @param input - Validated {@link CreateRefundInput}. One of
 *   `payment_intent` or `charge` is required. `amount`, `reason`, and
 *   `metadata` are optional.
 * @returns A {@link McpToolResponse} containing the `Stripe.Refund`
 *   on success, or a structured error on failure.
 * @throws Never — all Stripe errors (including `StripeInvalidRequestError`
 *   for already-refunded charges) are caught and mapped to structured
 *   responses.
 */
export async function createRefund(
  input: CreateRefundInput,
): Promise<McpToolResponse<Stripe.Refund>> {
  // ── Cross-field validation ──────────────────────────────────────
  // The MCP SDK validates field types from the base schema shape;
  // we validate the XOR constraint here for a clearer error message
  // than Stripe's generic "you must supply either…".
  const hasPaymentIntent = input.payment_intent !== undefined;
  const hasCharge = input.charge !== undefined;

  if (hasPaymentIntent === hasCharge) {
    return {
      success: false,
      error: {
        code: "invalid_parameters",
        type: "invalid_request_error",
        message:
          "Provide exactly one of 'payment_intent' or 'charge', not " +
          (hasPaymentIntent ? "both." : "neither."),
      },
    };
  }

  return executeStripeOperation(
    {
      capability: createRefundCapability,
      customerId: undefined,
      amount: input.amount,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    (options) =>
      stripe.refunds.create({
        payment_intent: input.payment_intent,
        charge: input.charge,
        amount: input.amount,
        reason: input.reason,
        metadata: input.metadata,
      }, options),
  );
}

// ═════════════════════════════════════════════════════════════════════
// § listRefunds
// ═════════════════════════════════════════════════════════════════════

/**
 * List refunds with optional filters and pagination.
 *
 * @description Returns a paginated list of refunds. Results can be
 *   filtered by charge or payment intent. The response includes
 *   `has_more` to indicate whether additional pages exist.
 * @param input - Validated {@link ListRefundsInput} with optional
 *   `limit`, `charge`, `payment_intent`, `starting_after`, and
 *   `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.Refund>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listRefunds(
  input: ListRefundsInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.Refund>>> {
  try {
    const list = await stripe.refunds.list({
      limit: input.limit,
      charge: input.charge,
      payment_intent: input.payment_intent,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
