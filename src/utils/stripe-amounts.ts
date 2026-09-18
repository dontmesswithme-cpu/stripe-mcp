/**
 * Resolve monetary amounts from Stripe objects for approval/risk gates.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";

export async function resolveRefundAmountCents(input: {
  payment_intent?: string;
  charge?: string;
  amount?: number;
}): Promise<ResolvedMoney> {
  const explicitAmount = input.amount;

  if (input.charge !== undefined) {
    const charge = await stripe.charges.retrieve(input.charge);
    return {
      amount: explicitAmount ?? (charge.amount - charge.amount_refunded),
      currency: charge.currency ?? undefined,
      customerId: extractCustomerId(charge.customer),
    };
  }

  if (input.payment_intent !== undefined) {
    const pi = await stripe.paymentIntents.retrieve(input.payment_intent, {
      expand: ["latest_charge"],
    });
    let customerId = extractCustomerId(pi.customer);
    const latestCharge = pi.latest_charge as
      | string
      | Stripe.Charge
      | null
      | undefined;
    let currency: string | undefined = pi.currency ?? undefined;
    let chargeAmount: number | undefined;
    if (
      latestCharge !== null &&
      latestCharge !== undefined &&
      typeof latestCharge === "object"
    ) {
      chargeAmount = latestCharge.amount - latestCharge.amount_refunded;
      const chargeCustomerId = extractCustomerId(latestCharge.customer);
      if (chargeCustomerId !== undefined) {
        customerId = chargeCustomerId;
      }
      if (currency === undefined && latestCharge.currency) {
        currency = latestCharge.currency;
      }
    }
    return {
      amount: explicitAmount ?? chargeAmount ?? pi.amount,
      currency,
      customerId,
    };
  }

  return { amount: explicitAmount ?? 0 };
}

export async function resolveSubscriptionValueCents(
  subscriptionId: string,
): Promise<ResolvedMoney> {
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });

  let total = 0;
  let currency: string | undefined;
  for (const item of subscription.items.data) {
    const price = item.price;
    // Fail-closed: an unexpanded price carries no amount data, and a null
    // unit_amount means metered/tiered/usage-based pricing with unbounded
    // per-period cost. Skipping either as 0 would make the subscription
    // look free and bypass approval/risk gates.
    if (typeof price === "string") {
      throw new Error(
        "Cannot determine subscription value for " +
          subscriptionId +
          ": subscription item " +
          item.id +
          " has an unexpanded price (" +
          price +
          "). Failing closed to avoid approval bypass.",
      );
    }
    if (currency === undefined && price.currency) {
      currency = price.currency;
    }
    if (price.unit_amount == null) {
      throw new Error(
        "Cannot determine subscription value for " +
          subscriptionId +
          ": price " +
          price.id +
          " has null unit_amount (metered/tiered/usage-based pricing has " +
          "unbounded cost). Failing closed to avoid approval bypass.",
      );
    }
    const qty = item.quantity ?? 1;
    total += price.unit_amount * qty;
  }

  // Fallback to the subscription-level currency when no item price
  // reported one.
  if (currency === undefined) {
    const subCurrency = (subscription as Stripe.Subscription & {
      currency?: unknown;
    }).currency;
    if (typeof subCurrency === "string") {
      currency = subCurrency;
    }
  }

  return {
    amount: total,
    currency,
    customerId: extractCustomerId(subscription.customer),
  };
}

/** Extract a customer ID from an expanded Stripe customer field. */
function extractCustomerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string | undefined {
  if (typeof customer === "string") return customer;
  if (
    customer !== null &&
    customer !== undefined &&
    typeof customer === "object" &&
    "id" in customer &&
    typeof customer.id === "string"
  ) {
    return customer.id;
  }
  return undefined;
}

export interface ResolvedMoney {
  amount: number;
  currency?: string;
  customerId?: string;
}

/**
 * Resolve the collectible amount for an invoice before pay.
 * Uses amount_remaining (what pay would charge), falling back to
 * amount_due then total. Fail-open never: a retrieve error throws
 * so the caller returns a structured error without executing.
 */
export async function resolveInvoicePaymentCents(
  invoiceId: string,
): Promise<ResolvedMoney> {
  const invoice = await stripe.invoices.retrieve(invoiceId);
  const amount =
    invoice.amount_remaining ?? invoice.amount_due ?? invoice.total ?? 0;
  return {
    amount,
    currency: invoice.currency ?? undefined,
    customerId: extractCustomerId(invoice.customer),
  };
}

/**
 * Resolve amount/currency/customer for a PaymentIntent before
 * confirm/cancel so risk scoring and approval thresholds see the
 * real money at stake. Throws on retrieve error (fail-closed).
 */
export async function resolvePaymentIntentValueCents(
  paymentIntentId: string,
): Promise<ResolvedMoney> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  return {
    amount: pi.amount ?? 0,
    currency: pi.currency ?? undefined,
    customerId: extractCustomerId(pi.customer),
  };
}

/**
 * Resolve the per-period value of subscription line items at creation
 * time by summing price.unit_amount * quantity. Fail-closed: a price
 * with null unit_amount (e.g. tiered/metered/usage-based) has unbounded
 * per-period cost, so this throws instead of treating it as 0 (which
 * would make the subscription look free and bypass approval/risk gates).
 * Currency is taken from the first price that reports one.
 */
export async function resolveSubscriptionItemsValueCents(
  items: ReadonlyArray<{ price: string; quantity?: number | null }>,
): Promise<ResolvedMoney> {
  let total = 0;
  let currency: string | undefined;
  for (const item of items) {
    const price = await stripe.prices.retrieve(item.price);
    if (currency === undefined && price.currency) {
      currency = price.currency;
    }
    // Fail-closed: metered/tiered/usage-based prices have null unit_amount
    // and unbounded cost. Skipping them as 0 would make the subscription
    // look free and bypass approval/risk gates.
    if (price.unit_amount == null) {
      throw new Error(
        "Cannot determine subscription items value: price " +
          price.id +
          " has null unit_amount (metered/tiered/usage-based pricing has " +
          "unbounded cost). Failing closed to avoid approval bypass.",
      );
    }
    const qty = item.quantity ?? 1;
    total += price.unit_amount * qty;
  }
  return { amount: total, currency };
}
