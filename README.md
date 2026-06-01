# stripe-mcp

Stripe API tools for AI agents, via the Model Context Protocol.

[![npm version](https://img.shields.io/npm/v/stripe-mcp)](https://www.npmjs.com/package/stripe-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](tsconfig.json)

## What it is

An MCP server that gives any compatible AI agent direct access to the Stripe API. 25 tools, strict TypeScript, Zod-validated inputs, structured error handling.

- Create and confirm payment intents in any currency
- Create, update, and delete customers with full metadata support
- Manage subscriptions — create, upgrade, downgrade, or cancel at period end
- Build a product catalog with recurring and one-time prices
- Retrieve and collect payment on open invoices
- Issue full or partial refunds against charges or payment intents
- Check account balance broken down by available and pending amounts per currency
- List and filter any Stripe resource with cursor-based pagination

## Quick start

1. Install

   ```bash
   npm install -g stripe-mcp
   ```

2. Set your Stripe secret key

   ```bash
   export STRIPE_API_KEY=sk_test_...
   ```

3. Add to your MCP client config (see below) and restart

## MCP configuration

### Claude Desktop

`~/.config/claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "stripe": {
      "command": "stripe-mcp",
      "env": {
        "STRIPE_API_KEY": "sk_test_..."
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "stripe": {
      "command": "stripe-mcp",
      "env": {
        "STRIPE_API_KEY": "sk_test_..."
      }
    }
  }
}
```

### Generic MCP client (npx)

```json
{
  "mcpServers": {
    "stripe": {
      "command": "npx",
      "args": ["-y", "stripe-mcp"],
      "env": {
        "STRIPE_API_KEY": "sk_test_..."
      }
    }
  }
}
```

## Available tools

### **Customers**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `create_customer` | Create a new customer | — |
| `retrieve_customer` | Get a customer by ID | `customer_id` |
| `update_customer` | Update customer fields | `customer_id` |
| `delete_customer` | Permanently delete a customer | `customer_id` |
| `list_customers` | List customers with optional email filter | — |

### **Payments**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `create_payment_intent` | Create a payment intent | `amount`, `currency` |
| `retrieve_payment_intent` | Get a payment intent by ID | `payment_intent_id` |
| `confirm_payment_intent` | Confirm to initiate collection | `payment_intent_id` |
| `cancel_payment_intent` | Cancel a payment intent | `payment_intent_id` |
| `list_payment_intents` | List with optional customer filter | — |

### **Subscriptions**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `create_subscription` | Subscribe a customer to price(s) | `customer`, `items` |
| `retrieve_subscription` | Get a subscription by ID | `subscription_id` |
| `update_subscription` | Modify items, billing, or metadata | `subscription_id` |
| `cancel_subscription` | Cancel immediately or at period end | `subscription_id` |
| `list_subscriptions` | List with customer/status/price filters | — |

### **Products & Prices**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `create_product` | Create a catalog product | `name` |
| `list_products` | List with active/inactive filter | — |
| `create_price` | Create a recurring or one-time price | `unit_amount`, `currency`, `product` |
| `list_prices` | List with product/active/type filters | — |

### **Invoices**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `retrieve_invoice` | Get an invoice with line items | `invoice_id` |
| `list_invoices` | List with customer/status filters | — |
| `pay_invoice` | Collect payment on an open invoice | `invoice_id` |

### **Balance**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `retrieve_balance` | Get account balance by currency | — |

### **Refunds**

| Tool | Description | Required params |
|------|-------------|-----------------|
| `create_refund` | Full or partial refund | `payment_intent` or `charge` |
| `list_refunds` | List with charge/payment intent filter | — |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_API_KEY` | **Yes** | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_API_VERSION` | No | Pin a specific API version (default: `2025-02-24.acacia`) |
| `STRIPE_DEFAULT_LIMIT` | No | Default list page size, 1–100 (default: `10`) |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error` (default: `info`) |

## Development

```bash
git clone https://github.com/your-username/stripe-mcp.git
cd stripe-mcp
npm install
npm run build
```

Run locally:

```bash
STRIPE_API_KEY=sk_test_... npm run dev
```

| Script | What it does |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run dev` | Run with `tsx watch` (auto-reload) |
| `npm start` | Run compiled `dist/index.js` |
| `npm run lint` | Lint with ESLint |

## Contributing

Fork the repo, create a feature branch (`feat/add-checkout-tools`), and open a PR against `main`. Include tests for new tools and ensure `npm run build && npm run lint` passes cleanly. Keep PRs focused — one tool domain per PR.

## License

MIT
