/**
 * Rate-limited execution for Stripe mutating API calls.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Process items with bounded concurrency and a minimum delay between
 * starting each request (per worker).
 */
export async function forEachStripeWrite<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  options: { readonly intervalMs: number; readonly concurrency: number },
): Promise<void> {
  if (items.length === 0) return;

  const concurrency = Math.max(1, Math.min(options.concurrency, items.length));
  let index = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) break;
      await fn(items[current]!);
      if (options.intervalMs > 0) {
        await sleep(options.intervalMs);
      }
    }
  });

  await Promise.all(workers);
}
