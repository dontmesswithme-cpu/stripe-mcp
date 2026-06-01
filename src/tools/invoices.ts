/**
 * @module tools/invoices
 *
 * MCP tool handlers for Stripe Invoice operations.
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
  ListInvoicesInput,
  McpToolResponse,
  PayInvoiceInput,
  RetrieveInvoiceInput,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § retrieveInvoice
// ═════════════════════════════════════════════════════════════════════

/**
 * Retrieve a Stripe invoice by ID.
 *
 * @description Fetches the full invoice object including its status,
 *   amounts, line items, customer, payment intent, and PDF URL.
 *   Expanding `lines` is the default SDK behaviour — the returned
 *   invoice includes all invoice line items.
 * @param input - Validated {@link RetrieveInvoiceInput} with the
 *   `invoice_id` (must start with `in_`).
 * @returns A {@link McpToolResponse} containing the `Stripe.Invoice`
 *   on success, or a structured error if the invoice does not exist.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function retrieveInvoice(
  input: RetrieveInvoiceInput,
): Promise<McpToolResponse<Stripe.Invoice>> {
  try {
    const invoice = await stripe.invoices.retrieve(input.invoice_id);

    return { success: true, data: invoice };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § listInvoices
// ═════════════════════════════════════════════════════════════════════

/**
 * List Stripe invoices with optional filters and pagination.
 *
 * @description Returns a paginated list of invoices. Results can be
 *   filtered by customer and status. The response includes `has_more`
 *   to indicate whether additional pages exist.
 *
 *   Common statuses: `draft`, `open`, `paid`, `uncollectible`, `void`.
 * @param input - Validated {@link ListInvoicesInput} with optional
 *   `limit`, `customer`, `status`, `starting_after`, and
 *   `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.Invoice>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listInvoices(
  input: ListInvoicesInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.Invoice>>> {
  try {
    const list = await stripe.invoices.list({
      limit: input.limit,
      customer: input.customer,
      status: input.status,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § payInvoice
// ═════════════════════════════════════════════════════════════════════

const payInvoiceCapability: ToolCapability = {
  tool: "pay_invoice",
  operation: "pay",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Attempt payment on an open Stripe invoice.
 *
 * @description Triggers Stripe to attempt to collect payment for the
 *   invoice. The invoice must be in `open` status. By default, Stripe
 *   charges the customer's default payment method; pass `payment_method`
 *   to use a specific one.
 *
 *   Use `forgive: true` to mark the invoice as paid even if the payment
 *   fails (useful for manual reconciliation). Use `off_session: true`
 *   when the customer is not actively present (automated retries,
 *   dunning workflows).
 *
 *   After a successful payment, the invoice status transitions to `paid`.
 * @param input - Validated {@link PayInvoiceInput}. `invoice_id` is
 *   required. `payment_method`, `forgive`, and `off_session` are
 *   optional.
 * @returns A {@link McpToolResponse} containing the paid
 *   `Stripe.Invoice` on success (status = `paid`), or a structured
 *   error if payment fails or the invoice is not in a payable state.
 * @throws Never — all Stripe errors (including card declines via
 *   `StripeCardError`) are caught and mapped to structured responses.
 */
export async function payInvoice(
  input: PayInvoiceInput,
): Promise<McpToolResponse<Stripe.Invoice>> {
  return executeStripeOperation(
    {
      capability: payInvoiceCapability,
      customerId: undefined,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    () => {
      const payParams: Stripe.InvoicePayParams = {};

      if (input.payment_method !== undefined) {
        payParams.payment_method = input.payment_method;
      }
      if (input.forgive !== undefined) {
        payParams.forgive = input.forgive;
      }
      if (input.off_session !== undefined) {
        payParams.off_session = input.off_session;
      }

      return stripe.invoices.pay(input.invoice_id, payParams);
    },
  );
}
