import { describe, it, expect, vi, beforeEach } from "vitest";
import { scoreRisk } from "../src/risk/engine.js";
import { stripe } from "../src/stripe-client.js";
import { config } from "../src/config.js";
import type { OperationContext } from "../src/types.js";

vi.mock("../src/audit/log.js", () => ({
  countRecentOperations: vi.fn().mockResolvedValue(0),
}));

describe("risk/engine", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const getBaseContext = (op: "refund" | "delete" = "refund"): OperationContext => ({
    capability: {
      tool: "test_tool",
      operation: op,
      readOnly: false,
      riskScored: true,
      approvalEligible: true,
    },
    customerId: "cus_123",
    params: { reason: "requested_by_customer", amount: 100 },
    amount: 100,
  });

  it("adds high_amount and full_refund factors", async () => {
    const ctx = getBaseContext("refund");
    ctx.amount = config.riskAmountHigh + 100;
    delete ctx.params.amount;
    
    // mock stripe calls safely
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_123",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 10,
    } as any);

    // mock list correctly for async iterator
    vi.spyOn(stripe.charges, "list").mockImplementation(() => {
      const iter = [
        { id: "ch_1", refunded: false, amount_refunded: 0 },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < iter.length) return { value: iter[i++], done: false };
              return { done: true, value: undefined };
            }
          };
        }
      } as any;
    });

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "high_amount")).toBe(true);
    expect(score.factors.some(f => f.name === "full_refund")).toBe(true);
  });

  it("handles Service Unavailable on 429", async () => {
    const ctx = getBaseContext();
    ctx.customerId = "cus_429";
    vi.spyOn(stripe.customers, "retrieve").mockRejectedValue({ statusCode: 429 });

    await expect(scoreRisk(ctx)).rejects.toThrow("Service Unavailable");
  });

  it("handles risk_evaluation_failure on other API errors", async () => {
    const ctx = getBaseContext();
    ctx.customerId = "cus_err";
    vi.spyOn(stripe.customers, "retrieve").mockRejectedValue(new Error("Random"));

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "risk_evaluation_failure")).toBe(true);
  });

  it("evaluates refund ratio properly", async () => {
    const ctx = getBaseContext("refund");
    ctx.customerId = "cus_ratio";
    
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_123",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 10,
    } as any);

    vi.spyOn(stripe.charges, "list").mockImplementation(() => {
      const iter = [
        { id: "ch_1", refunded: true, amount_refunded: 100 },
        { id: "ch_2", refunded: false, amount_refunded: 0 },
      ];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next() {
              if (i < iter.length) return { value: iter[i++], done: false };
              return { done: true, value: undefined };
            }
          };
        }
      } as any;
    });

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "high_refund_ratio")).toBe(true);
  });

  it("handles Service Unavailable on 429 for refund ratio", async () => {
    const ctx = getBaseContext("refund");
    ctx.customerId = "cus_ratio_429";
    
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_ratio_429",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 10,
    } as any);

    vi.spyOn(stripe.charges, "list").mockImplementation(() => {
      throw { statusCode: 429 };
    });

    await expect(scoreRisk(ctx)).rejects.toThrow("Service Unavailable");
  });

  it("handles risk_evaluation_failure on other API errors for refund ratio", async () => {
    const ctx = getBaseContext("refund");
    ctx.customerId = "cus_ratio_err";
    
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_ratio_err",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 10,
    } as any);

    vi.spyOn(stripe.charges, "list").mockImplementation(() => {
      throw new Error("Random API Error");
    });

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "risk_evaluation_failure")).toBe(true);
  });

  it("handles cache expiration and eviction safely", async () => {
    vi.useFakeTimers();
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_cache",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 10,
    } as any);
    vi.spyOn(stripe.charges, "list").mockImplementation(() => {
      return { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; } } as any;
    });

    // Seed cache
    let ctx = getBaseContext("refund");
    ctx.customerId = "cus_cache";
    await scoreRisk(ctx);

    // Expire cache
    vi.advanceTimersByTime(15 * 60 * 1000); // 15 mins

    // This should trigger cache sweep and fetch again
    await scoreRisk(ctx);
    
    // Test cache eviction logic directly by filling customer cache beyond 1000 items
    // This is a bit brute force but covers the maxItems branch
    for (let i = 0; i < 1002; i++) {
      const mockCtx = getBaseContext("delete");
      mockCtx.customerId = `cus_bulk_${i}`;
      await scoreRisk(mockCtx);
    }
    vi.useRealTimers();
  });

  it("adds velocity_24h and velocity_30d factors", async () => {
    const ctx = getBaseContext("refund");
    
    // Mock audit log to return high counts
    const auditLog = await import("../src/audit/log.js");
    vi.mocked(auditLog.countRecentOperations).mockImplementation(async (cus, op, since) => {
      // Return > max to trigger the factors
      if (since.includes(new Date().getUTCFullYear().toString())) {
        return 100; // sufficiently high for both thresholds
      }
      return 100;
    });

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "velocity_24h")).toBe(true);
    expect(score.factors.some(f => f.name === "velocity_30d")).toBe(true);
    
    // reset mock for other tests
    vi.mocked(auditLog.countRecentOperations).mockResolvedValue(0);
  });

  it("adds new_account factor", async () => {
    const ctx = getBaseContext("refund");
    ctx.customerId = "cus_new";
    
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_new",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 2, // 2 days old
    } as any);

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "new_account")).toBe(true);
  });

  it("adds archived_customer factor", async () => {
    const ctx = getBaseContext("refund");
    ctx.customerId = "cus_archived";
    
    vi.spyOn(stripe.customers, "retrieve").mockResolvedValue({
      id: "cus_archived",
      object: "customer",
      created: Date.now() / 1000 - 86400 * 10,
      metadata: { archived: "true" }
    } as any);

    const score = await scoreRisk(ctx);
    expect(score.factors.some(f => f.name === "archived_customer")).toBe(true);
  });
});
