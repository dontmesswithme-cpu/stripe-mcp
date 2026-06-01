/**
 * @module tools/customers
 *
 * MCP tool handlers for Stripe Customer operations.
 *
 * Each function accepts a validated input object (from the corresponding
 * Zod schema in `types.ts`), calls the Stripe SDK, and returns a
 * {@link McpToolResponse} discriminated union.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { toErrorResponse } from "../utils/errors.js";
import { executeStripeOperation } from "../middleware/execute.js";
import { config } from "../config.js";
import type {
  ArchiveCustomerInput,
  CreateCustomerInput,
  DeleteCustomerInput,
  ListCustomersInput,
  McpToolResponse,
  PurgeExpiredCustomersInput,
  PurgeResult,
  RetrieveCustomerInput,
  ToolCapability,
  UpdateCustomerInput,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createCustomer
// ═════════════════════════════════════════════════════════════════════

const createCustomerCapability: ToolCapability = {
  tool: "create_customer",
  operation: "create",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Create a new Stripe customer.
 *
 * @description Creates a customer object in Stripe with the supplied
 *   profile fields. All fields are optional — an empty call creates a
 *   bare customer that can be enriched later.
 * @param input - Validated {@link CreateCustomerInput} (email, name,
 *   description, phone, metadata — all optional).
 * @returns A {@link McpToolResponse} containing the newly created
 *   `Stripe.Customer` on success, or a structured error on failure.
 * @throws Never — all Stripe errors are caught and mapped to the
 *   failure branch of the response union.
 */
