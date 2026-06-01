# stripe-mcp

A production-grade Model Context Protocol (MCP) server that safely exposes Stripe API operations to AI agents through a strict policy and approval middleware.

## System Architecture

All mutating operations are routed through a centralized middleware pipeline that enforces compliance, risk scoring, and audit requirements before interacting with the Stripe API. Read-only operations bypass this pipeline.

```text
Request Input -> Schema Validation (Zod) -> Middleware Pipeline
                                                  |
                                                  v
[Read-Only Mode] -> [Idempotency Enforcement] -> [Risk Engine] -> [Approval Gate] -> [Stripe Execution]
                                                                        |                  |
                                                                        v                  v
                                                             [Audit Log (SQLite)] <- [Response Status]
```

## Production Guarantees

### Client-Owned Idempotency
The server strictly enforces client-side idempotency (`idempotency_key`) for all mutating operations (e.g., payments, refunds, subscriptions). This physical constraint prevents duplicate financial transactions during network failures or LLM retry loops. Mutations submitted without a valid UUID are rejected immediately at the middleware layer.

### Synchronous Audit Logging
Every executed operation is durably logged to a SQLite database (`audit.db`). To ensure absolute accuracy in tracking financial state mutations, the audit log writing mechanism is structurally isolated from the primary transaction execution path via explicit exception handling boundaries. This guarantees that internal audit database failures (e.g., locking constraints) do not erroneously reverse the logical success state returned to the MCP client.

### Rate-Limit Safe Concurrency
Bulk operations, such as the `purge_expired_customers` command for GDPR/CCPA data retention compliance, utilize zero-dependency bounded concurrency limiters. Using native rolling-window implementations, the server maximizes throughput without exceeding Stripe API rate limits or indefinitely blocking the single-threaded Node.js event loop.

### Financial Approval Workflow
High-risk mutations trigger the generation of a cryptographic, state-consumed approval token. Operations are paused until authenticated human authorization is received. Once authorized, the token state transitions to `consumed` to prevent replay attacks against the approval endpoint.

## Security & Authentication

Configuration and secrets management rely entirely on environment variables.

```bash
# Core Credentials
STRIPE_API_KEY=sk_production_...

# Approval Server Authentication
APPROVAL_API_KEY=secret_auth_token_...
APPROVAL_PORT=3001
```

The HTTP approval server enforces a strict authorization layer. Administrative interventions (approval or rejection) require the presentation of a valid Bearer token matching the `APPROVAL_API_KEY`.

```bash
# Example Authorization Request
curl -X POST http://localhost:3001/approvals/123e4567-e89b-12d3-a456-426614174000/approve \
  -H "Authorization: Bearer <APPROVAL_API_KEY>"
```

## Tool Registry

| Domain | Read-Only Tools | Mutating Tools |
| :--- | :--- | :--- |
| **Customers** | `retrieve_customer`, `list_customers` | `create_customer`, `update_customer`, `delete_customer`, `archive_customer`, `purge_expired_customers` |
| **Payments** | `retrieve_payment_intent`, `list_payment_intents` | `create_payment_intent`, `confirm_payment_intent`, `cancel_payment_intent` |
| **Subscriptions** | `retrieve_subscription`, `list_subscriptions` | `create_subscription`, `update_subscription`, `cancel_subscription` |
| **Products** | `list_products`, `list_prices` | `create_product`, `create_price` |
| **Invoices** | `retrieve_invoice`, `list_invoices` | `pay_invoice` |
| **Balance** | `retrieve_balance` | - |
| **Refunds** | `list_refunds` | `create_refund` |
| **Audit** | `get_audit_log` | - |

## Local Development & Deployment

The server relies on `better-sqlite3` and standard TypeScript build processes.

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Start the MCP server process
npm start
```

Deploy the compiled distribution output into secure infrastructure capable of connecting via standard I/O streams (`stdio`). Ensure the internal `./data/` directory maintains appropriate filesystem write permissions for SQLite persistence.
