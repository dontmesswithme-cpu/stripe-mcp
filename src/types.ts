/**
 * @module types
 *
 * Shared TypeScript interfaces, Zod input schemas, and inferred types
 * for every MCP tool exposed by stripe-mcp.
 *
 * Conventions:
 * - One named `z.object(...)` export per tool, e.g. `CreateCustomerSchema`.
 * - Every field uses `.describe()` so AI agents understand each parameter.
 * - Optional fields are explicitly marked with `.optional()`.
 * - Inferred TS types are exported alongside each schema.
 * - Zero `any` — all types are strict and explicit.
 */

import { z } from "zod";

// ═════════════════════════════════════════════════════════════════════
// § Generic Response Types
// ═════════════════════════════════════════════════════════════════════

/**
 * Structured error returned from a failed tool invocation.
 */
export interface ToolError {
  /** Stripe error code (e.g. "resource_missing", "card_declined"). */
  readonly code: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Stripe error type (e.g. "invalid_request_error", "api_error"). */
  readonly type: string;
  /** The parameter that caused the error, if applicable. */
  readonly param?: string;
}

/**
 * Discriminated union returned by every tool handler.
 *
 * On success, `success` is `true` and `data` contains the typed result.
 * On failure, `success` is `false` and `error` contains structured info.
 *
 * @example
 * ```ts
 * const result: McpToolResponse<Stripe.Customer> = await createCustomer(args);
 * if (result.success) {
 *   console.log(result.data.id);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export type McpToolResponse<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: ToolError };

// ═════════════════════════════════════════════════════════════════════
// § v1.0.0 — Operation, Risk, Approval, and Audit Types
// ═════════════════════════════════════════════════════════════════════

/** Classification of what a tool does to a Stripe resource. */
export type OperationType =
  | "create"
  | "update"
  | "delete"
  | "cancel"
  | "refund"
  | "pay"
  | "confirm"
  | "archive"
  | "purge";

/** Capabilities a tool declares — drives middleware behavior. */
export interface ToolCapability {
  /** The registered MCP tool name (e.g. "create_refund"). */
  readonly tool: string;
  /** Mutation classification. */
  readonly operation: OperationType;
  /** True for retrieve/list tools — bypasses middleware entirely. */
  readonly readOnly: boolean;
  /** True if this operation should be scored by the risk engine. */
  readonly riskScored: boolean;
  /** True if this operation can require approval above a threshold. */
  readonly approvalEligible: boolean;
}

/** Full context passed into executeStripeOperation. */
export interface OperationContext {
  /** Tool capability descriptor. */
  readonly capability: ToolCapability;
  /** Stripe customer ID, if applicable. */
  readonly customerId?: string;
  /** Monetary amount in smallest currency unit, if applicable. */
  readonly amount?: number;
  /** ISO 4217 currency code, if applicable. */
  readonly currency?: string;
  /** Serializable snapshot of the input params (for audit + approval storage). */
  readonly params: Record<string, unknown>;
}

/** Outcome tiers from the risk engine. */
export type RiskOutcome = "allow" | "flag" | "block";

/** A single contributing signal in a risk assessment. */
export interface RiskFactor {
  /** Machine-readable factor name (e.g. "high_amount"). */
  readonly name: string;
  /** Human-readable explanation. */
  readonly description: string;
  /** Points this factor contributed. */
  readonly points: number;
}

/** Complete risk assessment for an operation. */
export interface RiskScore {
  /** Total score (0–100+). */
  readonly total: number;
  /** Derived outcome: allow (0–39), flag (40–69), block (70+). */
  readonly outcome: RiskOutcome;
  /** Every factor that contributed to the score. */
  readonly factors: readonly RiskFactor[];
  /** Human-readable summary reasons. */
  readonly reasons: readonly string[];
}

