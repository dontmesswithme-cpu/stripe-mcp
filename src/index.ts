#!/usr/bin/env node

/**
 * @module stripe-mcp
 *
 * Entry point for the Stripe MCP server.
 *
 * - Validates required environment variables at startup.
 * - Registers 25 MCP tools across 7 Stripe domains.
 * - Connects via stdio transport (stdout is reserved for MCP protocol;
 *   all diagnostic output is written to stderr).
 * - Handles SIGINT / SIGTERM for graceful shutdown.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── Eagerly validate Stripe client (env check at module load) ───────
import "./stripe-client.js";

// ── Tool handlers ───────────────────────────────────────────────────

import {
  createCustomer,
  retrieveCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomers,
} from "./tools/customers.js";

import {
  createPaymentIntent,
  retrievePaymentIntent,
  confirmPaymentIntent,
  cancelPaymentIntent,
  listPaymentIntents,
} from "./tools/payments.js";

import {
  createSubscription,
  retrieveSubscription,
  updateSubscription,
  cancelSubscription,
  listSubscriptions,
} from "./tools/subscriptions.js";

import {
  createProduct,
  listProducts,
  createPrice,
  listPrices,
} from "./tools/products.js";

import {
  retrieveInvoice,
  listInvoices,
  payInvoice,
} from "./tools/invoices.js";

import { retrieveBalance } from "./tools/balance.js";

import { createRefund, listRefunds } from "./tools/refunds.js";

// ── Zod schemas (for server.tool() registration) ────────────────────

import {
  // Customers
  CreateCustomerSchema,
  RetrieveCustomerSchema,
  UpdateCustomerSchema,
  DeleteCustomerSchema,
  ListCustomersSchema,

  // Payment Intents
  CreatePaymentIntentSchema,
  RetrievePaymentIntentSchema,
  ConfirmPaymentIntentSchema,
  CancelPaymentIntentSchema,
  ListPaymentIntentsSchema,

  // Subscriptions
  CreateSubscriptionSchema,
  RetrieveSubscriptionSchema,
  UpdateSubscriptionSchema,
  CancelSubscriptionSchema,
  ListSubscriptionsSchema,

  // Products & Prices
  CreateProductSchema,
  ListProductsSchema,
  CreatePriceSchema,
  ListPricesSchema,

  // Invoices
  RetrieveInvoiceSchema,
  ListInvoicesSchema,
  PayInvoiceSchema,

  // Balance
  RetrieveBalanceSchema,

  // Refunds — use the base ZodObject (not the refined ZodEffects)
  // so .shape is accessible. The handler validates the XOR constraint.
  CreateRefundFields,
  ListRefundsSchema,
} from "./types.js";

import type { McpToolResponse } from "./types.js";

// ── Package metadata ────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PackageJson {
  readonly version: string;
  readonly name: string;
}

const pkg: PackageJson = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
) as PackageJson;

// ── Response formatter ──────────────────────────────────────────────

/**
 * Convert a {@link McpToolResponse} into the content-array shape that
 * `server.tool()` handlers must return.
 *
 * - Success → JSON-serialized `data` as a text block.
 * - Failure → JSON-serialized `error` with `isError: true`.
 */
function formatResponse<T>(result: McpToolResponse<T>): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (result.success) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.error, null, 2) }],
    isError: true,
  };
}

