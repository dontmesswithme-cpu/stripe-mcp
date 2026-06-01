/**
 * @module stripe-client
 *
 * Singleton Stripe SDK client used by every tool handler in the server.
 *
 * Initializes once at module load with the secret key from the
 * `STRIPE_API_KEY` environment variable. The API version is pinned
 * explicitly so tool behavior is deterministic across deployments
 * regardless of the Stripe dashboard's default version.
 *
 * **Usage in tool modules:**
 * ```ts
 * import { stripe } from "../stripe-client.js";
 * const customer = await stripe.customers.retrieve(id);
 * ```
 */

import Stripe from "stripe";

// ── API version pin ─────────────────────────────────────────────────
// All requests use this version, ensuring consistent response shapes
// across environments. Update deliberately when adopting new API fields.
const STRIPE_API_VERSION = "2025-02-24.acacia" as const;

// ── Environment guard ───────────────────────────────────────────────
// Defense-in-depth: index.ts validates on startup, but this module
// must be independently safe if imported from tests or other contexts.

const apiKey: string | undefined = process.env["STRIPE_API_KEY"];

if (!apiKey || apiKey.trim().length === 0) {
  throw new Error(
    [
      "",
      "✖  stripe-client: STRIPE_API_KEY is not set.",
      "",
      "  The Stripe MCP server cannot initialize without a valid API key.",
      "  Set it in your shell or in a .env file:",
      "",
      "    export STRIPE_API_KEY=sk_test_...",
      "",
      "  See .env.example for the full list of configuration variables.",
      "",
    ].join("\n"),
  );
}

// ── Client instance ─────────────────────────────────────────────────

/**
 * Pre-configured Stripe client singleton.
 *
 * - Uses the secret key from `STRIPE_API_KEY`.
 * - Pins API version to {@link STRIPE_API_VERSION}.
 * - Sets `typescript: true` for stricter SDK typechecks.
 * - Configures automatic retries (2) with exponential back-off.
 * - Identifies as `stripe-mcp` for Stripe's internal request logs.
 */
export const stripe = new Stripe(apiKey, {
  apiVersion: STRIPE_API_VERSION,
  typescript: true,
  maxNetworkRetries: 2,
  appInfo: {
    name: "stripe-mcp",
    url: "https://github.com/stripe-mcp/stripe-mcp",
    version: "0.1.0",
  },
});

export { STRIPE_API_VERSION };
