/**
 * @module tools/payments
 *
 * MCP tool handlers for Stripe PaymentIntent operations.
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
  CancelPaymentIntentInput,
  ConfirmPaymentIntentInput,
  CreatePaymentIntentInput,
  ListPaymentIntentsInput,
  McpToolResponse,
  RetrievePaymentIntentInput,
  ToolCapability,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createPaymentIntent
// ═════════════════════════════════════════════════════════════════════

const createPaymentIntentCapability: ToolCapability = {
  tool: "create_payment_intent",
  operation: "create",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Create a new Stripe PaymentIntent.
 *
 * @description Creates a PaymentIntent for the specified amount and
 *   currency. Optionally associates it with a customer and restricts
 *   the allowed payment method types. The returned PaymentIntent is
 *   in `requires_payment_method` or `requires_confirmation` status
 *   depending on whether a payment method was attached.
 * @param input - Validated {@link CreatePaymentIntentInput}. `amount`
 *   (in smallest currency unit) and `currency` (ISO 4217) are required.
 *   `customer`, `description`, `payment_method_types`, and `metadata`
 *   are optional.
 * @returns A {@link McpToolResponse} containing the newly created
 *   `Stripe.PaymentIntent` on success, or a structured error on failure.
 * @throws Never — all Stripe errors are caught and mapped to the
 *   failure branch of the response union.
 */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
): Promise<McpToolResponse<Stripe.PaymentIntent>> {
  return executeStripeOperation(
    {
      capability: createPaymentIntentCapability,
      customerId: input.customer,
      amount: input.amount,
      currency: input.currency,
      params: input as Record<string, unknown>,
    },
    () =>
      stripe.paymentIntents.create({
        amount: input.amount,
        currency: input.currency,
        customer: input.customer,
        description: input.description,
        payment_method_types: input.payment_method_types,
        metadata: input.metadata,
      }),
  );
}

// ═════════════════════════════════════════════════════════════════════
// § retrievePaymentIntent
// ═════════════════════════════════════════════════════════════════════

/**
 * Retrieve a PaymentIntent by ID.
 *
 * @description Fetches the full PaymentIntent object including its
 *   current status, amount, currency, charges, and metadata.
 * @param input - Validated {@link RetrievePaymentIntentInput} with the
 *   `payment_intent_id` (must start with `pi_`).
 * @returns A {@link McpToolResponse} containing the
 *   `Stripe.PaymentIntent` on success, or a structured error if the
 *   PaymentIntent does not exist.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function retrievePaymentIntent(
  input: RetrievePaymentIntentInput,
): Promise<McpToolResponse<Stripe.PaymentIntent>> {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(
      input.payment_intent_id,
    );

    return { success: true, data: paymentIntent };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § confirmPaymentIntent
// ═════════════════════════════════════════════════════════════════════

const confirmPaymentIntentCapability: ToolCapability = {
  tool: "confirm_payment_intent",
  operation: "confirm",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Confirm a PaymentIntent to initiate payment processing.
 *
 * @description Confirms the PaymentIntent, causing Stripe to attempt
 *   to collect the payment. If a `payment_method` is provided, it is
 *   attached to the PaymentIntent before confirmation. The PaymentIntent
 *   must be in `requires_confirmation` or `requires_payment_method`
 *   status.
 *
 *   After confirmation, the status will transition to `processing`,
 *   `requires_action` (for 3D Secure / SCA), or `succeeded`.
 * @param input - Validated {@link ConfirmPaymentIntentInput}.
 *   `payment_intent_id` is required. `payment_method` is optional —
 *   if omitted, the PaymentIntent's existing attached method is used.
 * @returns A {@link McpToolResponse} containing the confirmed
 *   `Stripe.PaymentIntent` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function confirmPaymentIntent(
  input: ConfirmPaymentIntentInput,
): Promise<McpToolResponse<Stripe.PaymentIntent>> {
  return executeStripeOperation(
    {
      capability: confirmPaymentIntentCapability,
      customerId: undefined,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    () => {
      const confirmParams: Stripe.PaymentIntentConfirmParams = {};

      if (input.payment_method !== undefined) {
        confirmParams.payment_method = input.payment_method;
      }

      return stripe.paymentIntents.confirm(
        input.payment_intent_id,
        confirmParams,
      );
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// § cancelPaymentIntent
// ═════════════════════════════════════════════════════════════════════

const cancelPaymentIntentCapability: ToolCapability = {
  tool: "cancel_payment_intent",
  operation: "cancel",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Cancel a PaymentIntent.
 *
 * @description Cancels a PaymentIntent that has not yet been captured
 *   or is still in a cancelable state (`requires_payment_method`,
 *   `requires_capture`, `requires_confirmation`, `requires_action`,
 *   `processing`). Once cancelled, no further charges can be made
 *   against this PaymentIntent.
 * @param input - Validated {@link CancelPaymentIntentInput}.
 *   `payment_intent_id` is required. `cancellation_reason` is optional
 *   and must be one of `duplicate`, `fraudulent`,
 *   `requested_by_customer`, or `abandoned`.
 * @returns A {@link McpToolResponse} containing the cancelled
 *   `Stripe.PaymentIntent` (status = `canceled`) on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function cancelPaymentIntent(
  input: CancelPaymentIntentInput,
): Promise<McpToolResponse<Stripe.PaymentIntent>> {
  return executeStripeOperation(
    {
      capability: cancelPaymentIntentCapability,
      customerId: undefined,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    () => {
      const cancelParams: Stripe.PaymentIntentCancelParams = {};

      if (input.cancellation_reason !== undefined) {
        cancelParams.cancellation_reason = input.cancellation_reason;
      }

      return stripe.paymentIntents.cancel(
        input.payment_intent_id,
        cancelParams,
      );
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// § listPaymentIntents
// ═════════════════════════════════════════════════════════════════════

/**
 * List PaymentIntents with optional filters and pagination.
 *
 * @description Returns a paginated list of PaymentIntents. Results can
 *   be filtered by customer and paginated via cursor-based
 *   `starting_after` / `ending_before` params. The response includes
 *   `has_more` to indicate whether additional pages exist.
 * @param input - Validated {@link ListPaymentIntentsInput} with
 *   optional `limit`, `customer`, `starting_after`, and
 *   `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.PaymentIntent>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listPaymentIntents(
  input: ListPaymentIntentsInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.PaymentIntent>>> {
  try {
    const list = await stripe.paymentIntents.list({
      limit: input.limit,
      customer: input.customer,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
