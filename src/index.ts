#!/usr/bin/env node

/**
 * @module stripe-mcp
 *
 * Entry point for the Stripe MCP server (v1.0.0).
 *
 * - Validates required environment variables at startup.
 * - Initializes SQLite databases for audit logging and approvals.
 * - Starts the approval HTTP server (configurable port).
 * - Registers 28 MCP tools across 8 domains.
 * - Connects via stdio transport (stdout is reserved for MCP protocol;
 *   all diagnostic output is written to stderr).
 * - Handles SIGINT / SIGTERM for graceful shutdown.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ── Eagerly validate Stripe client (env check at module load) ───────
import "./stripe-client.js";

// ── Infrastructure ──────────────────────────────────────────────────
import { config } from "./config.js";
import { runDbOp, shutdownDbWorker } from "./worker/db/db.client.js";
import { startApprovalServer, stopApprovalServer } from "./approval/server.js";
import {
  startReconciliationLoop,
  stopReconciliationLoop,
} from "./reconciliation/scheduler.js";
import {
  startAuditPruneLoop,
  stopAuditPruneLoop,
} from "./audit/scheduler.js";
// DB init is moved to the worker
import { logger } from "./utils/logger.js";

// ── Tool handlers ───────────────────────────────────────────────────

import {
  createCustomer,
  retrieveCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomers,
  archiveCustomer,
  purgeExpiredCustomers,
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

import { getAuditLog } from "./tools/audit.js";

// ── Zod schemas (for server.tool() registration) ────────────────────

import {
  // Customers
  CreateCustomerSchema,
  RetrieveCustomerSchema,
  UpdateCustomerSchema,
  DeleteCustomerSchema,
  ListCustomersSchema,
  ArchiveCustomerSchema,
  PurgeExpiredCustomersSchema,

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

  // Refunds
  CreateRefundFields,
  ListRefundsSchema,

  // Admin
  GetAuditLogSchema,
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
      content: [
        { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
      ],
    };
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(result.error, null, 2) },
    ],
    isError: true,
  };
}

// ── Server bootstrap ────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = new McpServer({
    name: "stripe-mcp",
    version: pkg.version,
  });

  // ── Migrate databases via DB worker ─
  await runDbOp("initializeAllDatabases");

  // ── Start approval HTTP server ──────────────────────────────────
  startApprovalServer();

  // ── Reconciliation loop (single-flight, idempotent replay) ───────
  startReconciliationLoop();

  // ── Audit pruning loop ──────────────────────────────────────────
  startAuditPruneLoop();

  // ────────────────────────────────────────────────────────────────
  // § Customer Tools (7)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_customer",
    "Create a new Stripe customer with optional email, name, phone, description, and metadata.",
    CreateCustomerSchema.shape,
    async (args: z.infer<typeof CreateCustomerSchema>) => formatResponse(await createCustomer(args)),
  );

  server.tool(
    "retrieve_customer",
    "Retrieve a Stripe customer by their unique ID (cus_xxx).",
    RetrieveCustomerSchema.shape,
    async (args: z.infer<typeof RetrieveCustomerSchema>) => formatResponse(await retrieveCustomer(args)),
  );

  server.tool(
    "update_customer",
    "Update an existing customer's email, name, phone, description, or metadata.",
    UpdateCustomerSchema.shape,
    async (args: z.infer<typeof UpdateCustomerSchema>) => formatResponse(await updateCustomer(args)),
  );

  server.tool(
    "delete_customer",
    "Permanently delete a customer. Requires force: true. Routes through risk engine and approval. Consider archive_customer instead.",
    DeleteCustomerSchema.shape,
    async (args: z.infer<typeof DeleteCustomerSchema>) => formatResponse(await deleteCustomer(args)),
  );

  server.tool(
    "list_customers",
    "List customers with optional email filter and cursor-based pagination.",
    ListCustomersSchema.shape,
    async (args: z.infer<typeof ListCustomersSchema>) => formatResponse(await listCustomers(args)),
  );

  server.tool(
    "archive_customer",
    "Soft-delete a customer by setting archived metadata. The customer remains in Stripe but is flagged for future purge.",
    ArchiveCustomerSchema.shape,
    async (args: z.infer<typeof ArchiveCustomerSchema>) => formatResponse(await archiveCustomer(args)),
  );

  server.tool(
    "purge_expired_customers",
    "Find and permanently delete customers whose archive period has expired. Use dry_run: true to preview.",
    PurgeExpiredCustomersSchema.shape,
    async (args: z.infer<typeof PurgeExpiredCustomersSchema>) => formatResponse(await purgeExpiredCustomers(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Payment Intent Tools (5)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_payment_intent",
    "Create a payment intent for a specified amount and currency. Optionally associate with a customer.",
    CreatePaymentIntentSchema.shape,
    async (args: z.infer<typeof CreatePaymentIntentSchema>) => formatResponse(await createPaymentIntent(args)),
  );

  server.tool(
    "retrieve_payment_intent",
    "Retrieve a payment intent by its unique ID (pi_xxx).",
    RetrievePaymentIntentSchema.shape,
    async (args: z.infer<typeof RetrievePaymentIntentSchema>) => formatResponse(await retrievePaymentIntent(args)),
  );

  server.tool(
    "confirm_payment_intent",
    "Confirm a payment intent to initiate payment collection. Optionally attach a payment method.",
    ConfirmPaymentIntentSchema.shape,
    async (args: z.infer<typeof ConfirmPaymentIntentSchema>) => formatResponse(await confirmPaymentIntent(args)),
  );

  server.tool(
    "cancel_payment_intent",
    "Cancel a payment intent that has not yet been captured. Accepts an optional cancellation reason.",
    CancelPaymentIntentSchema.shape,
    async (args: z.infer<typeof CancelPaymentIntentSchema>) => formatResponse(await cancelPaymentIntent(args)),
  );

  server.tool(
    "list_payment_intents",
    "List payment intents with optional customer filter and cursor-based pagination.",
    ListPaymentIntentsSchema.shape,
    async (args: z.infer<typeof ListPaymentIntentsSchema>) => formatResponse(await listPaymentIntents(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Subscription Tools (5)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_subscription",
    "Create a subscription for a customer with one or more price line items.",
    CreateSubscriptionSchema.shape,
    async (args: z.infer<typeof CreateSubscriptionSchema>) => formatResponse(await createSubscription(args)),
  );

  server.tool(
    "retrieve_subscription",
    "Retrieve a subscription by its unique ID (sub_xxx).",
    RetrieveSubscriptionSchema.shape,
    async (args: z.infer<typeof RetrieveSubscriptionSchema>) => formatResponse(await retrieveSubscription(args)),
  );

  server.tool(
    "update_subscription",
    "Update subscription items, billing cycle, proration behavior, or metadata.",
    UpdateSubscriptionSchema.shape,
    async (args: z.infer<typeof UpdateSubscriptionSchema>) => formatResponse(await updateSubscription(args)),
  );

  server.tool(
    "cancel_subscription",
    "Cancel a subscription immediately or at the end of the current billing period. Routes through risk engine.",
    CancelSubscriptionSchema.shape,
    async (args: z.infer<typeof CancelSubscriptionSchema>) => formatResponse(await cancelSubscription(args)),
  );

  server.tool(
    "list_subscriptions",
    "List subscriptions with optional customer, status, and price filters.",
    ListSubscriptionsSchema.shape,
    async (args: z.infer<typeof ListSubscriptionsSchema>) => formatResponse(await listSubscriptions(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Product & Price Tools (4)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_product",
    "Create a product in the Stripe catalog. Optionally include an inline default price.",
    CreateProductSchema.shape,
    async (args: z.infer<typeof CreateProductSchema>) => formatResponse(await createProduct(args)),
  );

  server.tool(
    "list_products",
    "List products with optional active/inactive filter and cursor-based pagination.",
    ListProductsSchema.shape,
    async (args: z.infer<typeof ListProductsSchema>) => formatResponse(await listProducts(args)),
  );

  server.tool(
    "create_price",
    "Create a recurring or one-time price for an existing product.",
    CreatePriceSchema.shape,
    async (args: z.infer<typeof CreatePriceSchema>) => formatResponse(await createPrice(args)),
  );

  server.tool(
    "list_prices",
    "List prices with optional product, active, and type (one_time/recurring) filters.",
    ListPricesSchema.shape,
    async (args: z.infer<typeof ListPricesSchema>) => formatResponse(await listPrices(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Invoice Tools (3)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "retrieve_invoice",
    "Retrieve an invoice by ID with full line item details and PDF link.",
    RetrieveInvoiceSchema.shape,
    async (args: z.infer<typeof RetrieveInvoiceSchema>) => formatResponse(await retrieveInvoice(args)),
  );

  server.tool(
    "list_invoices",
    "List invoices with optional customer and status filters.",
    ListInvoicesSchema.shape,
    async (args: z.infer<typeof ListInvoicesSchema>) => formatResponse(await listInvoices(args)),
  );

  server.tool(
    "pay_invoice",
    "Attempt to collect payment on an open invoice. Supports payment method override and off-session mode.",
    PayInvoiceSchema.shape,
    async (args: z.infer<typeof PayInvoiceSchema>) => formatResponse(await payInvoice(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Balance Tools (1)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "retrieve_balance",
    "Retrieve the current Stripe account balance broken down by available and pending amounts per currency.",
    RetrieveBalanceSchema.shape,
    async () => formatResponse(await retrieveBalance()),
  );

  // ────────────────────────────────────────────────────────────────
  // § Refund Tools (2)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "create_refund",
    "Refund a charge or payment intent — fully or partially. Routes through risk engine and approval for high-value refunds.",
    CreateRefundFields.shape,
    async (args: z.infer<typeof CreateRefundFields>) => formatResponse(await createRefund(args)),
  );

  server.tool(
    "list_refunds",
    "List refunds with optional charge or payment intent filters and cursor-based pagination.",
    ListRefundsSchema.shape,
    async (args: z.infer<typeof ListRefundsSchema>) => formatResponse(await listRefunds(args)),
  );

  // ────────────────────────────────────────────────────────────────
  // § Audit Tools (1)
  // ────────────────────────────────────────────────────────────────

  server.tool(
    "get_audit_log",
    "Query the operation audit log. Filter by customer, tool, operation type, outcome, or date range.",
    GetAuditLogSchema.shape,
    async (args: z.infer<typeof GetAuditLogSchema>) => formatResponse(await getAuditLog(args)),
  );

  // ── Transport & Lifecycle ──────────────────────────────────────

  const transport = new StdioServerTransport();

  /**
   * Graceful shutdown on SIGINT / SIGTERM.
   * Closes MCP server, flushes databases, then exits.
   */
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "received signal, shutting down…");
    stopReconciliationLoop();
    stopAuditPruneLoop();
    try {
      await server.close();
    } catch {
      // Best-effort — transport may already be closed.
    }
    try {
      await stopApprovalServer();
    } catch {
      // Best-effort.
    }
    await shutdownDbWorker();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);

  logger.info({ version: pkg.version }, "stripe-mcp initialized");
  
  if (config.dryRun) {
    logger.warn("MODE: DRY-RUN (Mutations simulated, no API calls)");
  } else if (config.readOnly) {
    logger.warn("MODE: READ-ONLY (Mutations completely blocked)");
  } else {
    logger.info("MODE: LIVE (Mutations active)");
  }

  if (config.approvalPort > 0 && config.approvalApiHash) {
    logger.info({ port: config.approvalPort }, "APPROVALS: HTTP Server listening");
  } else {
    logger.warn("APPROVALS: Server disabled (APPROVAL_PORT=0 or APPROVAL_API_KEY missing)");
  }

  logger.info(
    {
      block: config.riskBlockThreshold,
      flag: config.riskFlagThreshold,
      highAmount: config.riskAmountHigh,
      critAmount: config.riskAmountCritical,
    },
    "RISK THRESHOLDS"
  );
  logger.info("Ready — 28 tools registered, listening on stdio.");
}

// ── Top-level entry ─────────────────────────────────────────────────

main().catch((error: unknown) => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, "Fatal: failed to start stripe-mcp server");
  process.exit(1);
});