/** Lifecycle status of an approval token. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** Persisted approval token record. */
export interface ApprovalToken {
  /** Unique token (UUIDv4). */
  readonly token: string;
  /** MCP tool name that triggered the approval. */
  readonly tool: string;
  /** Operation type. */
  readonly operation: OperationType;
  /** Current lifecycle status. */
  readonly status: ApprovalStatus;
  /** ISO 8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO 8601 expiry timestamp. */
  readonly expiresAt: string;
  /** Who/what requested this. */
  readonly requestedBy: string;
  /** Risk score at time of creation. */
  readonly riskScore: number;
  /** Serialized operation parameters. */
  readonly params: Record<string, unknown>;
}

/** A single audit log entry. */
export interface AuditEntry {
  /** Auto-increment ID. */
  readonly id: number;
  /** ISO 8601 timestamp. */
  readonly timestamp: string;
  /** MCP tool name. */
  readonly toolName: string;
  /** Stripe customer ID, if applicable. */
  readonly customerId: string | null;
  /** Operation classification. */
  readonly operationType: OperationType;
  /** Amount in smallest currency unit, if applicable. */
  readonly amount: number | null;
  /** ISO 4217 currency, if applicable. */
  readonly currency: string | null;
  /** Outcome of the operation. */
  readonly outcome:
    | "success"
    | "error"
    | "blocked"
    | "dry_run"
    | "pending_approval";
  /** Risk score, if computed. */
  readonly riskScore: number | null;
  /** Arbitrary JSON metadata. */
  readonly metadata: Record<string, unknown>;
}

/** Filters for querying the audit log. */
export interface AuditFilters {
  readonly customerId?: string;
  readonly toolName?: string;
  readonly operationType?: OperationType;
  readonly outcome?: AuditEntry["outcome"];
  readonly startDate?: string;
  readonly endDate?: string;
  readonly limit?: number;
}

/** Result of purgeExpiredCustomers. */
export interface PurgeResult {
  readonly dry_run: boolean;
  readonly count: number;
  readonly customers: readonly string[];
}

// ═════════════════════════════════════════════════════════════════════
// § Shared Sub-schemas (DRY building blocks)
// ═════════════════════════════════════════════════════════════════════

/**
 * Stripe key/value metadata.
 * Up to 50 keys, each key ≤40 chars, each value ≤500 chars.
 */
const MetadataSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    "Arbitrary key-value metadata to attach to the Stripe object. " +
      "Up to 50 keys, each key ≤40 chars, each value ≤500 chars.",
  );

/** Reusable pagination parameters shared across all list operations. */
const PaginationSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Maximum number of objects to return (1–100). Defaults to 10."),
  starting_after: z
    .string()
    .optional()
    .describe(
      "Cursor for forward pagination. Pass the `id` of the last object " +
        "from the previous page to fetch the next page.",
    ),
  ending_before: z
    .string()
    .optional()
    .describe(
      "Cursor for backward pagination. Pass the `id` of the first object " +
        "from the previous page to fetch the preceding page.",
    ),
});

// ═════════════════════════════════════════════════════════════════════
// § Customers
// ═════════════════════════════════════════════════════════════════════

export const CreateCustomerSchema = z.object({
  email: z
    .string()
    .email()
    .optional()
    .describe("Customer's email address."),
  name: z
    .string()
    .optional()
    .describe("Customer's full name or business name."),
  description: z
    .string()
    .optional()
    .describe("Internal description of the customer (not shown to them)."),
  phone: z
    .string()
    .optional()
    .describe("Customer's phone number in E.164 format (e.g. +14155551234)."),
  metadata: MetadataSchema,
});
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export const ListCustomersSchema = PaginationSchema.extend({
  email: z
    .string()
    .email()
    .optional()
    .describe("Filter results to customers with this exact email address."),
});
export type ListCustomersInput = z.infer<typeof ListCustomersSchema>;

export const RetrieveCustomerSchema = z.object({
  customer_id: z
    .string()
    .startsWith("cus_")
    .describe("The unique Stripe customer ID (e.g. cus_ABC123)."),
});
export type RetrieveCustomerInput = z.infer<typeof RetrieveCustomerSchema>;

