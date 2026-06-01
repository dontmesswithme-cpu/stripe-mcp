# Example prompts

Realistic prompts you can type into Claude, Cursor, or any MCP-compatible AI agent after connecting `stripe-mcp`.

---

## Customers

- "Create a customer with email `jane@acme.com` and name Jane Park"
- "Look up customer `cus_R4xNb8K2vLmQ`"
- "Update customer `cus_R4xNb8K2vLmQ`'s email to `jane.park@acme.com`"
- "List all customers with the email `john@example.com`"
- "Delete customer `cus_OldTestAccount`"

## Payments

- "Create a $49.99 USD payment intent for customer `cus_R4xNb8K2vLmQ`"
- "Create a payment intent for €120 EUR with metadata `order_id: ORD-2025-1234`"
- "Confirm payment intent `pi_3Qx7abc` with payment method `pm_card_visa`"
- "Cancel payment intent `pi_3Qx7abc` — it was a duplicate"
- "List the last 5 payment intents for customer `cus_R4xNb8K2vLmQ`"

## Subscriptions

- "Subscribe customer `cus_R4xNb8K2vLmQ` to price `price_MonthlyPro`"
- "Show me subscription `sub_KjN9xE2`"
- "Upgrade subscription `sub_KjN9xE2` — replace the current item with price `price_AnnualPro`"
- "Cancel subscription `sub_KjN9xE2` at the end of the billing period"
- "Cancel subscription `sub_TRIAL123` immediately"
- "List all active subscriptions for customer `cus_R4xNb8K2vLmQ`"
- "Show me all past-due subscriptions"

## Products & Prices

- "Create a product called 'Pro Plan' with description 'Unlimited access for teams'"
- "List all active products"
- "Create a monthly recurring price of $29/month for product `prod_ProPlan`"
- "Create a one-time price of $199 USD for product `prod_SetupFee`"
- "List all recurring prices for product `prod_ProPlan`"

## Invoices

- "Show me invoice `in_1Qx8abc`"
- "List all open invoices for customer `cus_R4xNb8K2vLmQ`"
- "List all paid invoices"
- "Pay invoice `in_1Qx8abc`"
- "Pay invoice `in_1Qx8abc` using payment method `pm_card_amex`"

## Balance

- "What's my current Stripe balance?"
- "Show me the account balance broken down by currency"

## Refunds

- "Refund payment intent `pi_3Qx7abc` in full"
- "Refund $25 from payment intent `pi_3Qx7abc`"
- "Refund charge `ch_abc123` — reason: duplicate"
- "List all refunds for payment intent `pi_3Qx7abc`"

---

## Multi-step workflows

These prompts chain multiple tools together. The agent figures out the sequence.

- "Create a new customer `alex@startup.io`, then subscribe them to `price_StarterMonthly`"
- "Find all past-due subscriptions and list the associated customer emails"
- "Create a product called 'Enterprise' at $299/month and give me the price ID"
- "Refund the last payment intent for customer `cus_R4xNb8K2vLmQ`"
- "How much revenue is sitting in pending balance right now?"
