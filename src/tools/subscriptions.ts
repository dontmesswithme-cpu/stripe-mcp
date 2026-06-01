/**
 * @module tools/subscriptions
 *
 * MCP tool handlers for Stripe Subscription operations.
 *
 * Each function accepts a validated input object (from the corresponding
 * Zod schema in `types.ts`), calls the Stripe SDK, and returns a
 * {@link McpToolResponse} discriminated union.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { toErrorResponse } from "../utils/errors.js";
import type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  ListSubscriptionsInput,
  McpToolResponse,
  RetrieveSubscriptionInput,
  UpdateSubscriptionInput,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createSubscription
// ═════════════════════════════════════════════════════════════════════

/**
 * Create a new Stripe subscription for a customer.
 *
 * @description Creates a subscription with one or more price line items.
 *   The customer must have a valid payment method attached (or one must
 *   be collected via the resulting invoice) unless `payment_behavior`
 *   allows incomplete subscriptions.
 * @param input - Validated {@link CreateSubscriptionInput}. `customer`
 *   and `items` (array of price/quantity pairs) are required.
 *   `payment_behavior`, `collection_method`, and `metadata` are optional.
 * @returns A {@link McpToolResponse} containing the newly created
 *   `Stripe.Subscription` on success, or a structured error on failure.
 * @throws Never — all Stripe errors are caught and mapped to the
 *   failure branch of the response union.
 */
export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<McpToolResponse<Stripe.Subscription>> {
  try {
    const subscription = await stripe.subscriptions.create({
      customer: input.customer,
      items: input.items.map((item) => ({
        price: item.price,
        quantity: item.quantity,
      })),
      payment_behavior: input.payment_behavior,
      collection_method: input.collection_method,
      metadata: input.metadata,
    });

    return { success: true, data: subscription };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § retrieveSubscription
// ═════════════════════════════════════════════════════════════════════

/**
 * Retrieve a Stripe subscription by ID.
 *
 * @description Fetches the full subscription object including its
 *   current status, items, billing cycle, current period dates,
 *   and metadata.
 * @param input - Validated {@link RetrieveSubscriptionInput} with the
 *   `subscription_id` (must start with `sub_`).
 * @returns A {@link McpToolResponse} containing the
 *   `Stripe.Subscription` on success, or a structured error if the
 *   subscription does not exist.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function retrieveSubscription(
  input: RetrieveSubscriptionInput,
): Promise<McpToolResponse<Stripe.Subscription>> {
  try {
    const subscription = await stripe.subscriptions.retrieve(
      input.subscription_id,
    );

    return { success: true, data: subscription };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § updateSubscription
// ═════════════════════════════════════════════════════════════════════

/**
 * Update an existing Stripe subscription.
 *
 * @description Modifies subscription items, billing behaviour, or
 *   metadata. Line items can be added, updated (by `id`), or removed
 *   (via `deleted: true`). Changes to pricing mid-cycle are governed
 *   by the `proration_behavior` parameter.
 * @param input - Validated {@link UpdateSubscriptionInput}.
 *   `subscription_id` is required. `items`, `cancel_at_period_end`,
 *   `proration_behavior`, and `metadata` are optional.
 * @returns A {@link McpToolResponse} containing the updated
 *   `Stripe.Subscription` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function updateSubscription(
  input: UpdateSubscriptionInput,
): Promise<McpToolResponse<Stripe.Subscription>> {
  try {
    const { subscription_id, ...params } = input;

    const updateParams: Stripe.SubscriptionUpdateParams = {
      cancel_at_period_end: params.cancel_at_period_end,
      proration_behavior: params.proration_behavior,
      metadata: params.metadata,
    };

    // Map items only when provided — each item can be an add, update, or delete.
    if (params.items !== undefined) {
      updateParams.items = params.items.map((item) => ({
        id: item.id,
        price: item.price,
        quantity: item.quantity,
        deleted: item.deleted,
      }));
    }

    const subscription = await stripe.subscriptions.update(
      subscription_id,
      updateParams,
    );

    return { success: true, data: subscription };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § cancelSubscription
// ═════════════════════════════════════════════════════════════════════

/**
 * Cancel a Stripe subscription — immediately or at period end.
 *
 * @description Two cancellation modes:
 *
 * - **Immediate** (`cancel_at_period_end` is `false` or omitted):
 *   Calls `subscriptions.cancel()` which terminates the subscription
 *   right now. Optionally generates a final invoice (`invoice_now`)
 *   and/or a prorated credit (`prorate`).
 *
 * - **At period end** (`cancel_at_period_end` is `true`):
 *   Calls `subscriptions.update()` to set `cancel_at_period_end: true`.
 *   The subscription stays active until the current billing period
 *   ends, then transitions to `canceled`. This is reversible by
 *   calling `updateSubscription` with `cancel_at_period_end: false`.
 *
 * @param input - Validated {@link CancelSubscriptionInput}.
 *   `subscription_id` is required. `cancel_at_period_end`,
 *   `invoice_now`, and `prorate` are optional.
 * @returns A {@link McpToolResponse} containing the cancelled (or
 *   soon-to-be-cancelled) `Stripe.Subscription` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function cancelSubscription(
  input: CancelSubscriptionInput,
): Promise<McpToolResponse<Stripe.Subscription>> {
  try {
    // ── End-of-period cancellation ─────────────────────────────
    // Uses update (not cancel) because Stripe's cancel endpoint
    // always terminates immediately. Setting cancel_at_period_end
    // via update schedules cancellation at the billing cycle boundary.
    if (input.cancel_at_period_end === true) {
      const subscription = await stripe.subscriptions.update(
        input.subscription_id,
        { cancel_at_period_end: true },
      );

      return { success: true, data: subscription };
    }

    // ── Immediate cancellation ─────────────────────────────────
    const cancelParams: Stripe.SubscriptionCancelParams = {};

    if (input.invoice_now !== undefined) {
      cancelParams.invoice_now = input.invoice_now;
    }
    if (input.prorate !== undefined) {
      cancelParams.prorate = input.prorate;
    }

    const subscription = await stripe.subscriptions.cancel(
      input.subscription_id,
      cancelParams,
    );

    return { success: true, data: subscription };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § listSubscriptions
// ═════════════════════════════════════════════════════════════════════

/**
 * List Stripe subscriptions with optional filters and pagination.
 *
 * @description Returns a paginated list of subscriptions. Results can
 *   be filtered by customer, status, and price. Pass `status: "all"`
 *   to include every status. The response includes `has_more` to
 *   indicate whether additional pages exist.
 * @param input - Validated {@link ListSubscriptionsInput} with optional
 *   `limit`, `customer`, `status`, `price`, `starting_after`, and
 *   `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.Subscription>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listSubscriptions(
  input: ListSubscriptionsInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.Subscription>>> {
  try {
    const list = await stripe.subscriptions.list({
      limit: input.limit,
      customer: input.customer,
      status: input.status,
      price: input.price,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
