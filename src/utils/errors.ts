/**
 * @module utils/errors
 *
 * Centralized Stripe error → {@link McpToolResponse} mapping for all
 * tool handlers. Catches every concrete Stripe error subclass and
 * returns a structured, actionable error response.
 *
 * By consolidating error handling here we guarantee:
 * - Consistent error shapes across every tool.
 * - Actionable messages that tell an AI agent (or human) what to do next.
 * - Zero chance of leaking raw stack traces into MCP responses.
 */

import Stripe from "stripe";
import type { McpToolResponse, ToolError } from "../types.js";

/**
 * Convert a caught error into a failed {@link McpToolResponse}.
 *
 * Inspects the error's runtime class to produce a specific, actionable
 * message for each Stripe error category. Non-Stripe errors are wrapped
 * in a generic `internal_error` response.
 *
 * @description Maps Stripe SDK errors to structured tool error responses.
 * @param error - The value caught in a `catch` block (typed as `unknown`).
 * @returns A `McpToolResponse<never>` on the failure branch of the
 *          discriminated union — assignable to `McpToolResponse<T>` for any `T`.
 *
 * @example
 * ```ts
 * try {
 *   const customer = await stripe.customers.create(params);
 *   return { success: true, data: customer };
 * } catch (error) {
 *   return toErrorResponse(error);
 * }
 * ```
 */
export function toErrorResponse(error: unknown): McpToolResponse<never> {
  // ── Stripe-specific error classes ───────────────────────────────

  if (error instanceof Stripe.errors.StripeCardError) {
    return fail({
      code: error.code ?? "card_error",
      type: "card_error",
      message:
        `Card declined: ${error.message}. ` +
        "Advise the customer to use a different payment method or contact their bank.",
      param: error.param ?? undefined,
    });
  }

  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    return fail({
      code: error.code ?? "invalid_request",
      type: "invalid_request_error",
      message:
        `Invalid request: ${error.message}. ` +
        "Verify the parameters are correct, IDs exist, and the object is in the expected state.",
      param: error.param ?? undefined,
    });
  }

  if (error instanceof Stripe.errors.StripeRateLimitError) {
    return fail({
      code: "rate_limit",
      type: "rate_limit_error",
      message:
        `Rate limit exceeded: ${error.message}. ` +
        "Back off for a few seconds and retry the request.",
    });
  }

  if (error instanceof Stripe.errors.StripeAPIError) {
    return fail({
      code: "api_error",
      type: "api_error",
      message:
        `Stripe API error: ${error.message}. ` +
        "This is a problem on Stripe's end — retry after a short delay.",
    });
  }

  if (error instanceof Stripe.errors.StripeConnectionError) {
    return fail({
      code: "connection_error",
      type: "connection_error",
      message:
        `Network error connecting to Stripe: ${error.message}. ` +
        "Check network connectivity and retry.",
    });
  }

  if (error instanceof Stripe.errors.StripeAuthenticationError) {
    return fail({
      code: "authentication_error",
      type: "authentication_error",
      message:
        `Authentication failed: ${error.message}. ` +
        "Verify that STRIPE_API_KEY is correct, unexpired, and has the required permissions.",
    });
  }

  // ── Catch-all for non-Stripe errors ────────────────────────────

  const message =
    error instanceof Error ? error.message : String(error);

  return fail({
    code: "internal_error",
    type: "internal_error",
    message: `Unexpected error: ${message}`,
  });
}

// ── Internal helper ───────────────────────────────────────────────

/**
 * Constructs the failure branch of {@link McpToolResponse}.
 * Tiny helper to keep each `return` in {@link toErrorResponse} terse.
 */
function fail(error: ToolError): McpToolResponse<never> {
  return { success: false, error } as const;
}

/** Stripe errors that will not change outcome on idempotent retry. */
export function isStripeTerminalError(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError ||
    error instanceof Stripe.errors.StripeAuthenticationError ||
    error instanceof Stripe.errors.StripeCardError
  );
}

export function toolErrorFromResponse(
  response: McpToolResponse<unknown>,
): ToolError | null {
  if (!response.success) {
    return response.error;
  }
  return null;
}
