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
import type {
  CreateCustomerInput,
  DeleteCustomerInput,
  ListCustomersInput,
  McpToolResponse,
  RetrieveCustomerInput,
  UpdateCustomerInput,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createCustomer
// ═════════════════════════════════════════════════════════════════════

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
  try {
    const customer = await stripe.customers.create({
      email: input.email,
      name: input.name,
      description: input.description,
      phone: input.phone,
      metadata: input.metadata,
    });

    return { success: true, data: customer };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
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
  try {
    const { customer_id, ...params } = input;

    const customer = await stripe.customers.update(customer_id, {
      email: params.email,
      name: params.name,
      description: params.description,
      phone: params.phone,
      metadata: params.metadata,
    });

    return { success: true, data: customer };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § deleteCustomer
// ═════════════════════════════════════════════════════════════════════

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
  try {
    const deleted = await stripe.customers.del(input.customer_id);

    return { success: true, data: deleted };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
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