export const UpdateCustomerSchema = z.object({
  customer_id: z
    .string()
    .startsWith("cus_")
    .describe("The unique Stripe customer ID to update."),
  email: z
    .string()
    .email()
    .optional()
    .describe("New email address for the customer."),
  name: z
    .string()
    .optional()
    .describe("New name for the customer."),
  description: z
    .string()
    .optional()
    .describe("Updated internal description."),
  phone: z
    .string()
    .optional()
    .describe("Updated phone number in E.164 format."),
  metadata: MetadataSchema,
});
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export const DeleteCustomerSchema = z.object({
  customer_id: z
    .string()
    .startsWith("cus_")
    .describe("The customer ID to permanently delete."),
  force: z
    .boolean()
    .describe(
      "Must be true to confirm permanent deletion. This action is " +
        "irreversible. Consider using archive_customer instead.",
    ),
});
export type DeleteCustomerInput = z.infer<typeof DeleteCustomerSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Payment Intents
// ═════════════════════════════════════════════════════════════════════

export const CreatePaymentIntentSchema = z.object({
  amount: z
    .number()
    .int()
    .positive()
    .describe(
      "Amount in the smallest currency unit (e.g. cents for USD). " +
        "100 = $1.00 USD.",
    ),
  currency: z
    .string()
    .length(3)
    .toLowerCase()
    .describe("Three-letter ISO 4217 currency code in lowercase (e.g. 'usd', 'eur')."),
  customer: z
    .string()
    .startsWith("cus_")
    .optional()
    .describe("Stripe customer ID to associate with this payment."),
  description: z
    .string()
    .optional()
    .describe("Arbitrary description for internal use."),
  payment_method_types: z
    .array(z.string())
    .optional()
    .describe(
      "Allowable payment method types (e.g. ['card', 'us_bank_account']). " +
        "Omit to use Stripe's automatic payment methods.",
    ),
  metadata: MetadataSchema,
});
export type CreatePaymentIntentInput = z.infer<typeof CreatePaymentIntentSchema>;

export const ListPaymentIntentsSchema = PaginationSchema.extend({
  customer: z
    .string()
    .startsWith("cus_")
    .optional()
    .describe("Filter to payment intents for this customer."),
});
export type ListPaymentIntentsInput = z.infer<typeof ListPaymentIntentsSchema>;

export const RetrievePaymentIntentSchema = z.object({
  payment_intent_id: z
    .string()
    .startsWith("pi_")
    .describe("The unique Stripe payment intent ID (e.g. pi_ABC123)."),
});
export type RetrievePaymentIntentInput = z.infer<typeof RetrievePaymentIntentSchema>;

export const ConfirmPaymentIntentSchema = z.object({
  payment_intent_id: z
    .string()
    .startsWith("pi_")
    .describe("The payment intent ID to confirm."),
  payment_method: z
    .string()
    .startsWith("pm_")
    .optional()
    .describe("Payment method ID to attach and confirm with."),
});
export type ConfirmPaymentIntentInput = z.infer<typeof ConfirmPaymentIntentSchema>;

export const CancelPaymentIntentSchema = z.object({
  payment_intent_id: z
    .string()
    .startsWith("pi_")
    .describe("The payment intent ID to cancel."),
  cancellation_reason: z
    .enum(["duplicate", "fraudulent", "requested_by_customer", "abandoned"])
    .optional()
    .describe("Reason for cancellation — shown in the Stripe dashboard."),
});
export type CancelPaymentIntentInput = z.infer<typeof CancelPaymentIntentSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Invoices
// ═════════════════════════════════════════════════════════════════════

export const CreateInvoiceSchema = z.object({
  customer: z
    .string()
    .startsWith("cus_")
    .describe("The customer ID to bill."),
  collection_method: z
    .enum(["charge_automatically", "send_invoice"])
    .optional()
    .describe(
      "How to collect payment. 'charge_automatically' charges the default " +
        "payment method; 'send_invoice' emails an invoice with a payment link.",
    ),
  description: z
    .string()
    .optional()
    .describe("Description for this invoice (shown on the invoice PDF)."),
  auto_advance: z
    .boolean()
    .optional()
    .describe(
      "Whether Stripe should auto-finalize and attempt payment. " +
        "Defaults to true.",
    ),
  days_until_due: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Number of days until the invoice is due. Only applies when " +
        "collection_method is 'send_invoice'.",
    ),
  metadata: MetadataSchema,
});
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;