export async function createCustomer(
  input: CreateCustomerInput,
): Promise<McpToolResponse<Stripe.Customer>> {
  return executeStripeOperation(
    {
      capability: createCustomerCapability,
      customerId: undefined,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    (options) =>
      stripe.customers.create({
        email: input.email,
        name: input.name,
        description: input.description,
        phone: input.phone,
        metadata: input.metadata,
      }, options),
  );
}

// ═════════════════════════════════════════════════════════════════════
// § retrieveCustomer
// ═════════════════════════════════════════════════════════════════════

/**
 * Retrieve a Stripe customer by ID.
 *
 * @description Fetches the full customer object. If the customer has
 *   been deleted, returns a structured error rather than the tombstone
 *   object so callers don't need to inspect `deleted` themselves.
 * @param input - Validated {@link RetrieveCustomerInput} with the
 *   `customer_id` (must start with `cus_`).
 * @returns A {@link McpToolResponse} containing the `Stripe.Customer`
 *   on success, or a structured error if the customer is deleted or
 *   does not exist.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function retrieveCustomer(
  input: RetrieveCustomerInput,
): Promise<McpToolResponse<Stripe.Customer>> {
  try {
    const customer = await stripe.customers.retrieve(input.customer_id);

    // The SDK returns Stripe.Customer | Stripe.DeletedCustomer.
    // Surface a clear error instead of silently returning the tombstone.
    if (isDeleted(customer)) {
      return {
        success: false,
        error: {
          code: "resource_deleted",
          type: "invalid_request_error",
          message:
            `Customer ${input.customer_id} has been deleted and cannot be retrieved. ` +
            "Create a new customer instead.",
        },
      };
    }

    return { success: true, data: customer };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § updateCustomer
// ═════════════════════════════════════════════════════════════════════

const updateCustomerCapability: ToolCapability = {
  tool: "update_customer",
  operation: "update",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Update an existing Stripe customer.
 *
 * @description Patches the customer with any supplied fields. Only the
 *   fields present in the input are sent to Stripe — omitted fields
 *   remain unchanged on the customer object.
 * @param input - Validated {@link UpdateCustomerInput}. `customer_id`
 *   is required; all other fields (email, name, description, phone,
 *   metadata) are optional.
 * @returns A {@link McpToolResponse} containing the updated
 *   `Stripe.Customer` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function updateCustomer(
  input: UpdateCustomerInput,
): Promise<McpToolResponse<Stripe.Customer>> {
  return executeStripeOperation(
    {
      capability: updateCustomerCapability,
      customerId: input.customer_id,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    (options) => {
      const { customer_id, ...params } = input;

      return stripe.customers.update(customer_id, {
        email: params.email,
        name: params.name,
        description: params.description,
        phone: params.phone,
        metadata: params.metadata,
      }, options);
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// § deleteCustomer
// ═════════════════════════════════════════════════════════════════════

const deleteCustomerCapability: ToolCapability = {
  tool: "delete_customer",
  operation: "delete",
  readOnly: false,
  riskScored: true,
  approvalEligible: true,
};

/**
 * Permanently delete a Stripe customer.
 *
 * @description Deletes the customer and cancels any active subscriptions.
 *   This action is **irreversible**. The returned `Stripe.DeletedCustomer`
 *   confirms deletion with `{ id, object: "customer", deleted: true }`.
 * @param input - Validated {@link DeleteCustomerInput} with the
 *   `customer_id` to delete.
 * @returns A {@link McpToolResponse} containing the
 *   `Stripe.DeletedCustomer` confirmation on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function deleteCustomer(
  input: DeleteCustomerInput,
): Promise<McpToolResponse<Stripe.DeletedCustomer>> {
  if (!input.force) {
    return {
      success: false,
      error: {
        code: "confirmation_required",
        type: "invalid_request_error",
        message:
          "Set force: true to confirm permanent deletion. Consider using archive_customer instead.",
      },
    };
  }

  return executeStripeOperation(
    {
      capability: deleteCustomerCapability,
      customerId: input.customer_id,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    (options) => stripe.customers.del(input.customer_id, options),
  );
}

// ═════════════════════════════════════════════════════════════════════
// § archiveCustomer
// ═════════════════════════════════════════════════════════════════════

const archiveCustomerCapability: ToolCapability = {
  tool: "archive_customer",
  operation: "archive",
  readOnly: false,
  riskScored: false,
  approvalEligible: false,
};

/**
 * Archive a Stripe customer by setting archived metadata and a
 * `delete_after` date.
 *
 * @description Sets archived metadata + delete_after date on the
 *   customer. The customer is not deleted — it is marked for future
 *   purging by {@link purgeExpiredCustomers}.
 * @param input - Validated {@link ArchiveCustomerInput} with the
 *   `customer_id` to archive.
 * @returns A {@link McpToolResponse} containing the updated
 *   `Stripe.Customer` with archived metadata on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function archiveCustomer(
  input: ArchiveCustomerInput,
): Promise<McpToolResponse<Stripe.Customer>> {
  return executeStripeOperation(
    {
      capability: archiveCustomerCapability,
      customerId: input.customer_id,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    (options) => {
      const deleteAfter = new Date(
        Date.now() + config.archiveDeleteAfterDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      return stripe.customers.update(input.customer_id, {
        metadata: {
          archived: "true",
          archived_at: new Date().toISOString(),
          delete_after: deleteAfter,
        },
      }, options);
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// § purgeExpiredCustomers
// ═════════════════════════════════════════════════════════════════════

const purgeExpiredCustomersCapability: ToolCapability = {
  tool: "purge_expired_customers",
  operation: "purge",
  readOnly: false,
  riskScored: true,
  approvalEligible: true,
};

/**
 * Purge customers whose `delete_after` date has passed.
 *
 * @description Searches for customers with `archived: "true"` metadata
 *   whose `delete_after` timestamp is in the past. In dry-run mode,
 *   returns the list without deleting. Otherwise, permanently deletes
 *   each expired customer.
 * @param input - Validated {@link PurgeExpiredCustomersInput}. `dry_run`
 *   controls whether deletions are actually performed.
 * @returns A {@link McpToolResponse} containing a {@link PurgeResult}
 *   with the count and IDs of purged (or purgeable) customers.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function purgeExpiredCustomers(
  input: PurgeExpiredCustomersInput,
): Promise<McpToolResponse<PurgeResult>> {
  return executeStripeOperation(
    {
      capability: purgeExpiredCustomersCapability,
      customerId: undefined,
      amount: undefined,
      currency: undefined,
      params: input as Record<string, unknown>,
    },
    async (options) => {
      const now = new Date();
      const expiredIds: string[] = [];
      
      // Auto-paginate through all results
      for await (const customer of stripe.customers.search({ query: 'metadata["archived"]:"true"' }, options)) {
        const deleteAfter = customer.metadata?.delete_after;
        if (deleteAfter && new Date(deleteAfter) <= now) {
          expiredIds.push(customer.id);
        }
      }

      if (input.dry_run === true) {
        return { 
          dry_run: true, 
          count: expiredIds.length, 
          customers: expiredIds, 
          errors: [] 
        } as PurgeResult;
      }

      const deleted: string[] = [];
      const errors: { id: string; error: string }[] = [];
      
      // Native bounded concurrency (rolling window)
      const CONCURRENCY_LIMIT = 15; 
      let index = 0;

      const worker = async () => {
        while (index < expiredIds.length) {
          const id = expiredIds[index++];
          try {
            await stripe.customers.del(id, options);
            deleted.push(id);
          } catch (error: any) {
            errors.push({ id, error: error.message || "Unknown error" });
          }
        }
      };

      // Spawn workers up to the concurrency limit
      const workers = Array.from(
        { length: Math.min(CONCURRENCY_LIMIT, expiredIds.length) }, 
        () => worker()
      );
      
      await Promise.all(workers);

      return { 
        dry_run: false, 
        count: deleted.length, 
        customers: deleted, 
        errors 
      } as PurgeResult;
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// § listCustomers
// ═════════════════════════════════════════════════════════════════════

/**
 * List Stripe customers with optional filters and pagination.
 *
 * @description Returns a paginated list of customers. Results can be
 *   filtered by email and paginated via cursor-based `starting_after`
 *   / `ending_before` params. The response includes `has_more` to
 *   indicate whether additional pages exist.
 * @param input - Validated {@link ListCustomersInput} with optional
 *   `limit`, `email`, `starting_after`, and `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.Customer>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listCustomers(
  input: ListCustomersInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.Customer>>> {
  try {
    const list = await stripe.customers.list({
      limit: input.limit,
      email: input.email,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Type guard for {@link Stripe.DeletedCustomer}.
 *
 * The Stripe SDK returns `Customer | DeletedCustomer` from `retrieve`.
 * This narrows the union so callers can handle the deleted case explicitly.
 */
function isDeleted(
  customer: Stripe.Customer | Stripe.DeletedCustomer,
): customer is Stripe.DeletedCustomer {
  return "deleted" in customer && customer.deleted === true;
}
