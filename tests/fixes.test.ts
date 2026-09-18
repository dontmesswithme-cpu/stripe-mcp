/**
 * Regression tests for the 2026-09 deep-dive bug fixes.
 *
 * Covers:
 * 1. Replay bodies must not contain idempotency_key / approval_token
 *    (Stripe rejects unknown body params; the key is a header only).
 * 2. unknown_outcome retry returns unknown_outcome_pending (not
 *    already_completed) so agents never assume success.
 * 3. Audit end_date date-only inputs include the entire final day.
 * 4. Refund risk context resolves a customerId (PI + charge paths).
 * 5. Sweep excludes purge_expired_customers executions.
 * 6. Stale sweep + unknown_outcome retry interplay.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { rmSync } from "node:fs";

import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";
import {
  createExecution,
  getExecution,
  updateExecutionStatus,
  sweepStaleExecutions,
} from "../src/execution/store.js";
import { executeStripeOperation } from "../src/middleware/execute.js";
import { queryAuditLog, writeAuditEntry } from "../src/audit/log.js";
import { dispatchReplayForTest } from "../src/reconciliation/replay.js";
import { resolveRefundAmountCents } from "../src/utils/stripe-amounts.js";
import { stripe } from "../src/stripe-client.js";
import { WORKER_ID } from "../src/worker/identity.js";

describe("Fix regressions", () => {
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

  // ── Fix 2: replay body param stripping ─────────────────────────────

  it("replay bodies never contain idempotency_key or approval_token", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const capture = vi.fn(async (args: unknown[]) => {
      bodies.push(args[1] as Record<string, unknown>);
      return { id: "re_test" };
    });

    const originalCreate = stripe.refunds.create;
    vi.spyOn(stripe.refunds, "create").mockImplementation(
      (async (_params: unknown, opts: unknown) => {
        return capture([_params, opts]);
      }) as unknown as typeof stripe.refunds.create,
    );

    try {
      await dispatchReplayForTest(
        "create_refund",
        "refund",
        {
          payment_intent: "pi_test123",
          amount: 500,
          // Simulate a legacy row written before the fix:
          idempotency_key: "550e8400-e29b-41d4-a716-446655440abc",
          approval_token: "0d0f66a0-4f24-4b0f-8d7a-111111111111",
        },
        "550e8400-e29b-41d4-a716-446655440abc",
      );

      expect(bodies.length).toBe(1);
      expect(bodies[0]).toBeDefined();
      expect(bodies[0]).not.toHaveProperty("idempotency_key");
      expect(bodies[0]).not.toHaveProperty("approval_token");
    } finally {
      (stripe.refunds.create as unknown as { mockRestore?: () => void }).mockRestore?.();
      void originalCreate;
    }
  });

  it("replay passes the idempotency key as request options, not body", async () => {
    let capturedOpts: unknown = null;
    vi.spyOn(stripe.customers, "create").mockImplementation(
      (async (_params: unknown, opts: unknown) => {
        capturedOpts = opts;
        return { id: "cus_replay" };
      }) as unknown as typeof stripe.customers.create,
    );

    try {
      await dispatchReplayForTest(
        "create_customer",
        "create",
        { email: "replay@example.com", idempotency_key: "legacy-key-in-body" },
        "550e8400-e29b-41d4-a716-446655440def",
      );

      expect(
        (capturedOpts as { idempotencyKey?: string } | null)?.idempotencyKey,
      ).toBe("550e8400-e29b-41d4-a716-446655440def");
    } finally {
      (stripe.customers.create as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  // ── Fix 3: unknown_outcome_pending ─────────────────────────────────

  it("retry after unknown_outcome returns unknown_outcome_pending", async () => {
    const context = {
      capability: {
        tool: "test_tool",
        operation: "create" as const,
        readOnly: false,
        riskScored: false,
        approvalEligible: false,
      },
      params: {
        customer_id: "cus_fix3",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440a30",
      },
    };

    // First attempt times out -> unknown_outcome
    await executeStripeOperation(context, async () => {
      throw Object.assign(new Error("Timeout"), { type: "api_connection_error" });
    });

    // Retry with the same key: must NOT claim already_completed
    const retry = await executeStripeOperation(context, async () => ({ id: "x" }));
    expect(retry.success).toBe(false);
    if (!retry.success) {
      expect(retry.error.code).toBe("unknown_outcome_pending");
    }
  });

  it("retry after completed returns already_completed", async () => {
    const context = {
      capability: {
        tool: "test_tool",
        operation: "create" as const,
        readOnly: false,
        riskScored: false,
        approvalEligible: false,
      },
      params: {
        customer_id: "cus_fix3b",
        idempotency_key: "550e8400-e29b-41d4-a716-446655440a31",
      },
    };

    await executeStripeOperation(context, async () => ({ id: "done" }));

    const retry = await executeStripeOperation(context, async () => ({ id: "again" }));
    expect(retry.success).toBe(false);
    if (!retry.success) {
      expect(retry.error.code).toBe("already_completed");
    }
  });

  // ── Fix 7: audit end_date inclusive of final day ───────────────────

  it("audit end_date date-only input includes the entire final day", async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Write three entries: start-of-day, midday, end-of-day.
    for (const [n, ts] of [
      ["a", `${today}T00:00:01.000Z`],
      ["b", `${today}T12:00:00.000Z`],
      ["c", `${today}T23:59:00.000Z`],
    ] as const) {
      await runDbOp("writeAuditEntry", {
        capability: { tool: `fix7_tool_${n}`, operation: "create", readOnly: false, riskScored: false, approvalEligible: false },
        customerId: undefined,
        params: { idempotency_key: `550e8400-e29b-41d4-a716-446655440f7${n}` },
      }, "success", null, { test: n, ts });
      // Overwrite the timestamp directly since the schema defaults to now.
      await runDbOp(
        "testAuditQuery",
        `UPDATE audit_log SET timestamp = ? WHERE tool_name = ?`,
        ts,
        `fix7_tool_${n}`,
      );
    }

    const entries = await queryAuditLog({
      startDate: today,
      endDate: today,
    });
    const names = entries
      .filter((e) => e.toolName.startsWith("fix7_tool_"))
      .map((e) => e.toolName);
    expect(names).toContain("fix7_tool_a");
    expect(names).toContain("fix7_tool_b");
    expect(names).toContain("fix7_tool_c");
  });

  // ── Fix 1: refund risk context resolves customerId ──────────────────

  it("resolveRefundAmountCents extracts customerId from payment intent", async () => {
    vi.spyOn(stripe.paymentIntents, "retrieve").mockResolvedValue({
      id: "pi_fix1",
      amount: 10_000,
      currency: "usd",
      customer: "cus_fix1",
      latest_charge: null,
    } as unknown as Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>);

    try {
      const resolved = await resolveRefundAmountCents({ payment_intent: "pi_fix1" });
      expect(resolved.customerId).toBe("cus_fix1");
      expect(resolved.amount).toBe(10_000);
    } finally {
      (stripe.paymentIntents.retrieve as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  it("resolveRefundAmountCents extracts customerId from charge", async () => {
    vi.spyOn(stripe.charges, "retrieve").mockResolvedValue({
      id: "ch_fix1",
      amount: 2_000,
      amount_refunded: 500,
      currency: "usd",
      customer: "cus_fix1_charge",
    } as unknown as Awaited<ReturnType<typeof stripe.charges.retrieve>>);

    try {
      const resolved = await resolveRefundAmountCents({ charge: "ch_fix1" });
      expect(resolved.customerId).toBe("cus_fix1_charge");
      // Prior refunds subtracted, not the raw charge amount.
      expect(resolved.amount).toBe(1_500);
    } finally {
      (stripe.charges.retrieve as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  it("PI refund amount subtracts prior refunds via latest_charge", async () => {
    vi.spyOn(stripe.paymentIntents, "retrieve").mockResolvedValue({
      id: "pi_fix1b",
      amount: 10_000,
      currency: "usd",
      customer: "cus_fix1b",
      latest_charge: {
        id: "ch_fix1b",
        amount: 10_000,
        amount_refunded: 4_000,
        currency: "usd",
        customer: "cus_fix1b",
      },
    } as unknown as Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>);

    try {
      const resolved = await resolveRefundAmountCents({ payment_intent: "pi_fix1b" });
      expect(resolved.amount).toBe(6_000);
      expect(resolved.customerId).toBe("cus_fix1b");
    } finally {
      (stripe.paymentIntents.retrieve as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  // ── Fix 8: sweep excludes purge executions ─────────────────────────

  it("stale sweep never flips purge executions to unknown_outcome", async () => {
    const exec = await createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440a80",
      WORKER_ID,
      { tool: "purge_expired_customers", operation: "purge", params: {} },
    );

    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await runDbOp(
      "testQuery",
      `UPDATE executions SET started_at = ? WHERE execution_id = ?`,
      stale,
      exec.executionId,
    );

    await sweepStaleExecutions();

    const read = await getExecution(exec.executionId);
    expect(read?.status).toBe("executing"); // untouched
  });

  it("stale sweep still flips normal stale executions", async () => {
    const exec = await createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440a81",
      WORKER_ID,
      { tool: "delete_customer", operation: "delete", params: {} },
    );

    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    await runDbOp(
      "testQuery",
      `UPDATE executions SET started_at = ? WHERE execution_id = ?`,
      stale,
      exec.executionId,
    );

    await sweepStaleExecutions();

    const read = await getExecution(exec.executionId);
    expect(read?.status).toBe("unknown_outcome");
  });

  // ── Fix 10: prune keeps live rows, removes terminal ones ────────────

  it("prune removes terminal executions but keeps unknown_outcome", async () => {
    const keep = await createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440a10",
      WORKER_ID,
      { tool: "test_tool", operation: "delete", params: {} },
    );
    await updateExecutionStatus(keep.executionId, "unknown_outcome");

    const remove = await createExecution(
      null,
      "hash",
      "550e8400-e29b-41d4-a716-446655440a11",
      WORKER_ID,
      { tool: "test_tool", operation: "delete", params: {} },
    );
    await updateExecutionStatus(remove.executionId, "completed", { stripeObjectId: "x" });
    // Age it past the retention window.
    await runDbOp(
      "testQuery",
      `UPDATE executions SET completed_at = ? WHERE execution_id = ?`,
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
      remove.executionId,
    );

    await runDbOp("pruneAuditLog");

    const keptRead = await getExecution(keep.executionId);
    expect(keptRead?.status).toBe("unknown_outcome"); // preserved

    const removedRead = await getExecution(remove.executionId);
    expect(removedRead).toBeNull(); // pruned
  });
});