export const ListInvoicesSchema = PaginationSchema.extend({
  customer: z
    .string()
    .startsWith("cus_")
    .optional()
    .describe("Filter invoices to this customer."),
  status: z
    .enum(["draft", "open", "paid", "uncollectible", "void"])
    .optional()
    .describe("Filter invoices by status."),
});
export type ListInvoicesInput = z.infer<typeof ListInvoicesSchema>;

export const RetrieveInvoiceSchema = z.object({
  invoice_id: z
    .string()
    .startsWith("in_")
    .describe("The unique Stripe invoice ID (e.g. in_ABC123)."),
});
export type RetrieveInvoiceInput = z.infer<typeof RetrieveInvoiceSchema>;

export const FinalizeInvoiceSchema = z.object({
  invoice_id: z
    .string()
    .startsWith("in_")
    .describe("The draft invoice ID to finalize."),
  auto_advance: z
    .boolean()
    .optional()
    .describe(
      "Whether to auto-collect after finalizing. Defaults to the " +
        "invoice's existing auto_advance setting.",
    ),
});
export type FinalizeInvoiceInput = z.infer<typeof FinalizeInvoiceSchema>;

export const VoidInvoiceSchema = z.object({
  invoice_id: z
    .string()
    .startsWith("in_")
    .describe("The invoice ID to void. Invoice must be 'open'."),
});
export type VoidInvoiceInput = z.infer<typeof VoidInvoiceSchema>;

export const PayInvoiceSchema = z.object({
  invoice_id: z
    .string()
    .startsWith("in_")
    .describe("The invoice ID to attempt payment on. Must be in 'open' status."),
  payment_method: z
    .string()
    .startsWith("pm_")
    .optional()
    .describe(
      "Payment method ID to charge. Omit to use the customer's default " +
        "payment method.",
    ),
  forgive: z
    .boolean()
    .optional()
    .describe(
      "If true and the payment fails, mark the invoice as paid and " +
        "forgive the outstanding amount. Defaults to false.",
    ),
  off_session: z
    .boolean()
    .optional()
    .describe(
      "Set to true when the customer is not present during payment " +
        "(e.g. automated collection or retry).",
    ),
});
export type PayInvoiceInput = z.infer<typeof PayInvoiceSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Subscriptions
// ═════════════════════════════════════════════════════════════════════

/** A single line item when creating or updating a subscription. */
const SubscriptionItemSchema = z.object({
  price: z
    .string()
    .startsWith("price_")
    .describe("The Stripe price ID for this line item."),
  quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Quantity of the price to subscribe to. Defaults to 1."),
});

export const CreateSubscriptionSchema = z.object({
  customer: z
    .string()
    .startsWith("cus_")
    .describe("The customer ID to subscribe."),
  items: z
    .array(SubscriptionItemSchema)
    .min(1)
    .describe("One or more price/quantity pairs for the subscription."),
  payment_behavior: z
    .enum([
      "default_incomplete",
      "error_if_incomplete",
      "allow_incomplete",
      "pending_if_incomplete",
    ])
    .optional()
    .describe(
      "How to handle payment failures on creation. " +
        "Defaults to 'default_incomplete'.",
    ),
  collection_method: z
    .enum(["charge_automatically", "send_invoice"])
    .optional()
    .describe("How payment is collected. Defaults to 'charge_automatically'."),
  metadata: MetadataSchema,
});
export type CreateSubscriptionInput = z.infer<typeof CreateSubscriptionSchema>;

