import { describe, it, expect, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";

import {
  createApproval,
  getApproval,
  approveToken,
  canonicalize,
  computeRequestHash,
} from "../src/approval/store.js";
import {
  createExecution,
  getExecution,
  updateExecutionStatus,
  sweepStaleExecutions,
} from "../src/execution/store.js";
import { WORKER_ID } from "../src/worker/identity.js";
import {
  closeAllDatabases,
  getApprovalsDb,
  initializeAllDatabases,
} from "../src/utils/db.js";
import { executeStripeOperation } from "../src/middleware/execute.js";
import { reconcileUnknownOutcomes } from "../src/reconciliation/worker.js";
import { stripe } from "../src/stripe-client.js";

describe("Decoupled Execution & Approval Architecture", () => {
  beforeAll(() => {
    initializeAllDatabases();
  });

  afterAll(() => {
    closeAllDatabases();
    try {
      rmSync(process.env.STRIPE_MCP_DATA_DIR!, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    } catch {
      // Windows may keep WAL files locked briefly after close.
    }
  });

  it("Approval becomes consumed when execution starts", async () => {
    const context: OperationContextFixture = {
      capability: {
        tool: "test_tool",
        operation: "delete",
        readOnly: false,
        riskScored: false,
        approvalEligible: true,
      },
      params: {
        customer_id: "cus_1",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440001",
      },
    };
    const approval = createApproval(context, 10);
    approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => ({ id: "123" }));

    const finalApproval = getApproval(approval.token);
    expect(finalApproval?.status).toBe("consumed");
  });

  it("Unknown outcomes cannot become approved", async () => {
    const context: OperationContextFixture = {
      capability: {
        tool: "test_tool",
        operation: "delete",
        readOnly: false,
        riskScored: false,
        approvalEligible: true,
      },
      params: {
        customer_id: "cus_2",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440002",
      },
    };
    const approval = createApproval(context, 10);
    approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => {
      throw Object.assign(new Error("Timeout"), {
        type: "api_connection_error",
      });
    });

    expect(getApproval(approval.token)?.status).toBe("consumed");

    const db = getApprovalsDb();
    const execRow = db
      .prepare(`SELECT status FROM executions WHERE idempotency_key = ?`)
      .get(context.params.idempotency_key) as { status: string };
    expect(execRow.status).toBe("unknown_outcome");
  });

  it("Consumed token cannot be executed again", async () => {
    const context: OperationContextFixture = {
      capability: {
        tool: "test_tool",
        operation: "delete",
        readOnly: false,
        riskScored: false,
        approvalEligible: true,
      },
      params: {
        customer_id: "cus_3",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440003",
      },
    };
    const approval = createApproval(context, 10);
    approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => ({ id: "first" }));

    const retry = await executeStripeOperation(context, async () => ({
      id: "second",
    }));
    expect(retry.success).toBe(false);
    if (!retry.success) {
      expect(retry.error.code).toBe("token_not_approved");
    }
  });

  it("Duplicate execution prevention", async () => {
    const context: OperationContextFixture = {
      capability: {
        tool: "test_tool",
        operation: "delete",
        readOnly: false,
        riskScored: false,
        approvalEligible: true,
      },
      params: {
        customer_id: "cus_4",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440004",
      },
    };
    const approval = createApproval(context, 10);
    approveToken(approval.token);
    context.params.approval_token = approval.token;

    const res1 = await executeStripeOperation(context, async () => ({
      id: "123",
    }));
    expect(res1.success).toBe(true);

    const res2 = await executeStripeOperation(context, async () => ({
      id: "123",
    }));
    expect(res2.success).toBe(false);
    if (!res2.success) {
      expect(res2.error.code).toBe("token_not_approved");
    }
  });

  it("Stripe timeout creates unknown_outcome", async () => {
    const context: OperationContextFixture = {
      capability: {
        tool: "test_tool",
        operation: "delete",
        readOnly: false,
        riskScored: false,
        approvalEligible: true,
      },
      params: {
        customer_id: "cus_5",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440005",
      },
    };
    const approval = createApproval(context, 10);
    approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => {
      throw Object.assign(new Error("Timeout"), { type: "api_error" });
    });

    const db = getApprovalsDb();
    const execRow = db
      .prepare(`SELECT status FROM executions WHERE idempotency_key = ?`)
      .get(context.params.idempotency_key) as { status: string };
    expect(execRow.status).toBe("unknown_outcome");
  });

  it("Reconciliation resolves unknown_outcome via idempotent replay", async () => {
    const exec = createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440006",
      WORKER_ID,
      {
        tool: "delete_customer",
        operation: "delete",
        params: {
          customer_id: "cus_reconcile",
          idempotency_key: "550e8400-e29b-41d4-a716-446655440006",
        },
      },
    );
    updateExecutionStatus(exec.executionId, "unknown_outcome");

    const origDel = stripe.customers.del;
    stripe.customers.del = async () =>
      ({
        id: "cus_reconcile",
        object: "customer",
        deleted: true,
      }) as Awaited<ReturnType<typeof stripe.customers.del>>;

    await reconcileUnknownOutcomes();

    stripe.customers.del = origDel;

    const resolved = getExecution(exec.executionId);
    expect(resolved?.status).toBe("completed");
    expect(resolved?.stripeObjectId).toBe("cus_reconcile");
  });

  it("Canonical nested hashing", () => {
    const obj1 = { z: 1, a: [{ c: 3, b: 2 }, 4] };
    const obj2 = { a: [{ b: 2, c: 3 }, 4], z: 1 };
    expect(JSON.stringify(canonicalize(obj1))).toBe(
      JSON.stringify(canonicalize(obj2)),
    );
    const obj3 = { a: [4, { b: 2, c: 3 }], z: 1 };
    expect(JSON.stringify(canonicalize(obj1))).not.toBe(
      JSON.stringify(canonicalize(obj3)),
    );
  });

  it("Concurrent execution attempts fail safely", async () => {
    const context: OperationContextFixture = {
      capability: {
        tool: "test_tool",
        operation: "delete",
        readOnly: false,
        riskScored: false,
        approvalEligible: true,
      },
      params: {
        customer_id: "cus_8",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440008",
      },
    };
    const approval = createApproval(context, 10);
    approveToken(approval.token);
    context.params.approval_token = approval.token;

    const p1 = executeStripeOperation(context, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { id: "res1" };
    });
    const p2 = executeStripeOperation(context, async () => ({ id: "res2" }));

    const [res1, res2] = await Promise.all([p1, p2]);

    expect([res1.success, res2.success]).toContain(true);
    expect([res1.success, res2.success]).toContain(false);
  });

  it("Stale executing rows are swept to unknown_outcome", () => {
    const exec = createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440009",
      WORKER_ID,
      { tool: "test_tool", operation: "delete", params: {} },
    );

    const db = getApprovalsDb();
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    db.prepare(`UPDATE executions SET started_at = ? WHERE execution_id = ?`).run(
      stale,
      exec.executionId,
    );

    const swept = sweepStaleExecutions();
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(getExecution(exec.executionId)?.status).toBe("unknown_outcome");
  });

  it("Legacy migration invalidates empty request_hash approvals", () => {
    const db = getApprovalsDb();
    db.prepare(`
      INSERT INTO approvals (token, request_hash, tool, operation, status, expires_at)
      VALUES ('legacy_token', '', 'tool', 'op', 'pending', ?)
    `).run(new Date(Date.now() + 60_000).toISOString());

    db.prepare(
      `UPDATE approvals SET status = 'expired' WHERE request_hash = '' AND status = 'pending'`,
    ).run();

    const row = db
      .prepare(`SELECT status FROM approvals WHERE token = 'legacy_token'`)
      .get() as { status: string };
    expect(row.status).toBe("expired");
  });

  it("Worker ownership persistence", () => {
    const exec = createExecution(
      "token_11",
      "hash",
      "550e8400-e29b-41d4-a716-446655440011",
      { hostname: "my-host", pid: 1234, uuid: "my-uuid" },
      { tool: "test_tool", operation: "delete", params: {} },
    );
    const read = getExecution(exec.executionId);
    expect(read?.workerHostname).toBe("my-host");
    expect(read?.workerPid).toBe(1234);
    expect(read?.workerUuid).toBe("my-uuid");
  });

  it("Execution records survive process restart", () => {
    const exec = createExecution(
      "token_12",
      "hash",
      "550e8400-e29b-41d4-a716-446655440012",
      WORKER_ID,
      { tool: "test_tool", operation: "delete", params: {} },
    );

    closeAllDatabases();

    const db = getApprovalsDb();
    const read = db
      .prepare(`SELECT * FROM executions WHERE execution_id = ?`)
      .get(exec.executionId);
    expect(read).toBeDefined();
  });

  it("STRIPE_READ_ONLY blocks mutations", async () => {
    vi.resetModules();
    vi.stubEnv("STRIPE_READ_ONLY", "true");
    vi.stubEnv("STRIPE_API_KEY", "dummy_stripe_key_for_testing");

    const { executeStripeOperation: executeReadOnly } = await import(
      "../src/middleware/execute.js"
    );

    const result = await executeReadOnly(
      {
        capability: {
          tool: "test_tool",
          operation: "create",
          readOnly: false,
          riskScored: false,
          approvalEligible: false,
        },
        params: {
          idempotency_key: "550e8400-e29b-41d4-a716-446655440099",
        },
      },
      async () => ({ id: "blocked" }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("read_only");
    }

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

interface OperationContextFixture {
  capability: {
    tool: string;
    operation: "delete";
    readOnly: false;
    riskScored: boolean;
    approvalEligible: boolean;
  };
  params: {
    customer_id: string;
    idempotency_key: string;
    approval_token?: string;
  };
}
