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
import { executeStripeOperation } from "../middleware/execute.js";
import { resolveSubscriptionValueCents, resolveSubscriptionItemsValueCents } from "../utils/stripe-amounts.js";
import type { ResolvedMoney } from "../utils/stripe-amounts.js";
import type {
  CancelSubscriptionInput,
  CreateSubscriptionInput,
  ListSubscriptionsInput,
  McpToolResponse,
  RetrieveSubscriptionInput,
  ToolCapability,
  UpdateSubscriptionInput,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createSubscription
// ═════════════════════════════════════════════════════════════════════

const createSubscriptionCapability: ToolCapability = {
  tool: "create_subscription",
  operation: "create",
  readOnly: false,
  riskScored: true,
  approvalEligible: true,
};

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
  // Resolve the per-period value of the requested price items so risk
  // scoring and approval thresholds gate the recurring commitment.
  // Price lookup errors fail closed via a structured error.
  let resolved: { amount: number; currency?: string };
  try {
    resolved = await resolveSubscriptionItemsValueCents(input.items ?? []);
  } catch (error: unknown) {
    return toErrorResponse(error);
  }

  return executeStripeOperation(
    {
      capability: createSubscriptionCapability,
      customerId: input.customer,
      amount: resolved.amount,
      currency: resolved.currency,
      params: input as Record<string, unknown>,
    },
    (options) =>
      stripe.subscriptions.create({
        customer: input.customer,
        items: input.items?.map((item) => ({
          price: item.price,
          quantity: item.quantity,
        })),
        payment_behavior: input.payment_behavior,
        collection_method: input.collection_method,
        metadata: input.metadata,
      }, options),
  );
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

const updateSubscriptionCapability: ToolCapability = {
  tool: "update_subscription",
  operation: "update",
  readOnly: false,
  riskScored: true,
  approvalEligible: true,
};

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
  // Gate money movement: adding items, upgrading price, or mid-cycle
  // proration can charge the customer. Resolve the projected per-period
  // total (after applying the requested item changes) plus customer and
  // currency so risk scoring and approval thresholds see the real value.
  // Metadata-only / cancel_at_period_end-only updates (no `items`) carry
  // amount 0 and pass charge thresholds without over-gating.
  // Any lookup failure fails closed via a structured error (no execution).
  let resolvedAmount = 0;
  let resolvedCurrency: string | undefined;
  let resolvedCustomerId: string | undefined;
  try {
    const existing = await stripe.subscriptions.retrieve(input.subscription_id, {
      expand: ["items.data.price"],
    });

    const cust = existing.customer;
    resolvedCustomerId =
      typeof cust === "string"
        ? cust
        : cust !== null &&
            cust !== undefined &&
            typeof cust === "object" &&
            "id" in cust &&
            typeof (cust as { id: unknown }).id === "string"
          ? (cust as { id: string }).id
          : undefined;

    // Fallback currency from the existing subscription items (first price
    // that reports one), or the subscription-level currency when present.
    let existingCurrency: string | undefined;
    if (
      typeof (existing as unknown as { currency?: unknown }).currency ===
      "string"
    ) {
      existingCurrency = (existing as unknown as { currency: string }).currency;
    }
    for (const item of existing.items.data) {
      const p = item.price;
      if (typeof p !== "string" && p.currency) {
        existingCurrency = p.currency;
        break;
      }
    }

    if (input.items === undefined || input.items.length === 0) {
      resolvedAmount = 0;
      resolvedCurrency = existingCurrency;
    } else {
      // Build the projected item set: start from existing items, apply
      // adds (no id), updates (id + new price/quantity), and deletes
      // (id + deleted:true), then resolve the merged total. Reuses the
      // resolveSubscriptionItemsValueCents price-lookup pattern so tiered/
      // metered prices (null unit_amount) fail closed via a thrown error.
      const projected = new Map<string, { price: string; quantity: number }>();
      for (const item of existing.items.data) {
        const priceId =
          typeof item.price === "string" ? item.price : item.price.id;
        projected.set(item.id, {
          price: priceId,
          quantity: item.quantity ?? 1,
        });
      }

      input.items.forEach((req, index) => {
        if (req.deleted === true) {
          if (req.id !== undefined) {
            if (!projected.has(req.id)) {
              throw new Error(`Unknown subscription item id: ${req.id}`);
            }
            projected.delete(req.id);
          }
          return;
        }
        if (req.id !== undefined) {
          const prev = projected.get(req.id);
          if (prev === undefined) {
            throw new Error(`Unknown subscription item id: ${req.id}`);
          }
          projected.set(req.id, {
            price: req.price ?? prev?.price ?? "",
            quantity: req.quantity ?? prev?.quantity ?? 1,
          });
          return;
        }
        projected.set(`__new_${index}`, {
          price: req.price,
          quantity: req.quantity ?? 1,
        });
      });

      const projectedItems = [...projected.values()].filter(
        (entry) => entry.price !== "",
      );
      if (projectedItems.length === 0) {
        resolvedAmount = 0;
        resolvedCurrency = existingCurrency;
      } else {
        const resolved =
          await resolveSubscriptionItemsValueCents(projectedItems);
        resolvedAmount = resolved.amount;
        resolvedCurrency = resolved.currency ?? existingCurrency;
      }
    }
  } catch (error: unknown) {
    return toErrorResponse(error);
  }

  return executeStripeOperation(
    {
      capability: updateSubscriptionCapability,
      customerId: resolvedCustomerId,
      amount: resolvedAmount,
      currency: resolvedCurrency,
      params: input as Record<string, unknown>,
    },
    (options) => {
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

      return stripe.subscriptions.update(subscription_id, updateParams, options);
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// § cancelSubscription
// ═════════════════════════════════════════════════════════════════════

const cancelSubscriptionCapability: ToolCapability = {
  tool: "cancel_subscription",
  operation: "cancel",
  readOnly: false,
  riskScored: true,
  approvalEligible: true,
};

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
  // Resolve per-period value + customer + currency from the live
  // subscription so velocity and customer risk factors are evaluated.
  // Retrieve errors fail closed via a structured error.
  let resolved: ResolvedMoney;
  try {
    resolved = await resolveSubscriptionValueCents(
      input.subscription_id,
    );
  } catch (error: unknown) {
    return toErrorResponse(error);
  }

  return executeStripeOperation(
    {
      capability: cancelSubscriptionCapability,
      customerId: resolved.customerId,
      amount: resolved.amount,
      currency: resolved.currency,
      params: input as Record<string, unknown>,
    },
    async (options) => {
      // ── End-of-period cancellation ─────────────────────────────
      // Uses update (not cancel) because Stripe's cancel endpoint
      // always terminates immediately. Setting cancel_at_period_end
      // via update schedules cancellation at the billing cycle boundary.
      if (input.cancel_at_period_end === true) {
        return stripe.subscriptions.update(input.subscription_id, {
          cancel_at_period_end: true,
        }, options);
      }

      // ── Immediate cancellation ─────────────────────────────────
      const cancelParams: Stripe.SubscriptionCancelParams = {};

      if (input.invoice_now !== undefined) {
        cancelParams.invoice_now = input.invoice_now;
      }
      if (input.prorate !== undefined) {
        cancelParams.prorate = input.prorate;
      }

      return stripe.subscriptions.cancel(input.subscription_id, cancelParams, options);
    },
  );
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
