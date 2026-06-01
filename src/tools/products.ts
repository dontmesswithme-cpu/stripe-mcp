/**
 * @module tools/products
 *
 * MCP tool handlers for Stripe Product and Price operations.
 *
 * Products and Prices are combined in a single module because they are
 * tightly coupled — a Price always belongs to a Product, and creating
 * a Product often involves creating its initial Price in the same flow.
 *
 * Each function accepts a validated input object (from the corresponding
 * Zod schema in `types.ts`), calls the Stripe SDK, and returns a
 * {@link McpToolResponse} discriminated union.
 */

import type Stripe from "stripe";
import { stripe } from "../stripe-client.js";
import { toErrorResponse } from "../utils/errors.js";
import type {
  CreatePriceInput,
  CreateProductInput,
  ListPricesInput,
  ListProductsInput,
  McpToolResponse,
} from "../types.js";

// ═════════════════════════════════════════════════════════════════════
// § createProduct
// ═════════════════════════════════════════════════════════════════════

/**
 * Create a new product in the Stripe catalog.
 *
 * @description Creates a product object that represents a good or
 *   service you sell. Products can optionally include an inline
 *   default price via `default_price_data` to create both objects
 *   in a single call.
 * @param input - Validated {@link CreateProductInput}. `name` is
 *   required. `description`, `active`, `images`,
 *   `default_price_data`, and `metadata` are optional.
 * @returns A {@link McpToolResponse} containing the newly created
 *   `Stripe.Product` on success, or a structured error on failure.
 * @throws Never — all Stripe errors are caught and mapped to the
 *   failure branch of the response union.
 */
export async function createProduct(
  input: CreateProductInput,
): Promise<McpToolResponse<Stripe.Product>> {
  try {
    const createParams: Stripe.ProductCreateParams = {
      name: input.name,
      description: input.description,
      active: input.active,
      images: input.images,
      metadata: input.metadata,
    };

    // Build the inline default price data when provided.
    if (input.default_price_data !== undefined) {
      createParams.default_price_data = {
        unit_amount: input.default_price_data.unit_amount,
        currency: input.default_price_data.currency,
        recurring: input.default_price_data.recurring,
      };
    }

    const product = await stripe.products.create(createParams);

    return { success: true, data: product };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § listProducts
// ═════════════════════════════════════════════════════════════════════

/**
 * List products from the Stripe catalog with optional filters.
 *
 * @description Returns a paginated list of products. Results can be
 *   filtered by active/inactive status and paginated via cursor-based
 *   `starting_after` / `ending_before` params. The response includes
 *   `has_more` to indicate whether additional pages exist.
 * @param input - Validated {@link ListProductsInput} with optional
 *   `limit`, `active`, `starting_after`, and `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.Product>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listProducts(
  input: ListProductsInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.Product>>> {
  try {
    const list = await stripe.products.list({
      limit: input.limit,
      active: input.active,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § createPrice
// ═════════════════════════════════════════════════════════════════════

/**
 * Create a new price for an existing Stripe product.
 *
 * @description Creates a price that defines how much and how often to
 *   charge for a product. Can be one-time (omit `recurring`) or
 *   recurring (provide `interval` and optional `interval_count`).
 *   Prices are immutable once created — to change pricing, create a
 *   new price and archive the old one.
 * @param input - Validated {@link CreatePriceInput}. `unit_amount`,
 *   `currency`, and `product` are required. `recurring`, `nickname`,
 *   and `metadata` are optional.
 * @returns A {@link McpToolResponse} containing the newly created
 *   `Stripe.Price` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function createPrice(
  input: CreatePriceInput,
): Promise<McpToolResponse<Stripe.Price>> {
  try {
    const createParams: Stripe.PriceCreateParams = {
      unit_amount: input.unit_amount,
      currency: input.currency,
      product: input.product,
      nickname: input.nickname,
      metadata: input.metadata,
    };

    // Only attach recurring when explicitly provided — omitting it
    // creates a one-time price.
    if (input.recurring !== undefined) {
      createParams.recurring = {
        interval: input.recurring.interval,
        interval_count: input.recurring.interval_count,
      };
    }

    const price = await stripe.prices.create(createParams);

    return { success: true, data: price };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}

// ═════════════════════════════════════════════════════════════════════
// § listPrices
// ═════════════════════════════════════════════════════════════════════

/**
 * List prices with optional filters and pagination.
 *
 * @description Returns a paginated list of prices. Results can be
 *   filtered by product, active status, and type (one-time vs
 *   recurring). The response includes `has_more` to indicate whether
 *   additional pages exist.
 * @param input - Validated {@link ListPricesInput} with optional
 *   `limit`, `product`, `active`, `type`, `starting_after`, and
 *   `ending_before`.
 * @returns A {@link McpToolResponse} containing a
 *   `Stripe.ApiList<Stripe.Price>` on success.
 * @throws Never — all errors are caught and returned as structured responses.
 */
export async function listPrices(
  input: ListPricesInput,
): Promise<McpToolResponse<Stripe.ApiList<Stripe.Price>>> {
  try {
    const list = await stripe.prices.list({
      limit: input.limit,
      product: input.product,
      active: input.active,
      type: input.type,
      starting_after: input.starting_after,
      ending_before: input.ending_before,
    });

    return { success: true, data: list };
  } catch (error: unknown) {
    return toErrorResponse(error);
  }
}
