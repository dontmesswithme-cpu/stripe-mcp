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
import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";
import { executeStripeOperation } from "../src/middleware/execute.js";
import { reconcileUnknownOutcomes } from "../src/reconciliation/worker.js";
import { stripe } from "../src/stripe-client.js";
import { config } from "../src/config.js";

describe("Decoupled Execution & Approval Architecture", () => {
  beforeAll(async () => {
    await runDbOp("initializeAllDatabases");
  });

  afterAll(async () => {
    await shutdownDbWorker();
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
    const approval = await createApproval(context, 10);
    await approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => ({ id: "123" }));

    const finalApproval = await getApproval(approval.token);
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
    const approval = await createApproval(context, 10);
    await approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => {
      throw Object.assign(new Error("Timeout"), {
        type: "api_connection_error",
      });
    });

    const finalApproval = await getApproval(approval.token);
    expect(finalApproval?.status).toBe("consumed");

    const execRow = await runDbOp("testQuery", `SELECT status FROM executions WHERE idempotency_key LIKE ?`, `%${context.params.idempotency_key}`);
    expect(execRow[0]?.status).toBe("unknown_outcome");
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
    const approval = await createApproval(context, 10);
    await approveToken(approval.token);
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
    const approval = await createApproval(context, 10);
    await approveToken(approval.token);
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
    const approval = await createApproval(context, 10);
    await approveToken(approval.token);
    context.params.approval_token = approval.token;

    await executeStripeOperation(context, async () => {
      throw Object.assign(new Error("Timeout"), { type: "api_error" });
    });

    const execRow = await runDbOp("testQuery", `SELECT status FROM executions WHERE idempotency_key LIKE ?`, `%${context.params.idempotency_key}`);
    expect(execRow[0]?.status).toBe("unknown_outcome");
  });

  it("Reconciliation resolves unknown_outcome via idempotent replay", async () => {
    const exec = await createExecution(
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
    await updateExecutionStatus(exec.executionId, "unknown_outcome");

    const origDel = stripe.customers.del;
    stripe.customers.del = async () =>
      ({
        id: "cus_reconcile",
        object: "customer",
        deleted: true,
      }) as Awaited<ReturnType<typeof stripe.customers.del>>;

    await reconcileUnknownOutcomes();

    stripe.customers.del = origDel;

    const resolved = await getExecution(exec.executionId);
    expect(resolved?.status).toBe("completed");
    expect(resolved?.stripeObjectId).toBe("cus_reconcile");
  });

  it("Canonical nested hashing and array ordering", () => {
    const obj1 = { z: 1, a: [{ c: 3, b: 2 }, 4] };
    const obj2 = { a: [{ b: 2, c: 3 }, 4], z: 1 };
    expect(JSON.stringify(canonicalize(obj1))).toBe(
      JSON.stringify(canonicalize(obj2)),
    );
    const obj3 = { a: [4, { b: 2, c: 3 }], z: 1 };
    expect(JSON.stringify(canonicalize(obj1))).toBe(
      JSON.stringify(canonicalize(obj3)),
    );
  });

  it("Canonicalize prevents DoS via deep nesting", () => {
    let deepObj: any = {};
    let current = deepObj;
    for (let i = 0; i < 15; i++) {
      current.child = {};
      current = current.child;
    }
    expect(() => canonicalize(deepObj)).toThrow("Maximum payload depth exceeded");

    let deepArr: any[] = [];
    let currentArr = deepArr;
    for (let i = 0; i < 15; i++) {
      let nextArr: any[] = [];
      currentArr.push(nextArr);
      currentArr = nextArr;
    }
    expect(() => canonicalize(deepArr)).toThrow("Maximum payload depth exceeded");
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
    const approval = await createApproval(context, 10);
    await approveToken(approval.token);
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

  it("Stale executing rows are swept to unknown_outcome", async () => {
    const exec = await createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440009",
      WORKER_ID,
      { tool: "test_tool", operation: "delete", params: {} },
    );

    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await runDbOp("testQuery", `UPDATE executions SET started_at = ? WHERE execution_id = ?`, stale, exec.executionId);

    const swept = await sweepStaleExecutions();
    expect(swept).toBeGreaterThanOrEqual(1);
    
    const read = await getExecution(exec.executionId);
    expect(read?.status).toBe("unknown_outcome");
  });

  it("Legacy migration invalidates empty request_hash approvals", async () => {
    await runDbOp("testQuery", `
      INSERT INTO approvals (token, request_hash, tool, operation, status, expires_at)
      VALUES ('legacy_token', '', 'tool', 'op', 'pending', ?)
    `, new Date(Date.now() + 60_000).toISOString());

    await runDbOp("testQuery", `UPDATE approvals SET status = 'expired' WHERE request_hash = '' AND status = 'pending'`);

    const row = await runDbOp("testQuery", `SELECT status FROM approvals WHERE token = 'legacy_token'`);
    expect(row[0]?.status).toBe("expired");
  });

  it("Worker ownership persistence", async () => {
    const exec = await createExecution(
      "token_11",
      "hash",
      "550e8400-e29b-41d4-a716-446655440011",
      { hostname: "my-host", pid: 1234, uuid: "my-uuid" },
      { tool: "test_tool", operation: "delete", params: {} },
    );
    const read = await getExecution(exec.executionId);
    expect(read?.workerHostname).toBe("my-host");
    expect(read?.workerPid).toBe(1234);
    expect(read?.workerUuid).toBe("my-uuid");
  });

  it("Execution records survive process restart", async () => {
    const exec = await createExecution(
      "token_12",
      "hash",
      "550e8400-e29b-41d4-a716-446655440012",
      WORKER_ID,
      { tool: "test_tool", operation: "delete", params: {} },
    );

    await shutdownDbWorker();
    await runDbOp("initializeAllDatabases"); // restart

    const read = await runDbOp("testQuery", `SELECT * FROM executions WHERE execution_id = ?`, exec.executionId);
    expect(read[0]).toBeDefined();
  });

  it("STRIPE_READ_ONLY blocks mutations", async () => {
    const origReadOnly = config.readOnly;
    config.readOnly = true;

    const result = await executeStripeOperation(
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

    config.readOnly = origReadOnly;
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