export const ListSubscriptionsSchema = PaginationSchema.extend({
  customer: z
    .string()
    .startsWith("cus_")
    .optional()
    .describe("Filter to subscriptions for this customer."),
  status: z
    .enum([
      "active",
      "past_due",
      "unpaid",
      "canceled",
      "incomplete",
      "incomplete_expired",
      "trialing",
      "all",
    ])
    .optional()
    .describe("Filter by subscription status. Pass 'all' to include every status."),
  price: z
    .string()
    .startsWith("price_")
    .optional()
    .describe("Filter to subscriptions containing this price."),
});
export type ListSubscriptionsInput = z.infer<typeof ListSubscriptionsSchema>;

export const RetrieveSubscriptionSchema = z.object({
  subscription_id: z
    .string()
    .startsWith("sub_")
    .describe("The unique Stripe subscription ID (e.g. sub_ABC123)."),
});
export type RetrieveSubscriptionInput = z.infer<typeof RetrieveSubscriptionSchema>;

export const UpdateSubscriptionSchema = z.object({
  subscription_id: z
    .string()
    .startsWith("sub_")
    .describe("The subscription ID to update."),
  items: z
    .array(
      SubscriptionItemSchema.extend({
        id: z
          .string()
          .optional()
          .describe(
            "Existing subscription item ID (si_...) to update. " +
              "Omit to add a new line item.",
          ),
        deleted: z
          .boolean()
          .optional()
          .describe("Set to true to remove this item from the subscription."),
      }),
    )
    .optional()
    .describe("Updated line items. Omit to leave items unchanged."),
  cancel_at_period_end: z
    .boolean()
    .optional()
    .describe(
      "If true, the subscription cancels at the end of the current " +
        "billing period instead of immediately.",
    ),
  proration_behavior: z
    .enum(["create_prorations", "none", "always_invoice"])
    .optional()
    .describe("How to handle proration when changing items mid-cycle."),
  metadata: MetadataSchema,
});
export type UpdateSubscriptionInput = z.infer<typeof UpdateSubscriptionSchema>;

export const CancelSubscriptionSchema = z.object({
  subscription_id: z
    .string()
    .startsWith("sub_")
    .describe("The subscription ID to cancel."),
  cancel_at_period_end: z
    .boolean()
    .optional()
    .describe(
      "If true, the subscription stays active until the end of the " +
        "current billing period, then cancels. If false or omitted, " +
        "cancels immediately.",
    ),
  invoice_now: z
    .boolean()
    .optional()
    .describe(
      "If true, generates a final invoice immediately for any " +
        "un-invoiced metered usage. Only applies to immediate cancellation.",
    ),
  prorate: z
    .boolean()
    .optional()
    .describe(
      "If true, a prorated credit is generated for unused time " +
        "in the current period. Only applies to immediate cancellation.",
    ),
});
export type CancelSubscriptionInput = z.infer<typeof CancelSubscriptionSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Products
// ═════════════════════════════════════════════════════════════════════

export const CreateProductSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("The product's name, displayed to customers in checkout."),
  description: z
    .string()
    .optional()
    .describe("Description of the product shown to customers."),
  active: z
    .boolean()
    .optional()
    .describe("Whether the product is available for purchase. Defaults to true."),
  images: z
    .array(z.string().url())
    .max(8)
    .optional()
    .describe("Up to 8 URLs of product images."),
  default_price_data: z
    .object({
      unit_amount: z
        .number()
        .int()
        .nonnegative()
        .describe("Default price in smallest currency unit (e.g. cents)."),
      currency: z
        .string()
        .length(3)
        .toLowerCase()
        .describe("Three-letter ISO 4217 currency code (e.g. 'usd')."),
      recurring: z
        .object({
          interval: z
            .enum(["day", "week", "month", "year"])
            .describe("Billing frequency."),
          interval_count: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Number of intervals between billings. Defaults to 1."),
        })
        .optional()
        .describe("Set to make this a recurring price. Omit for one-time."),
    })
    .optional()
    .describe("Inline default price to create alongside the product."),
  metadata: MetadataSchema,
});
export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const ListProductsSchema = PaginationSchema.extend({
  active: z
    .boolean()
    .optional()
    .describe("Filter to active or inactive products."),
});
export type ListProductsInput = z.infer<typeof ListProductsSchema>;

