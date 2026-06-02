import { describe, it, expect } from "vitest";
import { deriveIdempotencyKey } from "../src/utils/idempotency.js";

describe("deriveIdempotencyKey", () => {
  it("produces stable distinct keys per scope", () => {
    const base = "550e8400-e29b-41d4-a716-446655440000";
    const a = deriveIdempotencyKey(base, "cus_a");
    const b = deriveIdempotencyKey(base, "cus_b");
    const a2 = deriveIdempotencyKey(base, "cus_a");

    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
