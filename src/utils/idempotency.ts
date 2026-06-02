/**
 * Derive a deterministic Stripe idempotency key for sub-operations within
 * a single MCP call (e.g. per-customer delete during purge).
 */
import { createHash } from "node:crypto";

export function deriveIdempotencyKey(
  baseKey: string,
  scope: string,
): string {
  const digest = createHash("sha256")
    .update(baseKey)
    .update("|")
    .update(scope)
    .digest("hex");
  // Stripe allows up to 255 chars; keep UUID-shaped keys for consistency.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}
