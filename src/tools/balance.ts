/**
 * @module tools/balance
 *
 * MCP tool handler for Stripe Balance retrieval.
 *
 * The balance endpoint is read-only and takes no parameters. It returns
 * the current account balance broken down by available and pending
 * amounts per currency.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { toErrorResponse } from "../utils/errors.js";
import type { McpToolResponse } from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § retrieveBalance
// ═════════════════════════════════════════════════════════════════════

/**
 * Retrieve the current Stripe account balance.
 *
 * @description Returns the balance object for the account associated
 *   with the configured API key. The balance is broken down into:
 *
 *   - **`available`** — funds that have cleared and can be paid out
 *     or used for refunds, grouped by currency.
 *   - **`pending`** — funds not yet available (e.g. charges still in
 *     transit), grouped by currency.
 *   - **`connect_reserved`** — (Connect only) funds reserved for
 *     negative-balance recovery.
 *
 *   Each entry includes `amount` (in the smallest currency unit) and
 *   `currency` (ISO 4217). Source-type breakdowns (`card`, `bank_account`,
 *   etc.) are included when applicable.
 *
 *   This endpoint takes no parameters.
 * @returns A {@link McpToolResponse} containing the `Stripe.Balance`
 *   object on success, or a structured error on failure.
 * @throws Never — all Stripe errors are caught and mapped to the
 *   failure branch of the response union.
 */
export async function retrieveBalance(): Promise<
  McpToolResponse<Stripe.Balance>
> {
  try {
    const balance = await stripe.balance.retrieve();

    return { success: true, data: balance };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
