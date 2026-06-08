import { scoreRisk } from "../src/risk/engine.js";
import { stripe } from "../src/stripe-client.js";

async function main() {
  const context = {
    customerId: "cus_123",
    capability: { operation: "refund" as const, resource: "charge" as const },
    params: { amount: 1000, reason: "duplicate" },
    amount: 1000,
  };

  let stripeCalls = 0;

  // Mock Stripe
  stripe.customers.retrieve = async () => {
    stripeCalls++;
    return { id: "cus_123", created: Date.now() / 1000 - 86400 * 10, metadata: {} } as any;
  };
  stripe.charges.list = async () => {
    stripeCalls++;
    return { data: [] } as any;
  };

  console.log("Sending 10 identical mutating operations for the same customer...");
  
  for (let i = 0; i < 10; i++) {
    await scoreRisk(context);
  }

  console.log(`Total Stripe API calls made: ${stripeCalls}`);
  
  if (stripeCalls === 2) {
    console.log("SUCCESS: 1 call for customers.retrieve and 1 call for charges.list");
    process.exit(0);
  } else {
    console.error(`FAILED: expected 2 calls, got ${stripeCalls}`);
    process.exit(1);
  }
}

main().catch(console.error);
