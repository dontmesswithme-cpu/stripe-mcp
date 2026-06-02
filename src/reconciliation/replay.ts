/**
 * @module reconciliation/replay
 *
 * Reconcile unknown outcomes by re-issuing the original Stripe mutation
 * with the same idempotency key (Stripe returns the cached result if the
 * first request succeeded).
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { isStripeTerminalError } from "../utils/errors.js";
import type { ExecutionRecord, OperationType } from "../types.js";

export interface ReplayResult {
  readonly status: "completed" | "failed_terminal" | "unresolved";
  readonly stripeObjectId: string | null;
}

export function canReplayExecution(execution: ExecutionRecord): boolean {
  if (!execution.reconcileTool || execution.reconcileTool === "") {
    return false;
  }
  if (execution.reconcileTool === "purge_expired_customers") {
    return false;
  }
  return true;
}

/**
 * Re-attempt the original Stripe API call with the stored idempotency key.
 */
export async function replayStripeMutation(
  execution: ExecutionRecord,
): Promise<ReplayResult> {
  if (!canReplayExecution(execution)) {
    return { status: "unresolved", stripeObjectId: null };
  }

  const idempotencyKey = execution.idempotencyKey;
  const params = execution.reconcileParams;
  const tool = execution.reconcileTool;

  try {
    const result = await dispatchReplay(tool, execution.reconcileOperation, params, idempotencyKey);
    const stripeObjectId = extractStripeObjectId(result);
    return { status: "completed", stripeObjectId };
  } catch (error: unknown) {
    if (isStripeTerminalError(error)) {
      return { status: "failed_terminal", stripeObjectId: null };
    }
    return { status: "unresolved", stripeObjectId: null };
  }
}

async function dispatchReplay(
  tool: string,
  operation: OperationType,
  params: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  const opts: Stripe.RequestOptions = { idempotencyKey };

  switch (tool) {
    case "create_customer":
      return stripe.customers.create(
        params as unknown as Stripe.CustomerCreateParams,
        opts,
      );

    case "update_customer": {
      const { customer_id, ...rest } = params;
      return stripe.customers.update(
        customer_id as string,
        rest as Stripe.CustomerUpdateParams,
        opts,
      );
    }

    case "delete_customer":
      return stripe.customers.del(params.customer_id as string, opts);

    case "archive_customer": {
      const customerId = params.customer_id as string;
      const existing = await stripe.customers.retrieve(customerId);
      if ("deleted" in existing && existing.deleted) {
        return existing;
      }
      const customer = existing as Stripe.Customer;
      const deleteAfter = params.delete_after as string | undefined;
      return stripe.customers.update(
        customerId,
        {
          metadata: {
            ...customer.metadata,
            archived: "true",
            archived_at: new Date().toISOString(),
            delete_after: deleteAfter ?? customer.metadata?.delete_after,
          },
        },
        opts,
      );
    }

    case "create_payment_intent":
      return stripe.paymentIntents.create(
        params as unknown as Stripe.PaymentIntentCreateParams,
        opts,
      );

    case "confirm_payment_intent": {
      const { payment_intent_id, ...rest } = params;
      return stripe.paymentIntents.confirm(
        payment_intent_id as string,
        rest as Stripe.PaymentIntentConfirmParams,
        opts,
      );
    }

    case "cancel_payment_intent": {
      const { payment_intent_id, ...rest } = params;
      return stripe.paymentIntents.cancel(
        payment_intent_id as string,
        rest as Stripe.PaymentIntentCancelParams,
        opts,
      );
    }

    case "create_subscription":
      return stripe.subscriptions.create(
        params as unknown as Stripe.SubscriptionCreateParams,
        opts,
      );

    case "update_subscription": {
      const { subscription_id, ...rest } = params;
      return stripe.subscriptions.update(
        subscription_id as string,
        rest as Stripe.SubscriptionUpdateParams,
        opts,
      );
    }

    case "cancel_subscription": {
      const { subscription_id, cancel_at_period_end, ...rest } = params;
      if (cancel_at_period_end === true) {
        return stripe.subscriptions.update(
          subscription_id as string,
          { cancel_at_period_end: true },
          opts,
        );
      }
      return stripe.subscriptions.cancel(
        subscription_id as string,
        rest as Stripe.SubscriptionCancelParams,
        opts,
      );
    }

    case "create_product":
      return stripe.products.create(
        params as unknown as Stripe.ProductCreateParams,
        opts,
      );

    case "create_price":
      return stripe.prices.create(
        params as unknown as Stripe.PriceCreateParams,
        opts,
      );

    case "pay_invoice": {
      const { invoice_id, ...rest } = params;
      return stripe.invoices.pay(
        invoice_id as string,
        rest as Stripe.InvoicePayParams,
        opts,
      );
    }

    case "create_refund":
      return stripe.refunds.create(
        params as unknown as Stripe.RefundCreateParams,
        opts,
      );

    default:
      throw new Error(`No replay handler for tool "${tool}" (operation: ${operation})`);
  }
}

function extractStripeObjectId(result: unknown): string | null {
  if (result && typeof result === "object" && "id" in result) {
    return String((result as { id: unknown }).id);
  }
  return null;
}