// ── Server bootstrap ────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new McpServer({
    name: "stripe-mcp",
    version: pkg.version,
  });

  // ────────────────────────────────────────────────────────────────
  // § Customer Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_customer",
    "Create a new Stripe customer with optional email, name, phone, description, and metadata.",
    CreateCustomerSchema.shape,
    async (args) => formatResponse(await createCustomer(args)),
  );

  server.tool(
    "retrieve_customer",
    "Retrieve a Stripe customer by their unique ID (cus_xxx).",
    RetrieveCustomerSchema.shape,
    async (args) => formatResponse(await retrieveCustomer(args)),
  );

  server.tool(
    "update_customer",
    "Update an existing customer's email, name, phone, description, or metadata.",
    UpdateCustomerSchema.shape,
    async (args) => formatResponse(await updateCustomer(args)),
  );

  server.tool(
    "delete_customer",
    "Permanently delete a customer and cancel all their active subscriptions. This is irreversible.",
    DeleteCustomerSchema.shape,
    async (args) => formatResponse(await deleteCustomer(args)),
  );

  server.tool(
    "list_customers",
    "List customers with optional email filter and cursor-based pagination.",
    ListCustomersSchema.shape,
    async (args) => formatResponse(await listCustomers(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Payment Intent Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_payment_intent",
    "Create a payment intent for a specified amount and currency. Optionally associate with a customer.",
    CreatePaymentIntentSchema.shape,
    async (args) => formatResponse(await createPaymentIntent(args)),
  );

  server.tool(
    "retrieve_payment_intent",
    "Retrieve a payment intent by its unique ID (pi_xxx).",
    RetrievePaymentIntentSchema.shape,
    async (args) => formatResponse(await retrievePaymentIntent(args)),
  );

  server.tool(
    "confirm_payment_intent",
    "Confirm a payment intent to initiate payment collection. Optionally attach a payment method.",
    ConfirmPaymentIntentSchema.shape,
    async (args) => formatResponse(await confirmPaymentIntent(args)),
  );

  server.tool(
    "cancel_payment_intent",
    "Cancel a payment intent that has not yet been captured. Accepts an optional cancellation reason.",
    CancelPaymentIntentSchema.shape,
    async (args) => formatResponse(await cancelPaymentIntent(args)),
  );

  server.tool(
    "list_payment_intents",
    "List payment intents with optional customer filter and cursor-based pagination.",
    ListPaymentIntentsSchema.shape,
    async (args) => formatResponse(await listPaymentIntents(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Subscription Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_subscription",
    "Create a subscription for a customer with one or more price line items.",
    CreateSubscriptionSchema.shape,
    async (args) => formatResponse(await createSubscription(args)),
  );

  server.tool(
    "retrieve_subscription",
    "Retrieve a subscription by its unique ID (sub_xxx).",
    RetrieveSubscriptionSchema.shape,
    async (args) => formatResponse(await retrieveSubscription(args)),
  );

  server.tool(
    "update_subscription",
    "Update subscription items, billing cycle, proration behavior, or metadata.",
    UpdateSubscriptionSchema.shape,
    async (args) => formatResponse(await updateSubscription(args)),
  );

  server.tool(
    "cancel_subscription",
    "Cancel a subscription immediately or at the end of the current billing period.",
    CancelSubscriptionSchema.shape,
    async (args) => formatResponse(await cancelSubscription(args)),
  );

  server.tool(
    "list_subscriptions",
    "List subscriptions with optional customer, status, and price filters.",
    ListSubscriptionsSchema.shape,
    async (args) => formatResponse(await listSubscriptions(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Product & Price Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_product",
    "Create a product in the Stripe catalog. Optionally include an inline default price.",
    CreateProductSchema.shape,
    async (args) => formatResponse(await createProduct(args)),
  );

  server.tool(
    "list_products",
    "List products with optional active/inactive filter and cursor-based pagination.",
    ListProductsSchema.shape,
    async (args) => formatResponse(await listProducts(args)),
  );

  server.tool(
    "create_price",
    "Create a recurring or one-time price for an existing product.",
    CreatePriceSchema.shape,
    async (args) => formatResponse(await createPrice(args)),
  );

  server.tool(
    "list_prices",
    "List prices with optional product, active, and type (one_time/recurring) filters.",
    ListPricesSchema.shape,
    async (args) => formatResponse(await listPrices(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Invoice Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "retrieve_invoice",
    "Retrieve an invoice by ID with full line item details and PDF link.",
    RetrieveInvoiceSchema.shape,
    async (args) => formatResponse(await retrieveInvoice(args)),
  );

  server.tool(
    "list_invoices",
    "List invoices with optional customer and status filters.",
    ListInvoicesSchema.shape,
    async (args) => formatResponse(await listInvoices(args)),
  );

  server.tool(
    "pay_invoice",
    "Attempt to collect payment on an open invoice. Supports payment method override and off-session mode.",
    PayInvoiceSchema.shape,
    async (args) => formatResponse(await payInvoice(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Balance Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "retrieve_balance",
    "Retrieve the current Stripe account balance broken down by available and pending amounts per currency.",
    RetrieveBalanceSchema.shape,
    async () => formatResponse(await retrieveBalance()),
  );

  // ────────────────────────────────────────────────────────────────
  // § Refund Tools
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_refund",
    "Refund a charge or payment intent — fully or partially. Provide exactly one of payment_intent or charge.",
    CreateRefundFields.shape,
    async (args) => formatResponse(await createRefund(args)),
  );

  server.tool(
    "list_refunds",
    "List refunds with optional charge or payment intent filters and cursor-based pagination.",
    ListRefundsSchema.shape,
    async (args) => formatResponse(await listRefunds(args)),
  );

  // ── Transport & Lifecycle ──────────────────────────────────────

  const transport = new StdioServerTransport();

  /**
   * Graceful shutdown on SIGINT / SIGTERM.
   * Closes the MCP server (flushes pending responses) before exiting.
   */
  const shutdown = async (signal: string): Promise<void> => {
    console.error(`\nstripe-mcp: received ${signal}, shutting down…`);
    try {
      await server.close();
    } catch {
      // Best-effort — transport may already be closed.
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);

  console.error(
    `stripe-mcp v${pkg.version} ready — 25 tools registered, listening on stdio`,
  );
}

// ── Top-level entry ─────────────────────────────────────────────────

main().catch((error: unknown) => {
  console.error("Fatal: failed to start stripe-mcp server");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
