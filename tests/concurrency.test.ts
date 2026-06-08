import { test, expect, beforeAll, afterAll } from "vitest";
import { runDbOp, shutdownDbWorker } from "../src/worker/db/db.client.js";
import { createApproval, approveToken, consumeApproval } from "../src/approval/store.js";

beforeAll(async () => {
  await runDbOp("initializeAllDatabases");
});

afterAll(async () => {
  await shutdownDbWorker();
});

test("Concurrency Stress Test: 50 simultaneous requests to consume the same token", async () => {
  // 1. Create and approve a token
  const context = {
    capability: { tool: "createCustomer", operation: "create" },
    params: { email: "test@example.com", idempotency_key: "idem_123" },
  } as any;
  
  const approval = await createApproval(context, 100);
  await approveToken(approval.token, "admin");

  // 2. Fire 50 simultaneous consume requests
  const promises = [];
  for (let i = 0; i < 50; i++) {
    // Push promises that execute immediately to try and hit DB concurrently
    promises.push(
      new Promise((resolve) => {
        setImmediate(async () => {
          resolve(await consumeApproval(approval.token, approval.requestHash));
        });
      })
    );
  }

  const results = await Promise.all(promises);

  // 3. Verify exactly 1 returns ok: true
  const successes = results.filter((r: any) => r.ok === true);
  const failures = results.filter((r: any) => r.ok === false && r.reason === "already_consumed");

  expect(successes.length).toBe(1);
  expect(failures.length).toBe(49);
});
