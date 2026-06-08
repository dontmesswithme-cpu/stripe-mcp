import { stripe } from "../src/stripe-client.js";
import { scoreRisk } from "../src/risk/engine.js";
import type { OperationContext } from "../src/types.js";

async function test() {
  console.log("Mocking stripe SDK...");
  
  // Mock stripe customer retrieve to return a 429 error
  const originalRetrieve = stripe.customers.retrieve;
  stripe.customers.retrieve = async () => {
    const error = new Error("Rate limit exceeded") as any;
    error.type = "StripeRateLimitError";
    error.statusCode = 429;
    throw error;
  };

  const context: OperationContext = {
    customerId: "cus_test_123",
    capability: {
      tool: "create_customer",
      operation: "create",
      riskScored: true,
      readOnly: false,
      approvalEligible: true
    },
    params: {},
    amount: undefined,
    currency: undefined
  };

  console.log("Running scoreRisk...");
  try {
    const score = await scoreRisk(context);
    console.log("Result:", score);
    console.error("FAIL: Did not throw Service Unavailable");
    process.exit(1);
  } catch (err: any) {
    if (err.message === "Service Unavailable") {
      console.log("PASS: Successfully aborted with Service Unavailable");
    } else {
      console.error("FAIL: Unexpected error thrown:", err);
      process.exit(1);
    }
  }

  console.log("Restoring stripe SDK...");
  stripe.customers.retrieve = originalRetrieve;
  process.exit(0);
}

test().catch(console.error);
