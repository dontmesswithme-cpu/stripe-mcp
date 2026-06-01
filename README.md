# stripe-mcp

> Production-grade Model Context Protocol (MCP) server for the Stripe API.

![npm version](https://img.shields.io/npm/v/stripe-mcp?style=flat-square)
![license](https://img.shields.io/npm/l/stripe-mcp?style=flat-square)
![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg?style=flat-square)

## What it is
An MCP server that safely exposes Stripe's capabilities to AI agents, backed by a strict risk engine, approval workflows, and comprehensive audit logging. Built with strict TypeScript and `better-sqlite3`, it is designed for production environments where AI mutations must be auditable and tightly controlled.

## What's new in 1.0.0
- **Risk Engine:** Configurable scoring system that evaluates mutations based on velocity, amounts, account age, and time-of-day.
- **Approval Workflow:** Built-in HTTP server to intercept high-risk operations and hold them pending a human token approval.
- **Audit Logging:** Every operation—blocked, simulated, or executed—is durably logged to SQLite with context.
- **Soft Delete Pattern:** New `archive_customer` logic replaces destructive deletes with a safer 14-day expiry window.
- **Dry-Run & Read-Only Modes:** Global toggles to safely test agent prompts without touching production Stripe data.

## Quick start

1. **Install globally:**
   ```bash
   npm install -g stripe-mcp
   ```

2. **Configure environment:**
   Create a `.env` file with your Stripe secret key and custom thresholds (see `Configuration`).
   ```bash
   export STRIPE_API_KEY="sk_test_..."
   export STRIPE_DRY_RUN=true
   ```

3. **Add to your MCP client (e.g. Claude Desktop):**
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

## Configuration

All configuration is handled via environment variables.

### Core credentials
| Variable | Default | Description |
| :--- | :--- | :--- |
| `STRIPE_API_KEY` | `""` | **[Required]** Your Stripe Secret Key. |

### Operating modes
| Variable | Default | Description |
| :--- | :--- | :--- |
| `STRIPE_READ_ONLY` | `false` | Blocks all mutating operations. |
| `STRIPE_DRY_RUN` | `false` | Runs the middleware pipeline but simulates Stripe execution. |
| `STRIPE_MCP_DATA_DIR` | `./data` | Path to store SQLite databases. |

### Risk policy thresholds
| Variable | Default | Description |
| :--- | :--- | :--- |
| `RISK_BLOCK_THRESHOLD` | `70` | Score required to auto-block an operation. |
| `RISK_FLAG_THRESHOLD` | `40` | Score required to flag an operation for approval. |
| `RISK_VELOCITY_24H_MAX`| `5` | Customer mutation limit in 24 hours. |
| `RISK_VELOCITY_30D_MAX`| `20` | Customer mutation limit in 30 days. |
| `RISK_AMOUNT_HIGH` | `50000` | High amount threshold (in cents). |
| `RISK_AMOUNT_CRITICAL` | `200000` | Critical amount threshold (in cents). |

### Approval system
| Variable | Default | Description |
| :--- | :--- | :--- |
| `APPROVAL_PORT` | `3001` | Port for the human review HTTP server (0 to disable). |
| `APPROVAL_EXPIRY_MINUTES` | `60` | Lifecycle duration of an approval token. |
| `APPROVAL_REFUND_THRESHOLD`| `100000` | Minimum refund amount requiring approval (in cents). |
| `APPROVAL_CANCEL_THRESHOLD`| `500000` | Minimum cancellation MRR requiring approval (in cents). |

## Approval Workflow

Operations flagged by the Risk Engine or exceeding hard thresholds are intercepted by the middleware. The agent receives a `policy_error` containing a unique UUID token, and the operation is paused.

A human reviewer can inspect and approve or reject the action via the lightweight HTTP server running on port `3001` (by default).

**Endpoints:**
- `GET /approvals/{token}` - View the token status and raw parameters.
- `POST /approvals/{token}/approve` - Approve the operation.
- `POST /approvals/{token}/reject` - Reject the operation.

**Example:**
```bash
# Check status
curl http://localhost:3001/approvals/123e4567-e89b-12d3-a456-426614174000

# Approve
curl -X POST http://localhost:3001/approvals/123e4567-e89b-12d3-a456-426614174000/approve
```
*Note: The AI agent must re-attempt the operation after it is approved.*

## Risk Scoring

The Risk Engine evaluates every mutation asynchronously. Outcomes fall into three tiers:
- **Allow (0-39)**
- **Flag (40-69):** Requires human approval.
- **Block (70+):** Denied entirely.

| Factor | Trigger | Points |
| :--- | :--- | :--- |
| `very_high_amount` | Amount > `RISK_AMOUNT_CRITICAL` | +35 |
| `high_amount` | Amount > `RISK_AMOUNT_HIGH` | +20 |
| `off_hours` | Occurs between 00:00 and 06:00 UTC | +5 |
| `full_refund` | Refund with no partial amount specified | +5 |
| `no_reason` | Refund without a reason string | +5 |
| `velocity_24h` | Customer mutations in last 24h >= `RISK_VELOCITY_24H_MAX` | +15 |
| `velocity_30d` | Customer mutations in last 30d >= `RISK_VELOCITY_30D_MAX` | +10 |
| `new_account` | Customer account age < 7 days | +10 |
| `archived_customer`| Customer has metadata `archived="true"` | +15 |
| `high_refund_ratio`| Customer historical refund ratio > 30% | +15 |

## Operating Modes

**Dry-Run Mode (`STRIPE_DRY_RUN=true`)**
The middleware processes the operation, evaluates risk, checks approval gates, and writes to the SQLite audit log. It then simulates a successful return payload without ever making a network call to the Stripe API. Ideal for testing AI agent prompting.

**Read-Only Mode (`STRIPE_READ_ONLY=true`)**
Instantly blocks any operation categorized as a mutation (create, update, delete, refund, pay, confirm) before the payload is even parsed. Useful for safe, exploratory read-access to production environments.

**Live Mode (Default)**
Mutations are evaluated by the Risk Engine and executed against the Stripe API. Always test with a Stripe Restricted Key.

## Available Tools

All 28 tools are exposed dynamically via the MCP protocol.

| Group | Tools |
| :--- | :--- |
| **Customers** | `create_customer`, `retrieve_customer`, `update_customer`, `delete_customer`, `list_customers`, `archive_customer`, `purge_expired_customers` |
| **Payments** | `create_payment_intent`, `retrieve_payment_intent`, `confirm_payment_intent`, `cancel_payment_intent`, `list_payment_intents` |
| **Subscriptions** | `create_subscription`, `retrieve_subscription`, `update_subscription`, `cancel_subscription`, `list_subscriptions` |
| **Products** | `create_product`, `list_products`, `create_price`, `list_prices` |
| **Invoices** | `retrieve_invoice`, `list_invoices`, `pay_invoice` |
| **Balance** | `retrieve_balance` |
| **Refunds** | `create_refund`, `list_refunds` |
| **Audit** | `get_audit_log` |

## Development

```bash
npm install
npm run build
npm run lint
npm run dev
```

## Contributing
Pull requests are welcome for new capabilities and Stripe endpoints. Please ensure all modifications pass the strict TypeScript compiler checks. All new mutating tools must route through the `executeStripeOperation` middleware.

## License
MIT
