import { test, expect, vi } from "vitest";
import { scoreRisk } from "../src/risk/engine.js";
import { stripe } from "../src/stripe-client.js";

vi.mock("../src/stripe-client.js", () => ({
  stripe: {
    customers: {
      retrieve: vi.fn(),
    },
    charges: {
      list: vi.fn(),
    }
  }
}));

test("Network Sabotage Test: forces risk_evaluation_failure on API timeout", async () => {
  vi.mocked(stripe.customers.retrieve).mockRejectedValue(new Error("API Timeout"));
  
  const context = {
    capability: { tool: "updateCustomer", operation: "update" },
    params: {},
    customerId: "cus_123",
  };
  
  const score = await scoreRisk(context as any);
  
  expect(score.outcome).toBe("block");
  expect(score.factors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "risk_evaluation_failure" })
    ])
  );
});
