/**
 * Resolve monetary amounts from Stripe objects for approval/risk gates.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";

export async function resolveRefundAmountCents(input: {
  payment_intent?: string;
  charge?: string;
  amount?: number;
}): Promise<number> {
  if (input.amount !== undefined) {
    return input.amount;
  }

  if (input.charge !== undefined) {
    const charge = await stripe.charges.retrieve(input.charge);
    return charge.amount - charge.amount_refunded;
  }

  if (input.payment_intent !== undefined) {
    const pi = await stripe.paymentIntents.retrieve(input.payment_intent);
    return pi.amount;
  }

  return 0;
}

export async function resolveSubscriptionValueCents(
  subscriptionId: string,
): Promise<number> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });

  let total = 0;
  for (const item of subscription.items.data) {
    const price = item.price;
    if (typeof price === "string" || price.unit_amount == null) continue;
    const qty = item.quantity ?? 1;
    total += price.unit_amount * qty;
  }

  return total;
}