export const RetrieveProductSchema = z.object({
  product_id: z
    .string()
    .startsWith("prod_")
    .describe("The unique Stripe product ID (e.g. prod_ABC123)."),
});
export type RetrieveProductInput = z.infer<typeof RetrieveProductSchema>;

export const UpdateProductSchema = z.object({
  product_id: z
    .string()
    .startsWith("prod_")
    .describe("The product ID to update."),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Updated product name."),
  description: z
    .string()
    .optional()
    .describe("Updated description."),
  active: z
    .boolean()
    .optional()
    .describe("Set to false to archive the product."),
  metadata: MetadataSchema,
});
export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Prices
// ═════════════════════════════════════════════════════════════════════

export const CreatePriceSchema = z.object({
  unit_amount: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Price per unit in the smallest currency unit (e.g. cents). " +
        "100 = $1.00 USD.",
    ),
  currency: z
    .string()
    .length(3)
    .toLowerCase()
    .describe("Three-letter ISO 4217 currency code (e.g. 'usd')."),
  product: z
    .string()
    .startsWith("prod_")
    .describe("The product ID this price belongs to."),
  recurring: z
    .object({
      interval: z
        .enum(["day", "week", "month", "year"])
        .describe("Billing interval (e.g. 'month' for monthly billing)."),
      interval_count: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of intervals between charges. Defaults to 1."),
    })
    .optional()
    .describe("Set for recurring prices. Omit for one-time prices."),
  nickname: z
    .string()
    .optional()
    .describe("Brief internal label for this price (not shown to customers)."),
  metadata: MetadataSchema,
});
export type CreatePriceInput = z.infer<typeof CreatePriceSchema>;

export const ListPricesSchema = PaginationSchema.extend({
  product: z
    .string()
    .startsWith("prod_")
    .optional()
    .describe("Filter prices to this product."),
  active: z
    .boolean()
    .optional()
    .describe("Filter to active or inactive prices."),
  type: z
    .enum(["one_time", "recurring"])
    .optional()
    .describe("Filter by price type."),
});
export type ListPricesInput = z.infer<typeof ListPricesSchema>;

export const RetrievePriceSchema = z.object({
  price_id: z
    .string()
    .startsWith("price_")
    .describe("The unique Stripe price ID (e.g. price_ABC123)."),
});
export type RetrievePriceInput = z.infer<typeof RetrievePriceSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Refunds
// ═════════════════════════════════════════════════════════════════════

/**
 * Base fields for creating a refund.
 *
 * Exported separately from the refined schema so that `server.tool()`
 * can access `.shape` (ZodEffects from `.refine()` does not expose it).
 */
export const CreateRefundFields = z.object({
  payment_intent: z
    .string()
    .startsWith("pi_")
    .optional()
    .describe("The payment intent to refund. Provide this OR charge, not both."),
  charge: z
    .string()
    .startsWith("ch_")
    .optional()
    .describe("The charge to refund. Provide this OR payment_intent, not both."),
  amount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Amount to refund in smallest currency unit. " +
        "Omit for a full refund of the remaining amount.",
    ),
  reason: z
    .enum(["duplicate", "fraudulent", "requested_by_customer"])
    .optional()
    .describe("Reason for the refund — shown in the Stripe dashboard."),
  metadata: MetadataSchema,
});

/**
 * Full CreateRefund schema with cross-field validation.
 * Ensures exactly one of `payment_intent` or `charge` is provided.
 */
export const CreateRefundSchema = CreateRefundFields.refine(
  (data) =>
    (data.payment_intent !== undefined) !== (data.charge !== undefined),
  {
    message:
      "Exactly one of 'payment_intent' or 'charge' must be provided.",
  },
);
export type CreateRefundInput = z.infer<typeof CreateRefundSchema>;

export const ListRefundsSchema = PaginationSchema.extend({
  charge: z
    .string()
    .startsWith("ch_")
    .optional()
    .describe("Filter refunds to this charge."),
  payment_intent: z
    .string()
    .startsWith("pi_")
    .optional()
    .describe("Filter refunds to this payment intent."),
});
export type ListRefundsInput = z.infer<typeof ListRefundsSchema>;

export const RetrieveRefundSchema = z.object({
  refund_id: z
    .string()
    .startsWith("re_")
    .describe("The unique Stripe refund ID (e.g. re_ABC123)."),
});
export type RetrieveRefundInput = z.infer<typeof RetrieveRefundSchema>;

// ═════════════════════════════════════════════════════════════════════
// § Balance
// ═════════════════════════════════════════════════════════════════════

export const RetrieveBalanceSchema = z.object({}).describe(
  "No parameters required. Retrieves the current account balance.",
);
export type RetrieveBalanceInput = z.infer<typeof RetrieveBalanceSchema>;

export const ListBalanceTransactionsSchema = PaginationSchema.extend({
  type: z
    .string()
    .optional()
    .describe(
      "Filter by transaction type (e.g. 'charge', 'refund', " +
        "'adjustment', 'payout').",
    ),
  payout: z
    .string()
    .startsWith("po_")
    .optional()
    .describe("Filter to transactions associated with this payout."),
});
export type ListBalanceTransactionsInput = z.infer<
  typeof ListBalanceTransactionsSchema
>;

// ═════════════════════════════════════════════════════════════════════
// § Charges
// ═════════════════════════════════════════════════════════════════════

export const ListChargesSchema = PaginationSchema.extend({
  customer: z
    .string()
    .startsWith("cus_")
    .optional()
    .describe("Filter charges to this customer."),
});
export type ListChargesInput = z.infer<typeof ListChargesSchema>;

export const RetrieveChargeSchema = z.object({
  charge_id: z
    .string()
    .startsWith("ch_")
    .describe("The unique Stripe charge ID (e.g. ch_ABC123)."),
});
export type RetrieveChargeInput = z.infer<typeof RetrieveChargeSchema>;

// ═════════════════════════════════════════════════════════════════════
// § v1.0.0 — Archive, Purge, Audit, Approval Schemas
// ═════════════════════════════════════════════════════════════════════

export const ArchiveCustomerSchema = z.object({
  customer_id: z
    .string()
    .startsWith("cus_")
    .describe("The customer ID to archive (soft delete)."),
});
export type ArchiveCustomerInput = z.infer<typeof ArchiveCustomerSchema>;

export const PurgeExpiredCustomersSchema = z.object({
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "If true, list customers that would be purged without deleting them.",
    ),
});
export type PurgeExpiredCustomersInput = z.infer<
  typeof PurgeExpiredCustomersSchema
>;

export const GetAuditLogSchema = z.object({
  customer_id: z
    .string()
    .startsWith("cus_")
    .optional()
    .describe("Filter by customer ID."),
  tool_name: z
    .string()
    .optional()
    .describe("Filter by tool name (e.g. 'create_refund')."),
  operation_type: z
    .enum([
      "create",
      "update",
      "delete",
      "cancel",
      "refund",
      "pay",
      "confirm",
      "archive",
      "purge",
    ])
    .optional()
    .describe("Filter by operation type."),
  outcome: z
    .enum(["success", "error", "blocked", "dry_run", "pending_approval"])
    .optional()
    .describe("Filter by outcome."),
  start_date: z
    .string()
    .optional()
    .describe("ISO 8601 start date (inclusive)."),
  end_date: z
    .string()
    .optional()
    .describe("ISO 8601 end date (inclusive)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Max entries to return (default 50)."),
});
export type GetAuditLogInput = z.infer<typeof GetAuditLogSchema>;

export const GetApprovalStatusSchema = z.object({
  token: z
    .string()
    .uuid()
    .describe("The approval token UUID to check."),
});
export type GetApprovalStatusInput = z.infer<typeof GetApprovalStatusSchema>;
